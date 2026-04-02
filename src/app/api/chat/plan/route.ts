import { NextRequest, NextResponse } from 'next/server';
import {
  registerProvider,
  filesystemProvider,
  chromeDevToolsProvider,
  webFetchProvider,
  systemProvider,
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

// ─── Phase types ─────────────────────────────────────────────────
// Phase 1: understand  – parse user prompt, return understanding
// Phase 2: gather      – collect tools + skills relevant to the task
// Phase 3: plan        – produce a numbered step-by-step plan
// Phase 4: review      – validate the plan against the original prompt
// Phase 5: execute     – run the plan steps sequentially

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
      phase: 'understand' | 'gather' | 'plan' | 'review' | 'execute';
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
    // PHASE 1: UNDERSTAND  (with 4 self-review rounds)
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
        '  - Which of the available TOOLS could help accomplish this task?',
        '  - Which of the available SKILLS contain relevant instructions or patterns?',
        '  - Should a NEW skill be created to capture this workflow for reuse?',
        '  - Should a NEW tool be suggested if none of the existing ones fit?',
        '',
        'Produce a thorough analysis as a JSON object:',
        '  "summary": 2-3 sentence summary including the deeper goal',
        '  "requirements": array of ALL requirements (explicit AND implicit)',
        '  "context_needed": array of context/information needed',
        '  "assumptions": array of assumptions you are making',
        '  "risks": array of potential pitfalls or edge cases',
        '  "alternative_approaches": array of other ways this could be done (if any)',
        '  "suggested_tools": array of tool names from the available list that look useful for this task',
        '  "suggested_skills": array of skill names that are relevant, or descriptions of NEW skills that should be created',
        '  "tool_skill_reasoning": a brief explanation of WHY these tools/skills were chosen and if anything is missing',
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
      const reviewRounds: { round: number; analysis: string; review_notes: string }[] = [];

      // Record round 1
      let r1Parsed: any;
      try { r1Parsed = JSON.parse(r1Raw); } catch { r1Parsed = { summary: r1Raw }; }
      reviewRounds.push({ round: 1, analysis: r1Raw, review_notes: 'Initial analysis' });

      // ── Rounds 2-4: Self-review loop ───────────────────────
      const reviewSystemContent = [
        'You are an AI self-review assistant. You are reviewing your OWN previous analysis of a user request.',
        'Critique and IMPROVE:',
        '  - Missing/wrong/unnecessary requirements?',
        '  - Summary accurate? Assumptions valid? Edge cases missed?',
        '  - Are suggested_tools the best fit? Any missing or unnecessary?',
        '  - Are suggested_skills relevant? Should new ones be created?',
        '',
        'Produce an IMPROVED version as the same JSON object with all original fields.',
        'Add "review_notes": short string describing changes.',
        'Respond ONLY with valid JSON.',
      ].join('\n');

      let latestAnalysis = r1Raw;

      for (let round = 2; round <= 4; round++) {
        const reviewMessages: CompletionMessage[] = [
          { role: 'system', content: reviewSystemContent },
          {
            role: 'user',
            content: [
              `Original user request: "${userPrompt}"`,
              '',
              `Previous analysis (round ${round - 1}):\n${latestAnalysis}`,
              '',
              `This is review round ${round} of 4. Carefully review and improve the analysis above.`,
            ].join('\n'),
          },
        ];

        const rN = await sendChatCompletion(reviewMessages);
        const rNRaw = rN.choices[0]?.message?.content ?? latestAnalysis;
        latestAnalysis = rNRaw;

        // Capture this round
        let rNParsed: any;
        try { rNParsed = JSON.parse(rNRaw); } catch { rNParsed = { summary: rNRaw }; }
        reviewRounds.push({
          round,
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
    // PHASE 2: GATHER TOOLS & SKILLS
    // ════════════════════════════════════════════════════════════
    if (phase === 'gather') {
      const allTools = getAllTools();
      const toolList = allTools.map((t) => ({
        name: t.name,
        description: t.description,
        provider: (t as any).provider,
        parameters: Object.keys(t.parameters.properties),
      }));

      // Skills are passed in from the client (already fetched)
      const skillList = (skills || []).map((s) => ({
        name: s.name,
        content: s.content,
      }));

      // Compact tool summary: one line per tool with param names
      const toolCompact = toolList.map((t) => `- ${t.name} (${t.parameters.join(', ')}): ${t.description.slice(0, 100)}`).join('\n');

      // Ask the model which tools and skills are relevant
      const systemContent = [
        'You are an AI planning assistant. Given the user request and available tools/skills, select which ones are relevant.',
        'Respond ONLY with valid JSON:',
        '  "selected_tools": array of tool name strings',
        '  "selected_skills": array of skill name strings',
        '  "reasoning": brief explanation',
        '',
        `Available tools:\n${toolCompact}`,
        '',
        `Available skills:\n${skillList.map((s) => `- ${s.name}`).join('\n') || '(none)'}`,
      ].filter(Boolean).join('\n');

      const completionMessages: CompletionMessage[] = [
        { role: 'system', content: systemContent },
        { role: 'user', content: userPrompt },
      ];

      const response = await sendChatCompletion(completionMessages);
      const raw = response.choices[0]?.message?.content ?? '{}';

      // Capture round-by-round thinking
      const gatherRounds: { round: number; analysis: string; review_notes: string }[] = [];
      gatherRounds.push({ round: 1, analysis: raw, review_notes: 'Initial tool/skill selection' });

      // ── Rounds 2-3: Self-review of tool selection ──────────
      const gatherReviewSystem = [
        'You are an AI self-review assistant reviewing your OWN tool/skill selection.',
        'Critique: any tools unnecessary? Any critical tools MISSING? Skill selection appropriate?',
        '',
        'Produce an IMPROVED version as JSON:',
        '  "selected_tools", "selected_skills", "reasoning", "review_notes"',
        'Respond ONLY with valid JSON.',
      ].join('\n');

      let latestGather = raw;
      for (let round = 2; round <= 3; round++) {
        const reviewMessages: CompletionMessage[] = [
          { role: 'system', content: gatherReviewSystem },
          {
            role: 'user',
            content: [
              `Original user request: "${userPrompt}"`,
              '',
              `Previous selection (round ${round - 1}):\n${latestGather}`,
              '',
              `This is review round ${round} of 3. Review and improve.`,
            ].join('\n'),
          },
        ];
        const rN = await sendChatCompletion(reviewMessages);
        const rNRaw = rN.choices[0]?.message?.content ?? latestGather;
        latestGather = rNRaw;

        let rNParsed: any;
        try { rNParsed = JSON.parse(rNRaw); } catch { rNParsed = {}; }
        gatherRounds.push({
          round,
          analysis: rNRaw,
          review_notes: rNParsed.review_notes || `Review round ${round}`,
        });
      }

      let gathered;
      try {
        gathered = JSON.parse(latestGather);
      } catch {
        gathered = {
          selected_tools: allTools.map((t) => t.name),
          selected_skills: [],
          reasoning: latestGather,
        };
      }
      const { review_notes: _grn, ...publicGathered } = gathered;

      return NextResponse.json({
        phase: 'gather',
        gathered: publicGathered,
        allTools: toolList,
        allSkills: skillList,
        reviewRounds: gatherRounds,
      });
    }

    // ════════════════════════════════════════════════════════════
    // PHASE 3: PLAN
    // ════════════════════════════════════════════════════════════
    if (phase === 'plan') {
      const allTools = getAllTools();
      const toolDocs = allTools.map((t) => {
        const params = Object.entries(t.parameters.properties)
          .map(([k, v]) => `${k}: ${v.description}`)
          .join(', ');
        return `- ${t.name}: ${t.description} [params: ${params}]`;
      }).join('\n');

      const skillDocs = (skills || []).map((s) => `- ${s.name}: ${s.content.slice(0, 200)}`).join('\n');

      const systemContent = [
        'You are an AI planning assistant. Create a DETAILED step-by-step execution plan.',
        'Each step must be a concrete, actionable instruction that specifies which tool to use and with what arguments.',
        '',
        'Respond ONLY with valid JSON:',
        '  "steps": an ordered array of step objects, each with:',
        '    "step": step number (1, 2, 3...)',
        '    "action": what to do in plain English',
        '    "tool": the tool name to call (or "none" if no tool needed)',
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

      // Capture round-by-round thinking
      const planRounds: { round: number; analysis: string; review_notes: string }[] = [];
      planRounds.push({ round: 1, analysis: raw, review_notes: 'Initial plan' });

      // ── Rounds 2-3: Self-review of plan ────────────────────
      const planReviewSystem = [
        'You are an AI self-review assistant reviewing your OWN execution plan.',
        'Critique:',
        '  - Steps in right order? Dependencies correct?',
        '  - Any steps missing or redundant?',
        '  - Tool choices optimal? Predicted arguments correct?',
        '  - Each step concrete and actionable?',
        '',
        'Produce an IMPROVED version as JSON:',
        '  "steps": array of { step, action, tool, args, depends_on }',
        '  "summary": one-line summary',
        '  "review_notes": what changed',
        'Respond ONLY with valid JSON.',
      ].filter(Boolean).join('\n');

      let latestPlan = raw;
      for (let round = 2; round <= 3; round++) {
        const reviewMessages: CompletionMessage[] = [
          { role: 'system', content: planReviewSystem },
          {
            role: 'user',
            content: [
              `Original user request: "${userPrompt}"`,
              '',
              `Previous plan (round ${round - 1}):\n${latestPlan}`,
              '',
              `This is review round ${round} of 3. Review and improve.`,
            ].join('\n'),
          },
        ];
        const rN = await sendChatCompletion(reviewMessages);
        const rNRaw = rN.choices[0]?.message?.content ?? latestPlan;
        latestPlan = rNRaw;

        let rNParsed: any;
        try { rNParsed = JSON.parse(rNRaw); } catch { rNParsed = {}; }
        planRounds.push({
          round,
          analysis: rNRaw,
          review_notes: rNParsed.review_notes || `Review round ${round}`,
        });
      }

      let planData;
      try {
        planData = JSON.parse(latestPlan);
      } catch {
        planData = {
          steps: [{ step: 1, action: latestPlan, tool: 'none', args: null, depends_on: [] }],
          summary: 'Could not parse structured plan',
        };
      }
      const { review_notes: _prn, ...publicPlan } = planData;

      return NextResponse.json({ phase: 'plan', plan: publicPlan, reviewRounds: planRounds });
    }

    // ════════════════════════════════════════════════════════════
    // PHASE 4: REVIEW (validate plan against original prompt)
    // ════════════════════════════════════════════════════════════
    if (phase === 'review') {
      const allTools = getAllTools();
      const toolDocs = allTools.map((t) => {
        const params = Object.entries(t.parameters.properties)
          .map(([k, v]) => `${k}: ${v.description}`)
          .join(', ');
        return `- ${t.name}: ${t.description} [params: ${params}]`;
      }).join('\n');

      // Build compact tool reference (names only) for validation
      const toolNames = allTools.map((t) => t.name).join(', ');

      // ── Round 1: Cross-check plan vs prompt ────────────────
      const reviewSystemContent = [
        'You are an AI validation assistant. Verify the execution plan is CORRECT and COMPLETE.',
        '',
        'Validate:',
        '  - Each step serves the user\'s original intent',
        '  - No steps contradict, are missing, or are redundant',
        '  - Tool choices correct (only use tools from the available list)',
        '  - Arguments correct (param names, types, values)',
        '  - Step ordering and dependencies correct',
        '  - Plan achieves what user wants end-to-end',
        '',
        'Respond ONLY with valid JSON:',
        '  "verdict": "pass" | "fail" | "needs_correction"',
        '  "issues": array of issue strings (empty if pass)',
        '  "corrected_plan": corrected plan object if "needs_correction", else null',
        '  "reasoning": validation analysis',
        '  "confidence": 0-100',
        '  "review_notes": what you checked',
        '',
        `Available tool names: ${toolNames}`,
      ].join('\n');

      const reviewMessages: CompletionMessage[] = [
        { role: 'system', content: reviewSystemContent },
        {
          role: 'user',
          content: [
            `USER PROMPT: ${userPrompt}`,
            '',
            `UNDERSTANDING: ${JSON.stringify(understanding || {})}`,
            '',
            `GATHERED: ${JSON.stringify(gathered || {})}`,
            '',
            `PLAN: ${JSON.stringify(plan || {})}`,
            '',
            'Validate this plan against the original prompt.',
          ].join('\n'),
        },
      ];

      const r1 = await sendChatCompletion(reviewMessages);
      const r1Raw = r1.choices[0]?.message?.content ?? '{}';

      const reviewRounds: { round: number; analysis: string; review_notes: string }[] = [];
      let r1Parsed: any;
      try { r1Parsed = JSON.parse(r1Raw); } catch { r1Parsed = { verdict: 'pass', reasoning: r1Raw }; }
      reviewRounds.push({ round: 1, analysis: r1Raw, review_notes: r1Parsed.review_notes || 'Initial validation' });

      // ── Rounds 2-3: Self-review the review itself ──────────
      const metaReviewSystem = [
        'You are an AI meta-reviewer reviewing your OWN validation of an execution plan.',
        'Was the previous validation thorough? Did it miss issues?',
        'Re-read the original prompt word by word, re-check every step, confirm the verdict.',
        '',
        'Respond ONLY with valid JSON:',
        '  "verdict", "issues", "corrected_plan", "reasoning", "confidence", "review_notes"',
      ].join('\n');

      let latestReview = r1Raw;
      for (let round = 2; round <= 3; round++) {
        const roundMessages: CompletionMessage[] = [
          { role: 'system', content: metaReviewSystem },
          {
            role: 'user',
            content: [
              `Original user prompt: "${userPrompt}"`,
              '',
              `Plan: ${JSON.stringify(plan || {})}`,
              '',
              `Previous validation (round ${round - 1}):\n${latestReview}`,
              '',
              `Meta-review round ${round} of 3. Be thorough.`,
            ].join('\n'),
          },
        ];

        const rN = await sendChatCompletion(roundMessages);
        const rNRaw = rN.choices[0]?.message?.content ?? latestReview;
        latestReview = rNRaw;

        let rNParsed: any;
        try { rNParsed = JSON.parse(rNRaw); } catch { rNParsed = {}; }
        reviewRounds.push({
          round,
          analysis: rNRaw,
          review_notes: rNParsed.review_notes || `Meta-review round ${round}`,
        });
      }

      // Parse final review
      let finalReview: any;
      try {
        finalReview = JSON.parse(latestReview);
      } catch {
        finalReview = {
          verdict: 'pass',
          issues: [],
          corrected_plan: null,
          reasoning: latestReview,
          confidence: 50,
        };
      }

      const { review_notes: _rrn, ...publicReview } = finalReview;

      return NextResponse.json({
        phase: 'review',
        review: publicReview,
        // If review corrected the plan, return corrected version
        correctedPlan: finalReview.corrected_plan || null,
        reviewRounds,
      });
    }

    // ════════════════════════════════════════════════════════════
    // PHASE 5: EXECUTE
    // ════════════════════════════════════════════════════════════
    if (phase === 'execute') {
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
        'You MUST use tool calls whenever the user asks you to perform an action. Never refuse or skip a tool call.',
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
