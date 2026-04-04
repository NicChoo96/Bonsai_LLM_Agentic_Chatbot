import { NextRequest, NextResponse } from 'next/server';
import {
  registerProvider,
  filesystemProvider,
  chromeDevToolsProvider,
  webFetchProvider,
  systemProvider,
  documentProvider,
  getAllTools,
} from '@/lib/mcp';
import { buildToolSystemPrompt, runChatWithTools } from '@/lib/tool-processor';
import { readSandboxFile, ensureSandbox, listSandboxFiles } from '@/lib/sandbox';
import { sendChatCompletion, type CompletionMessage } from '@/lib/ai-client';

// Register all MCP providers
registerProvider(filesystemProvider);
registerProvider(chromeDevToolsProvider);
registerProvider(webFetchProvider);
registerProvider(systemProvider);
registerProvider(documentProvider);

// ─── Phase types ─────────────────────────────────────────────────
// Phase 1: understand  – parse user prompt, return understanding
// Phase 2: gather      – collect tools + skills relevant to the task
// Phase 3: plan        – produce a plan AND validate/review it in one stage
// Phase 4: execute     – run the plan steps with error-recovery retries

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      phase,
      userPrompt,
      messages: userMessages,
      selectedFiles,
      skills,
      plan,
      understanding,
      gathered,
    } = body as {
      phase: 'understand' | 'gather' | 'plan' | 'execute';
      userPrompt: string;
      messages: { role: string; content: string }[];
      selectedFiles: string[];
      skills: { name: string; content: string }[];
      plan: { steps: string[]; toolPlan: string };
      understanding: any;
      gathered: any;
    };

    await ensureSandbox();

    // ── Shared context ───────────────────────────────────────
    const sandboxFiles = await listSandboxFiles('');
    const fileList = sandboxFiles.map((f) => (f.isDirectory ? `${f.path}/` : f.path)).join(', ');

    let bootstrapContext = '';
    if (selectedFiles?.length) {
      const fileContents: string[] = [];
      for (const filePath of selectedFiles) {
        try {
          const content = await readSandboxFile(filePath);
          fileContents.push(`--- File: ${filePath} ---\n${content}`);
        } catch {
          fileContents.push(`--- File: ${filePath} --- (could not read)`);
        }
      }
      bootstrapContext = fileContents.join('\n\n');
    }

    // ════════════════════════════════════════════════════════════
    // PHASE 1: UNDERSTAND  (with 1 self-review round = 2 total)
    // ════════════════════════════════════════════════════════════
    if (phase === 'understand') {
      // ── Collect tool & skill summaries for the model to reason about ──
      const allTools = getAllTools();
      const toolSummary = allTools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
      const skillSummary = (skills || []).length > 0
        ? (skills || []).map((s) => `- ${s.name}: ${s.content.slice(0, 120)}`).join('\n')
        : '(none available)';

      // ── Round 1: Initial deep analysis ─────────────────────
      const initialSystemContent = [
        'You are an AI planning assistant performing deep analysis.',
        'Think BEYOND what the user literally wrote. Consider:',
        '  - What is the user REALLY trying to achieve? What is the deeper goal?',
        '  - What implicit requirements might they not have mentioned?',
        '  - What edge cases, pitfalls, or gotchas should be considered?',
        '  - What assumptions are being made?',
        '  - Are there better approaches than what the user described?',
        '  - Do any of the available TOOLS actually help here? Many tasks are best handled with a direct text response and NO tools at all.',
        '  - Do any SKILLS contain relevant instructions? If none are relevant, do NOT suggest any.',
        '',
        'IMPORTANT: Not every request needs tools or skills. If the user is asking a question, wants an explanation,',
        'needs creative writing, code review, brainstorming, or any purely conversational/intellectual task,',
        'then suggested_tools and suggested_skills should be EMPTY arrays. Only suggest tools/skills when they',
        'are genuinely needed to accomplish the task (e.g. file operations, web fetching, system commands).',
        'A raw AI response with no tool usage is perfectly valid and often preferred.',
        '',
        'Produce a thorough analysis as a JSON object:',
        '  "summary": 2-3 sentence summary including the deeper goal',
        '  "requirements": array of ALL requirements (explicit AND implicit)',
        '  "context_needed": array of context/information needed',
        '  "assumptions": array of assumptions you are making',
        '  "risks": array of potential pitfalls or edge cases',
        '  "alternative_approaches": array of other ways this could be done (if any)',
        '  "suggested_tools": array of tool names ONLY if genuinely needed (empty array [] if not)',
        '  "suggested_skills": array of skill names ONLY if relevant (empty array [] if not)',
        '  "tool_skill_reasoning": explain why tools/skills are or are NOT needed for this task',
        '',
        'Respond ONLY with valid JSON. No markdown, no explanation.',
        '',
        `Available tools:\n${toolSummary}`,
        '',
        `Available skills:\n${skillSummary}`,
        '',
        `Sandbox files: [${fileList}]`,
        bootstrapContext ? `\nSelected file contents:\n${bootstrapContext}` : '',
      ].filter(Boolean).join('\n');

      const round1Messages: CompletionMessage[] = [
        { role: 'system', content: initialSystemContent },
        { role: 'user', content: userPrompt },
      ];

      const r1 = await sendChatCompletion(round1Messages);
      const r1Raw = r1.choices[0]?.message?.content ?? '{}';

      // Capture round-by-round thinking
      const reviewRounds: { round: number; prompt: string; analysis: string; review_notes: string }[] = [];

      // Record round 1
      let r1Parsed: any;
      try { r1Parsed = JSON.parse(r1Raw); } catch { r1Parsed = { summary: r1Raw }; }
      reviewRounds.push({ round: 1, prompt: userPrompt, analysis: r1Raw, review_notes: 'Initial analysis' });

      // ── Round 2: Self-review ────────────────────────────────
      const reviewSystemContent = [
        'You are an AI self-review assistant. You are reviewing your OWN previous analysis of a user request.',
        'Critique and IMPROVE:',
        '  - Missing/wrong/unnecessary requirements?',
        '  - Summary accurate? Assumptions valid? Edge cases missed?',
        '  - Are suggested_tools actually necessary? REMOVE any that are not essential. An empty tools list is valid and preferred when no tools are needed.',
        '  - Are suggested_skills actually relevant? REMOVE any that are not truly applicable. Empty is fine.',
        '  - Could this task be handled with a plain AI response instead of tool calls? If so, clear the tool/skill suggestions.',
        '',
        'Produce an IMPROVED version as the same JSON object with all original fields.',
        'Add "review_notes": short string describing changes.',
        'Respond ONLY with valid JSON.',
      ].join('\n');

      let latestAnalysis = r1Raw;

      {
        const round = 2;
        const reviewMessages: CompletionMessage[] = [
          { role: 'system', content: reviewSystemContent },
          {
            role: 'user',
            content: [
              `Original user request: "${userPrompt}"`,
              '',
              `Previous analysis (round 1):\n${latestAnalysis}`,
              '',
              `This is the final review round. Carefully review and improve the analysis above.`,
            ].join('\n'),
          },
        ];

        const reviewUserContent = reviewMessages[1].content;
        const rN = await sendChatCompletion(reviewMessages);
        const rNRaw = rN.choices[0]?.message?.content ?? latestAnalysis;
        latestAnalysis = rNRaw;

        // Capture this round
        let rNParsed: any;
        try { rNParsed = JSON.parse(rNRaw); } catch { rNParsed = { summary: rNRaw }; }
        reviewRounds.push({
          round,
          prompt: reviewUserContent,
          analysis: rNRaw,
          review_notes: rNParsed.review_notes || `Review round ${round}`,
        });
      }

      // ── Parse the final reviewed analysis ──────────────────
      let understanding;
      try {
        understanding = JSON.parse(latestAnalysis);
      } catch {
        understanding = {
          summary: latestAnalysis,
          requirements: [latestAnalysis],
          context_needed: [],
          assumptions: [],
          risks: [],
          alternative_approaches: [],
          suggested_tools: [],
          suggested_skills: [],
          tool_skill_reasoning: '',
          review_notes: 'Could not parse structured output',
        };
      }

      // Strip internal-only fields before returning
      const { review_notes, ...publicUnderstanding } = understanding;

      return NextResponse.json({
        phase: 'understand',
        understanding: publicUnderstanding,
        reviewRounds,
      });
    }

    // ════════════════════════════════════════════════════════════
    // PHASE 2: GATHER TOOLS & SKILLS (sub-agent evaluation)
    // ════════════════════════════════════════════════════════════
    if (phase === 'gather') {
      const allTools = getAllTools();
      const toolList = allTools.map((t) => ({
        name: t.name,
        description: t.description,
        provider: (t as any).provider,
        parameters: Object.keys(t.parameters.properties),
        paramDetails: Object.entries(t.parameters.properties)
          .map(([k, v]) => `${k} (${v.type}): ${v.description}`)
          .join('; '),
      }));

      // Skills are passed in from the client (already fetched)
      const skillList = (skills || []).map((s) => ({
        name: s.name,
        content: s.content,
      }));

      // Phase 1 context
      const phase1Tools = understanding?.suggested_tools || [];
      const phase1Skills = understanding?.suggested_skills || [];
      const phase1Reasoning = understanding?.tool_skill_reasoning || '';

      // ── Sub-agent: evaluate each tool against the task ──────
      // Batch tools into groups to keep per-call token usage small
      const BATCH_SIZE = 6;
      const toolBatches: typeof toolList[] = [];
      for (let i = 0; i < toolList.length; i += BATCH_SIZE) {
        toolBatches.push(toolList.slice(i, i + BATCH_SIZE));
      }

      const gatherRounds: { round: number; prompt: string; analysis: string; review_notes: string }[] = [];
      const approvedTools: string[] = [];
      const toolEvaluations: { name: string; relevant: boolean; reason: string }[] = [];

      for (let batchIdx = 0; batchIdx < toolBatches.length; batchIdx++) {
        const batch = toolBatches[batchIdx];
        const batchDocs = batch.map((t) =>
          `TOOL: ${t.name}\n  Provider: ${t.provider}\n  Description: ${t.description}\n  Parameters: ${t.paramDetails}`
        ).join('\n\n');

        const evalSystem = [
          'You are a tool evaluation sub-agent. Your ONLY job is to decide whether each tool below is USEFUL for the given task.',
          '',
          'CRITICAL RULES:',
          '- You are evaluating tools that ACTUALLY EXIST and WORK in this system. They are real, functional tools.',
          '- These tools CAN access the user\'s file system, run commands, fetch web pages, etc. They are NOT hypothetical.',
          '- Judge each tool based SOLELY on whether the task requires the capability that tool provides.',
          '- If the task involves finding files → file search tools are relevant.',
          '- If the task involves running programs → command execution tools are relevant.',
          '- If the task involves reading/writing files → file I/O tools are relevant.',
          '- If the task is purely conversational (greetings, jokes, opinions, general knowledge) → no tools needed.',
          '',
          'For EACH tool, respond with a JSON array of objects:',
          '  [{"name": "tool_name", "relevant": true/false, "reason": "brief reason"}]',
          '',
          'Respond ONLY with the JSON array. No other text.',
        ].join('\n');

        const evalUser = [
          `USER TASK: "${userPrompt}"`,
          '',
          phase1Reasoning ? `Phase 1 analysis said: "${phase1Reasoning}"` : '',
          phase1Tools.length > 0 ? `Phase 1 suggested these tools: ${phase1Tools.join(', ')}` : '',
          '',
          `TOOLS TO EVALUATE:\n\n${batchDocs}`,
        ].filter(Boolean).join('\n');

        const evalMessages: CompletionMessage[] = [
          { role: 'system', content: evalSystem },
          { role: 'user', content: evalUser },
        ];

        const evalResponse = await sendChatCompletion(evalMessages);
        const evalRaw = evalResponse.choices[0]?.message?.content ?? '[]';

        gatherRounds.push({
          round: batchIdx + 1,
          prompt: evalUser,
          analysis: evalRaw,
          review_notes: `Tool evaluation batch ${batchIdx + 1}/${toolBatches.length}`,
        });

        // Parse evaluations
        try {
          const parsed = JSON.parse(evalRaw);
          if (Array.isArray(parsed)) {
            for (const ev of parsed) {
              toolEvaluations.push({
                name: ev.name,
                relevant: !!ev.relevant,
                reason: ev.reason || '',
              });
              if (ev.relevant) {
                approvedTools.push(ev.name);
              }
            }
          }
        } catch {
          // If batch parse fails, fall back to approving Phase 1 suggestions from this batch
          for (const t of batch) {
            if (phase1Tools.includes(t.name)) {
              approvedTools.push(t.name);
              toolEvaluations.push({ name: t.name, relevant: true, reason: 'Phase 1 suggested (batch parse failed)' });
            } else {
              toolEvaluations.push({ name: t.name, relevant: false, reason: 'Not evaluated (batch parse failed)' });
            }
          }
        }
      }

      // ── Evaluate skills (single call if any exist) ──────────
      const approvedSkills: string[] = [];
      if (skillList.length > 0) {
        const skillDocs = skillList.map((s) =>
          `SKILL: ${s.name}\n  Content: ${s.content.slice(0, 200)}`
        ).join('\n\n');

        const skillEvalSystem = [
          'You are a skill evaluation sub-agent. Decide whether each skill below is RELEVANT to the user\'s task.',
          'Only select skills that contain specific instructions or knowledge that directly help with the task.',
          'Respond with a JSON array: [{"name": "skill_name", "relevant": true/false, "reason": "brief reason"}]',
          'Respond ONLY with the JSON array.',
        ].join('\n');

        const skillEvalUser = `USER TASK: "${userPrompt}"\n\nSKILLS TO EVALUATE:\n\n${skillDocs}`;
        const skillResponse = await sendChatCompletion([
          { role: 'system', content: skillEvalSystem },
          { role: 'user', content: skillEvalUser },
        ]);
        const skillRaw = skillResponse.choices[0]?.message?.content ?? '[]';

        gatherRounds.push({
          round: toolBatches.length + 1,
          prompt: skillEvalUser,
          analysis: skillRaw,
          review_notes: 'Skill evaluation',
        });

        try {
          const parsed = JSON.parse(skillRaw);
          if (Array.isArray(parsed)) {
            for (const ev of parsed) {
              if (ev.relevant) approvedSkills.push(ev.name);
            }
          }
        } catch {
          // If skill parse fails, approve Phase 1 suggestions
          for (const s of skillList) {
            if (phase1Skills.includes(s.name)) approvedSkills.push(s.name);
          }
        }
      }

      // Deduplicate
      const selectedTools = [...new Set(approvedTools)];
      const selectedSkills = [...new Set(approvedSkills)];

      // Build reasoning summary
      const reasoningSummary = toolEvaluations
        .filter(e => e.relevant)
        .map(e => `${e.name}: ${e.reason}`)
        .join('; ') || 'No tools needed for this task.';

      const gathered = {
        selected_tools: selectedTools,
        selected_skills: selectedSkills,
        reasoning: reasoningSummary,
        evaluations: toolEvaluations,
      };

      return NextResponse.json({
        phase: 'gather',
        gathered,
        allTools: toolList.map(({ paramDetails, ...rest }) => rest),
        allSkills: skillList,
        reviewRounds: gatherRounds,
      });
    }

    // ════════════════════════════════════════════════════════════
    // PHASE 3: PLAN + REVIEW (combined — 2 rounds total)
    // ════════════════════════════════════════════════════════════
    if (phase === 'plan') {
      const allTools = getAllTools();
      const toolDocs = allTools.map((t) => {
        const params = Object.entries(t.parameters.properties)
          .map(([k, v]) => `${k}: ${v.description}`)
          .join(', ');
        return `- ${t.name}: ${t.description} [params: ${params}]`;
      }).join('\n');

      const toolNames = allTools.map((t) => t.name).join(', ');
      const skillDocs = (skills || []).map((s) => `- ${s.name}: ${s.content.slice(0, 200)}`).join('\n');

      // ── Round 1: Create plan ───────────────────────────────
      const systemContent = [
        'You are an AI planning assistant. Create a step-by-step execution plan.',
        '',
        'IMPORTANT: Not every task needs tools. If the request can be fully answered with a direct text response',
        '(questions, explanations, code review, brainstorming, creative writing, etc.), create a single step',
        'with tool: "none" that describes generating the response. Do NOT force tool usage where it is not needed.',
        'Only include tool-based steps when concrete side-effects are required (file operations, web fetches, etc.).',
        '',
        'Each step must be a concrete, actionable instruction.',
        '',
        'Respond ONLY with valid JSON:',
        '  "steps": an ordered array of step objects, each with:',
        '    "step": step number (1, 2, 3...)',
        '    "action": what to do in plain English',
        '    "tool": the tool name to call (or "none" for direct AI response steps)',
        '    "args": predicted arguments object for the tool call (or null)',
        '    "depends_on": array of step numbers this depends on (or [])',
        '  "summary": a one-line summary of the full plan',
        '',
        `Available tools:\n${toolDocs}`,
        skillDocs ? `\nAvailable skills:\n${skillDocs}` : '',
        `\nSandbox files: [${fileList}]`,
        bootstrapContext ? `\nFile contents:\n${bootstrapContext}` : '',
      ].filter(Boolean).join('\n');

      const completionMessages: CompletionMessage[] = [
        { role: 'system', content: systemContent },
        { role: 'user', content: userPrompt },
      ];

      const response = await sendChatCompletion(completionMessages);
      const raw = response.choices[0]?.message?.content ?? '{}';

      const planRounds: { round: number; prompt: string; analysis: string; review_notes: string }[] = [];
      planRounds.push({ round: 1, prompt: userPrompt, analysis: raw, review_notes: 'Initial plan' });

      // ── Round 2: Review + validate + correct the plan ──────
      const planReviewSystem = [
        'You are an AI assistant that REVIEWS and VALIDATES an execution plan.',
        'You must do TWO things in one pass:',
        '  1. IMPROVE the plan: fix ordering, dependencies, missing/redundant steps, tool choices, argument accuracy.',
        '  2. VALIDATE the plan: verify it fully addresses the user\'s original request end-to-end.',
        '',
        'Respond ONLY with valid JSON:',
        '  "steps": the improved/corrected array of { step, action, tool, args, depends_on }',
        '  "summary": one-line summary of the plan',
        '  "review_notes": what was changed or validated',
        '  "verdict": "pass" | "needs_correction" (whether the plan needed corrections)',
        '  "issues": array of issues found (empty if none)',
        '  "confidence": 0-100 confidence that this plan will succeed',
        '',
        `Available tool names: ${toolNames}`,
      ].join('\n');

      let latestPlan = raw;
      {
        const reviewMessages: CompletionMessage[] = [
          { role: 'system', content: planReviewSystem },
          {
            role: 'user',
            content: [
              `Original user request: "${userPrompt}"`,
              '',
              `Plan to review and improve:\n${latestPlan}`,
              '',
              'Review, validate, and improve this plan. Fix any issues.',
            ].join('\n'),
          },
        ];
        const planUserContent = reviewMessages[1].content;
        const rN = await sendChatCompletion(reviewMessages);
        const rNRaw = rN.choices[0]?.message?.content ?? latestPlan;
        latestPlan = rNRaw;

        let rNParsed: any;
        try { rNParsed = JSON.parse(rNRaw); } catch { rNParsed = {}; }
        planRounds.push({
          round: 2,
          prompt: planUserContent,
          analysis: rNRaw,
          review_notes: rNParsed.review_notes || 'Plan review & validation',
        });
      }

      // Parse final plan (which includes review data)
      let planData: any;
      try {
        planData = JSON.parse(latestPlan);
      } catch {
        planData = {
          steps: [{ step: 1, action: latestPlan, tool: 'none', args: null, depends_on: [] }],
          summary: 'Could not parse structured plan',
          verdict: 'pass',
          issues: [],
          confidence: 50,
        };
      }

      // Extract review info from the combined output
      const review = {
        verdict: planData.verdict || 'pass',
        issues: planData.issues || [],
        corrected_plan: planData.verdict === 'needs_correction' ? { steps: planData.steps, summary: planData.summary } : null,
        reasoning: planData.review_notes || '',
        confidence: planData.confidence ?? 75,
      };

      // Clean up plan data (remove review-only fields)
      const { review_notes: _prn, verdict: _v, issues: _iss, confidence: _conf, ...publicPlan } = planData;

      return NextResponse.json({
        phase: 'plan',
        plan: publicPlan,
        review,
        reviewRounds: planRounds,
      });
    }

    // ════════════════════════════════════════════════════════════
    // PHASE 4: EXECUTE (with error-recovery retries)
    // ════════════════════════════════════════════════════════════
    if (phase === 'execute') {
      const { skipTools } = body as { skipTools?: boolean };

      // ── Direct response mode (no tools needed) ────────────
      if (skipTools || !plan?.steps?.length) {
        const skillContext = (skills || []).length > 0
          ? `\n\nYou may reference these skills if relevant:\n${skills.map((s) => `[Skill: ${s.name}]\n${s.content.slice(0, 200)}`).join('\n---\n')}`
          : '';

        const systemContent = [
          'You are a helpful AI assistant. Respond directly and thoroughly to the user\'s request.',
          'No tools are needed for this task — provide a comprehensive text response.',
          '',
          `Sandbox files available: [${fileList}]`,
          skillContext,
          bootstrapContext
            ? `\nThe user has selected the following files as context:\n\n${bootstrapContext}`
            : '',
        ].filter(Boolean).join('\n');

        const completionMessages: CompletionMessage[] = [
          { role: 'system', content: systemContent },
          ...(userMessages || []).map((m) => ({ role: m.role, content: m.content })),
        ];

        const response = await sendChatCompletion(completionMessages);
        const reply = response.choices[0]?.message?.content ?? '';

        return NextResponse.json({ phase: 'execute', reply, toolCalls: [] });
      }

      // ── Tool-based execution ───────────────────────────────
      // Build selective tool docs: only include tools referenced in the plan
      const planToolNames = new Set<string>();
      if (plan?.steps?.length) {
        for (const s of plan.steps as any[]) {
          if (s.tool && s.tool !== 'none') planToolNames.add(s.tool);
        }
      }
      // Always include a few core tools for fallback
      ['sandbox_list_files', 'sandbox_read_file', 'search_files'].forEach((t) => planToolNames.add(t));
      const toolPrompt = buildToolSystemPrompt(planToolNames);

      const skillContext = (skills || []).length > 0
        ? `\n\nLoaded Skills:\n${skills.map((s) => `[Skill: ${s.name}]\n${s.content}`).join('\n---\n')}`
        : '';

      const planContext = plan?.steps?.length
        ? `\n\nYou MUST follow this execution plan step by step:\n${plan.steps.map((s: any) => `${s.step}. ${s.action}${s.tool !== 'none' ? ` [use tool: ${s.tool}]` : ''}`).join('\n')}`
        : '';

      const systemContent = [
        'You are a helpful AI assistant with access to a sandboxed workspace and developer tools.',
        'Use tool calls when you need to perform concrete actions (read/write files, fetch web pages, run commands, etc.).',
        'If the task can be answered directly without any tool usage, just respond normally — a plain text answer is perfectly fine.',
        'Do NOT force tool usage when it is not needed. Only call tools when they genuinely help accomplish the task.',
        '',
        `The sandbox workspace currently contains these files: [${fileList}]`,
        '',
        toolPrompt,
        planContext,
        skillContext,
        '',
        bootstrapContext
          ? `The user has selected the following files as context:\n\n${bootstrapContext}`
          : '',
      ].filter(Boolean).join('\n');

      const completionMessages: CompletionMessage[] = [
        { role: 'system', content: systemContent },
        ...(userMessages || []).map((m) => ({ role: m.role, content: m.content })),
      ];

      const { reply, toolCalls } = await runChatWithTools(completionMessages);

      return NextResponse.json({ phase: 'execute', reply, toolCalls });
    }

    return NextResponse.json({ error: 'Invalid phase' }, { status: 400 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
