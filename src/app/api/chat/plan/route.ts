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
// Phase 4: execute     – run the plan steps sequentially

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
    } = body as {
      phase: 'understand' | 'gather' | 'plan' | 'execute';
      userPrompt: string;
      messages: { role: string; content: string }[];
      selectedFiles: string[];
      skills: { name: string; content: string }[];
      plan: { steps: string[]; toolPlan: string };
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
        'Your job is to CRITIQUE and IMPROVE the analysis. For each review round:',
        '  - Is anything MISSING from the requirements?',
        '  - Is the summary accurate and complete?',
        '  - Are there requirements listed that are actually unnecessary or wrong?',
        '  - Did the previous round overlook any edge cases?',
        '  - Can the requirements be more specific or actionable?',
        '  - Are the assumptions valid?',
        '  - TOOLS: Are the suggested tools actually the best fit? Are any missing? Are any unnecessary?',
        '  - SKILLS: Are the suggested skills relevant? Should any existing skill be used differently? Should a new skill be created?',
        '  - Is the tool_skill_reasoning sound? Would a different combination work better?',
        '',
        'Produce an IMPROVED version of the analysis as the same JSON object:',
        '  "summary", "requirements", "context_needed", "assumptions", "risks", "alternative_approaches",',
        '  "suggested_tools", "suggested_skills", "tool_skill_reasoning"',
        '',
        'Also add a field "review_notes": a short string describing what you changed/improved in this round.',
        '',
        'Respond ONLY with valid JSON. No markdown, no explanation.',
        '',
        `Available tools:\n${toolSummary}`,
        '',
        `Available skills:\n${skillSummary}`,
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

      // Ask the model which tools and skills are relevant
      const systemContent = [
        'You are an AI planning assistant. Given the user request and available tools/skills, select which ones are relevant.',
        'Respond ONLY with valid JSON:',
        '  "selected_tools": array of tool name strings that are relevant',
        '  "selected_skills": array of skill name strings that are relevant',
        '  "reasoning": brief explanation of why these were selected',
        '',
        `Available tools:\n${JSON.stringify(toolList, null, 2)}`,
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
        'Critique the previous selection:',
        '  - Are any selected tools unnecessary for this task?',
        '  - Are any critical tools MISSING that should be included?',
        '  - Is the skill selection appropriate?',
        '  - Is the reasoning accurate and complete?',
        '',
        'Produce an IMPROVED version as JSON:',
        '  "selected_tools": array of tool name strings',
        '  "selected_skills": array of skill name strings',
        '  "reasoning": brief explanation',
        '  "review_notes": what you changed/improved',
        '',
        'Respond ONLY with valid JSON.',
        '',
        `Available tools:\n${JSON.stringify(toolList, null, 2)}`,
        '',
        `Available skills:\n${skillList.map((s) => `- ${s.name}`).join('\n') || '(none)'}`,
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
        'Critique the previous plan:',
        '  - Are steps in the right order? Are dependencies correct?',
        '  - Are any steps missing or redundant?',
        '  - Are the tool choices optimal for each step?',
        '  - Are the predicted arguments correct?',
        '  - Is the plan too verbose or too vague? Each step should be concrete and actionable.',
        '',
        'Produce an IMPROVED version as JSON:',
        '  "steps": array of { step, action, tool, args, depends_on }',
        '  "summary": one-line summary',
        '  "review_notes": what you changed/improved',
        '',
        'Respond ONLY with valid JSON.',
        '',
        `Available tools:\n${toolDocs}`,
        skillDocs ? `\nAvailable skills:\n${skillDocs}` : '',
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
    // PHASE 4: EXECUTE
    // ════════════════════════════════════════════════════════════
    if (phase === 'execute') {
      const toolPrompt = buildToolSystemPrompt();

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
