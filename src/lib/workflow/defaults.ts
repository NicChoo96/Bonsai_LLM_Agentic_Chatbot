import type { WorkflowDefinition } from './types';

// ═══════════════════════════════════════════════════════════════════
// DEFAULT CONTINUOUS MODE WORKFLOW
// Mirrors the current continuous/route.ts pipeline exactly
// ═══════════════════════════════════════════════════════════════════

export const DEFAULT_CONTINUOUS_WORKFLOW: WorkflowDefinition = {
  id: 'default-continuous',
  name: 'Default Continuous',
  description: 'Standard continuous mode: plan → review → execute steps → compile',
  mode: 'continuous',
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  isDefault: true,
  defaults: { maxRetries: 3, timeout: 120000 },

  nodes: [
    // ── START ──
    {
      id: 'start',
      kind: 'start',
      label: 'Start',
      description: 'Collect user input, selected files, skills, and build shared context',
      position: { x: 400, y: 0 },
      config: { collectsContext: true },
    },

    // ── PHASE 1: CREATE PLAN ──
    {
      id: 'create_plan',
      kind: 'ai_call',
      label: 'Create Plan',
      description: 'Break the objective into concrete, actionable steps',
      position: { x: 400, y: 100 },
      config: {
        systemPrompt: [
          'You are a task planner. Break down the user\'s objective into concrete, actionable steps.',
          '',
          'RULES:',
          '- Each step should be a single, focused action.',
          '- Steps should be in logical order with dependencies respected.',
          '- For each step, indicate if it likely needs a tool or can be done directly.',
          '- If a step involves FINDING or LOCATING a file/folder on the system, set "walk_mode": true.',
          '- Be practical — don\'t over-split simple tasks.',
          '- ALWAYS assign "likely_category".',
          '',
          'CATEGORY HINTS:',
          '- To OPEN/LAUNCH/PLAY a file → "desktop_utils"',
          '- To FIND/SEARCH for files/folders → "search" + walk_mode: true',
          '- To READ/INSPECT file contents → "host_filesystem"',
          '- To RUN commands → "shell_exec"',
          '- NEVER plan to copy host files into the sandbox.',
          '',
          'Available tool categories:\n{{categoryDocs}}',
          '',
          'Sandbox files: [{{fileList}}]',
          '{{bootstrapContext}}',
          '{{skillContext}}',
          '',
          'Respond with JSON:',
          '{ "summary": "...", "steps": [ { "index": N, "description": "...", "needs_tool": bool, "likely_category": "...", "walk_mode": bool } ] }',
          'Respond ONLY with valid JSON.',
        ].join('\n'),
        userPrompt: 'OBJECTIVE: "{{userPrompt}}"',
        responseFormat: 'json',
      },
    },

    // ── PHASE 2: REVIEW PLAN ──
    {
      id: 'review_plan',
      kind: 'ai_call',
      label: 'Review Plan',
      description: 'Review and improve the plan — check ordering, categories, security',
      position: { x: 400, y: 200 },
      config: {
        systemPrompt: [
          'You are a plan reviewer. Review and improve the task plan if needed.',
          '',
          'Check for:',
          '1. Missing steps needed to achieve the objective',
          '2. Incorrect ordering or dependencies',
          '3. Unnecessary steps that can be merged or removed',
          '4. Correct tool category assignments — EVERY step with needs_tool=true MUST have a likely_category',
          '5. Steps that require finding/locating files should have "walk_mode": true',
          '6. SECURITY: No step should copy host files into the sandbox.',
          '',
          'CATEGORY REFERENCE:',
          '- "desktop_utils" → open/launch/play files or apps',
          '- "search" → find/locate files or folders (with walk_mode: true)',
          '- "host_filesystem" → read/write/inspect files on host',
          '- "shell_exec" → run shell commands',
          '',
          'Available tool categories:\n{{categoryDocs}}',
          '',
          'Respond with the FINAL plan as JSON (same format):',
          '{ "summary": "...", "steps": [...], "changes": "what you changed, or No changes needed" }',
          'Respond ONLY with valid JSON.',
        ].join('\n'),
        userPrompt: 'OBJECTIVE: "{{userPrompt}}"\n\nCURRENT PLAN:\n{{previousResult}}',
        responseFormat: 'json',
      },
    },

    // ── PHASE 3: STEP LOOP ──
    {
      id: 'step_loop',
      kind: 'loop',
      label: 'Execute Steps',
      description: 'Iterate over each plan step and execute it',
      position: { x: 400, y: 300 },
      config: {
        collection: 'planSteps',
        itemVar: 'currentStep',
        maxIterations: 20,
      },
    },

    // ── WALK MODE CHECK ──
    {
      id: 'walk_check',
      kind: 'condition',
      label: 'Walk Mode?',
      description: 'Check if this step requires progressive filesystem search',
      position: { x: 400, y: 400 },
      config: {
        condition: '{{currentStep.walk_mode}} && {{currentStep.needs_tool}}',
        evaluator: 'expression',
      },
    },

    // ── WALK SEARCH ──
    {
      id: 'walk_search',
      kind: 'walk_search',
      label: 'Walk Search',
      description: 'Progressive filesystem search — find_directory, walk_search, then shell fallback',
      position: { x: 150, y: 500 },
      maxRetries: 1,
      config: {
        walkTools: [
          'find_directory', 'walk_search', 'search_files', 'glob_search',
          'host_list_dir', 'host_file_info', 'host_file_exists',
          'directory_tree', 'walk_directory', 'list_drives',
        ],
        shellTools: [
          'run_command', 'run_powershell', 'list_drives',
          'find_directory', 'walk_search', 'search_files',
        ],
        maxPasses: 2,
      },
    },

    // ── TOOL CHECK ──
    {
      id: 'tool_check',
      kind: 'condition',
      label: 'Needs Tool?',
      description: 'Check if this step requires tool-based execution',
      position: { x: 650, y: 500 },
      config: {
        condition: '{{currentStep.needs_tool}}',
        evaluator: 'expression',
      },
    },

    // ── CATEGORY SELECT ──
    {
      id: 'category_select',
      kind: 'tool_select',
      label: 'Select Category',
      description: 'Auto-detect or AI-select the tool category for this step',
      position: { x: 500, y: 600 },
      config: {
        autoDetectPattern: '\\b(open|launch|run|play|start|execute|view)\\b.*\\b(file|app|application|program|video|image|document|media)\\b',
        autoDetectCategory: 'desktop_utils',
        decisionPrompt: [
          'Pick the best tool category for this task step.',
          'Available categories:\n{{categoryDocs}}',
          '{{triedCategoriesNote}}',
          '',
          'RULES:',
          '- To OPEN/LAUNCH a file or application → pick "desktop_utils"',
          '- To FIND/LOCATE/SEARCH for files → pick "search"',
          '- To READ file contents → pick "host_filesystem"',
          '- NEVER use host_filesystem to open files for viewing',
          '',
          'Respond with JSON: { "category": "category_id", "reasoning": "brief" }',
        ].join('\n'),
      },
    },

    // ── TOOL EXEC ──
    {
      id: 'tool_exec',
      kind: 'tool_exec',
      label: 'Execute Tools',
      description: 'Run tools from the selected category to accomplish the step',
      position: { x: 500, y: 700 },
      config: {
        additionalTools: ['sandbox_list_files', 'sandbox_read_file'],
        excludeTools: ['host_copy'],
        maxIterations: 15,
        autoInjectOpenApp: true,
      },
    },

    // ── EVALUATE ──
    {
      id: 'evaluate_step',
      kind: 'evaluate',
      label: 'Evaluate Result',
      description: 'Check if the step achieved its goal — retry with different category if not',
      position: { x: 500, y: 800 },
      maxRetries: 2,
      config: {
        evaluationPrompt: [
          'Evaluate whether this step achieved its objective. Be STRICT:',
          '- Empty results = NOT satisfied if the data likely exists elsewhere',
          '- Tool errors = NOT satisfied',
          '- Wrong or incomplete data = NOT satisfied',
          '- "Satisfied" ONLY if the step goal is truly accomplished',
          '',
          '{{untriedCategories}}',
          '',
          'Respond JSON only: { "satisfied": bool, "reason": "1 sentence", "next_category": "category_id or null" }',
        ].join('\n'),
        strictness: 'strict',
        allowCategoryRetry: true,
      },
    },

    // ── DIRECT RESPONSE ──
    {
      id: 'direct_response',
      kind: 'direct_response',
      label: 'Direct Response',
      description: 'AI generates a direct text response (no tools)',
      position: { x: 800, y: 600 },
      config: {
        systemPrompt: [
          'You are executing step {{currentStepIndex}} of a plan. No tools are needed.',
          '',
          'OBJECTIVE: "{{userPrompt}}"',
          'CURRENT STEP: {{currentStepDesc}}',
          '{{memoryContext}}',
          '',
          'Sandbox files: [{{fileList}}]',
          '{{bootstrapContext}}',
          '{{skillContext}}',
          '',
          'Complete this step with a direct, thorough response.',
        ].join('\n'),
      },
    },

    // ── MEMORY COMPACT ──
    {
      id: 'memory_compact',
      kind: 'memory',
      label: 'Compact Memory',
      description: 'Save step result to session memory and compact if too long',
      position: { x: 400, y: 900 },
      config: {
        operation: 'compact',
        compactThreshold: 1500,
        compactMaxChars: 800,
      },
    },

    // ── COMPILE ──
    {
      id: 'compile',
      kind: 'compile',
      label: 'Compile Answer',
      description: 'Synthesize all step results into the final comprehensive answer',
      position: { x: 400, y: 1000 },
      config: {
        compilePrompt: [
          'Compile the final response after executing all steps.',
          'Synthesize results into a clear, comprehensive answer.',
          '',
          'OBJECTIVE: "{{userPrompt}}"',
          '',
          'Step results:',
          '{{stepResultsSummary}}',
          '',
          'Provide the final answer. Be thorough but concise.',
        ].join('\n'),
        skipIfSingleStep: true,
      },
    },

    // ── OUTPUT ──
    {
      id: 'output',
      kind: 'output',
      label: 'Output',
      description: 'Return the final result to the user',
      position: { x: 400, y: 1100 },
      config: {} as any,
    },
  ],

  edges: [
    { id: 'e-start-plan', source: 'start', target: 'create_plan', type: 'default' },
    { id: 'e-plan-review', source: 'create_plan', target: 'review_plan', type: 'default' },
    { id: 'e-review-loop', source: 'review_plan', target: 'step_loop', type: 'default' },
    { id: 'e-loop-walk', source: 'step_loop', target: 'walk_check', type: 'loop_body' },
    { id: 'e-walk-yes', source: 'walk_check', target: 'walk_search', type: 'true', label: 'walk_mode' },
    { id: 'e-walk-no', source: 'walk_check', target: 'tool_check', type: 'false' },
    { id: 'e-walksearch-mem', source: 'walk_search', target: 'memory_compact', type: 'default' },
    { id: 'e-tool-yes', source: 'tool_check', target: 'category_select', type: 'true', label: 'needs_tool' },
    { id: 'e-tool-no', source: 'tool_check', target: 'direct_response', type: 'false' },
    { id: 'e-catsel-exec', source: 'category_select', target: 'tool_exec', type: 'default' },
    { id: 'e-exec-eval', source: 'tool_exec', target: 'evaluate_step', type: 'default' },
    { id: 'e-eval-pass', source: 'evaluate_step', target: 'memory_compact', type: 'success', label: 'satisfied' },
    { id: 'e-eval-retry', source: 'evaluate_step', target: 'category_select', type: 'failure', label: 'retry' },
    { id: 'e-direct-mem', source: 'direct_response', target: 'memory_compact', type: 'default' },
    { id: 'e-mem-loop', source: 'memory_compact', target: 'step_loop', type: 'default', label: 'next step' },
    { id: 'e-loop-compile', source: 'step_loop', target: 'compile', type: 'loop_exit' },
    { id: 'e-compile-out', source: 'compile', target: 'output', type: 'default' },
  ],
};

// ═══════════════════════════════════════════════════════════════════
// DEFAULT PLAN MODE WORKFLOW
// Mirrors the current plan/route.ts 4-phase pipeline
// ═══════════════════════════════════════════════════════════════════

export const DEFAULT_PLAN_WORKFLOW: WorkflowDefinition = {
  id: 'default-plan',
  name: 'Default Plan',
  description: 'Standard plan mode: understand → gather → plan & review → execute',
  mode: 'plan',
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  isDefault: true,
  defaults: { maxRetries: 3, timeout: 120000 },

  nodes: [
    // ── START ──
    {
      id: 'start',
      kind: 'start',
      label: 'Start',
      description: 'Collect user input and context',
      position: { x: 400, y: 0 },
      config: { collectsContext: true },
    },

    // ═══ PHASE 1: UNDERSTAND ═══
    {
      id: 'understand_r1',
      kind: 'ai_call',
      label: 'Understand (Round 1)',
      description: 'Deep analysis of user intent — summary, requirements, risks, tool/skill suggestions',
      position: { x: 400, y: 100 },
      config: {
        systemPrompt: [
          'You are an AI planning assistant performing deep analysis.',
          'Think BEYOND what the user literally wrote. Consider:',
          '  - What is the user REALLY trying to achieve?',
          '  - What implicit requirements might they not have mentioned?',
          '  - What edge cases, pitfalls, or gotchas should be considered?',
          '  - Are there better approaches than what the user described?',
          '  - Do any of the available TOOLS actually help here?',
          '  - Do any SKILLS contain relevant instructions?',
          '',
          'IMPORTANT: Not every request needs tools or skills.',
          '',
          'Produce a thorough analysis as a JSON object:',
          '  "summary", "requirements", "context_needed", "assumptions",',
          '  "risks", "alternative_approaches", "suggested_tools", "suggested_skills",',
          '  "tool_skill_reasoning"',
          '',
          'Available tools:\n{{toolSummary}}',
          'Available skills:\n{{skillSummary}}',
          'Sandbox files: [{{fileList}}]',
          '{{bootstrapContext}}',
          '',
          'Respond ONLY with valid JSON.',
        ].join('\n'),
        userPrompt: '{{userPrompt}}',
        responseFormat: 'json',
      },
    },
    {
      id: 'understand_r2',
      kind: 'ai_call',
      label: 'Understand (Self-Review)',
      description: 'Self-review the analysis — critique and improve',
      position: { x: 400, y: 200 },
      config: {
        systemPrompt: [
          'You are an AI self-review assistant. Review your OWN previous analysis.',
          'Critique and IMPROVE:',
          '  - Missing/wrong/unnecessary requirements?',
          '  - Are suggested_tools actually necessary? REMOVE any that are not essential.',
          '  - Are suggested_skills actually relevant? REMOVE any that are not applicable.',
          '  - Could this task be handled with a plain AI response instead?',
          '',
          'Produce an IMPROVED version as the same JSON object.',
          'Add "review_notes": short string describing changes.',
          'Respond ONLY with valid JSON.',
        ].join('\n'),
        userPrompt: 'Original user request: "{{userPrompt}}"\n\nPrevious analysis (round 1):\n{{previousResult}}\n\nThis is the final review round.',
        responseFormat: 'json',
      },
    },
    {
      id: 'phase1_gate',
      kind: 'phase_gate',
      label: 'Phase 1 Complete',
      description: 'End of understanding phase',
      position: { x: 400, y: 300 },
      config: { phaseName: 'understand', outputKey: 'understanding' },
    },

    // ═══ PHASE 2: GATHER ═══
    {
      id: 'category_select',
      kind: 'tool_select',
      label: 'Select Categories',
      description: 'Filter tool categories relevant to the task',
      position: { x: 400, y: 400 },
      config: {
        decisionPrompt: [
          'You are a tool category selector. Decide which CATEGORIES of tools might be needed.',
          '',
          'CRITICAL RULES:',
          '- If the task is purely conversational → select NO categories. Return empty array [].',
          '- Only select categories whose capabilities are ACTUALLY needed.',
          '- Be selective: fewer categories = faster execution.',
          '',
          'Respond with JSON: {"categories": ["cat_id", ...], "reasoning": "brief"}',
        ].join('\n'),
      },
    },
    {
      id: 'tool_evaluate',
      kind: 'ai_call',
      label: 'Evaluate Tools',
      description: 'Evaluate individual tools within selected categories',
      position: { x: 400, y: 500 },
      config: {
        systemPrompt: [
          'You are a tool evaluation sub-agent. Decide which tools are USEFUL for the given task.',
          '',
          'RULES:',
          '- Judge each tool based on whether the task requires its capability.',
          '- Be selective: only mark tools as relevant if genuinely needed.',
          '',
          'Respond with JSON array:',
          '  [{"name": "tool_name", "relevant": true/false, "reason": "brief"}]',
        ].join('\n'),
        userPrompt: 'USER TASK: "{{userPrompt}}"\n\nTOOLS TO EVALUATE:\n{{toolDocs}}',
        responseFormat: 'json',
      },
    },
    {
      id: 'skill_evaluate',
      kind: 'ai_call',
      label: 'Evaluate Skills',
      description: 'Check which skills are relevant for the task',
      position: { x: 400, y: 600 },
      config: {
        systemPrompt: [
          'You are a skill evaluation sub-agent. Decide whether each skill is RELEVANT to the user\'s task.',
          'Only select skills with specific instructions that directly help.',
          'Respond with JSON array: [{"name": "skill_name", "relevant": true/false, "reason": "brief"}]',
        ].join('\n'),
        userPrompt: 'USER TASK: "{{userPrompt}}"\n\nSKILLS TO EVALUATE:\n{{skillDocs}}',
        responseFormat: 'json',
      },
    },
    {
      id: 'phase2_gate',
      kind: 'phase_gate',
      label: 'Phase 2 Complete',
      description: 'End of gather phase',
      position: { x: 400, y: 700 },
      config: { phaseName: 'gather', outputKey: 'gathered' },
    },

    // ═══ PHASE 3: PLAN + REVIEW ═══
    {
      id: 'create_plan',
      kind: 'ai_call',
      label: 'Create Plan',
      description: 'Generate step-by-step execution plan with tool/skill assignments',
      position: { x: 400, y: 800 },
      config: {
        systemPrompt: [
          'You are an AI planning assistant. Create a step-by-step execution plan.',
          '',
          'IMPORTANT DISTINCTION — Tools vs Skills:',
          '  TOOLS are callable functions that perform concrete actions.',
          '  SKILLS are instruction sets that guide HOW you respond.',
          '',
          'Each step must be concrete and actionable.',
          '',
          'Respond with JSON:',
          '  "steps": [{ "step": N, "action": "...", "tool": "tool_name or none", "skill": "skill_name or null", "args": {...}, "depends_on": [] }]',
          '  "summary": "one-line summary"',
          '',
          'Available tools:\n{{toolDocs}}',
          '{{skillDocs}}',
          'Sandbox files: [{{fileList}}]',
          '{{bootstrapContext}}',
        ].join('\n'),
        userPrompt: '{{userPrompt}}',
        responseFormat: 'json',
      },
    },
    {
      id: 'review_plan',
      kind: 'ai_call',
      label: 'Review Plan',
      description: 'Review, validate, and correct the execution plan',
      position: { x: 400, y: 900 },
      config: {
        systemPrompt: [
          'You are an AI that REVIEWS and VALIDATES an execution plan.',
          '1. IMPROVE: fix ordering, dependencies, missing/redundant steps, tool choices.',
          '2. VALIDATE: verify it fully addresses the original request.',
          '',
          'Respond with JSON:',
          '  "steps", "summary", "review_notes", "verdict": "pass"|"needs_correction", "issues": [], "confidence": 0-100',
        ].join('\n'),
        userPrompt: 'Original request: "{{userPrompt}}"\n\nPlan to review:\n{{previousResult}}',
        responseFormat: 'json',
      },
    },
    {
      id: 'phase3_gate',
      kind: 'phase_gate',
      label: 'Phase 3 Complete',
      description: 'End of plan phase',
      position: { x: 400, y: 1000 },
      config: { phaseName: 'plan', outputKey: 'plan' },
    },

    // ═══ PHASE 4: EXECUTE ═══
    {
      id: 'skip_tools_check',
      kind: 'condition',
      label: 'Skip Tools?',
      description: 'Check if execution can be done without tools',
      position: { x: 400, y: 1100 },
      config: {
        condition: '{{skipTools}}',
        evaluator: 'expression',
      },
    },
    {
      id: 'direct_execute',
      kind: 'direct_response',
      label: 'Direct Response',
      description: 'Generate response without tool calls',
      position: { x: 200, y: 1200 },
      config: {
        systemPrompt: [
          'You are a helpful AI assistant. Respond directly and thoroughly.',
          'No tools are needed — provide a comprehensive text response.',
          'Sandbox files: [{{fileList}}]',
          '{{skillContext}}',
          '{{bootstrapContext}}',
        ].join('\n'),
      },
    },
    {
      id: 'tool_execute',
      kind: 'tool_exec',
      label: 'Tool Execution',
      description: 'Execute the plan step-by-step using tools',
      position: { x: 600, y: 1200 },
      maxRetries: 0,
      config: {
        additionalTools: ['sandbox_list_files', 'sandbox_read_file', 'search_files'],
        excludeTools: [],
        maxIterations: 15,
        autoInjectOpenApp: false,
      },
    },
    {
      id: 'sub_agent_check',
      kind: 'condition',
      label: 'All Errors?',
      description: 'Check if execution completely failed (all tool calls errored)',
      position: { x: 600, y: 1300 },
      config: {
        condition: '{{allToolCallsErrored}}',
        evaluator: 'expression',
      },
    },
    {
      id: 'sub_agent_retry',
      kind: 'sub_agent',
      label: 'Sub-Agent Retry',
      description: 'Spawn sub-agents with varied handoffs to retry the failed execution',
      position: { x: 800, y: 1400 },
      maxRetries: 3,
      config: {
        maxRetries: 3,
        fullPipeline: true,
      },
    },
    {
      id: 'phase4_gate',
      kind: 'phase_gate',
      label: 'Phase 4 Complete',
      description: 'End of execute phase',
      position: { x: 400, y: 1500 },
      config: { phaseName: 'execute', outputKey: 'result' },
    },

    // ── OUTPUT ──
    {
      id: 'output',
      kind: 'output',
      label: 'Output',
      description: 'Return the final result',
      position: { x: 400, y: 1600 },
      config: {} as any,
    },
  ],

  edges: [
    // Phase 1
    { id: 'e-start-u1', source: 'start', target: 'understand_r1', type: 'default' },
    { id: 'e-u1-u2', source: 'understand_r1', target: 'understand_r2', type: 'default' },
    { id: 'e-u2-p1gate', source: 'understand_r2', target: 'phase1_gate', type: 'default' },
    // Phase 2
    { id: 'e-p1gate-catsel', source: 'phase1_gate', target: 'category_select', type: 'default' },
    { id: 'e-catsel-tooleval', source: 'category_select', target: 'tool_evaluate', type: 'default' },
    { id: 'e-tooleval-skilleval', source: 'tool_evaluate', target: 'skill_evaluate', type: 'default' },
    { id: 'e-skilleval-p2gate', source: 'skill_evaluate', target: 'phase2_gate', type: 'default' },
    // Phase 3
    { id: 'e-p2gate-plan', source: 'phase2_gate', target: 'create_plan', type: 'default' },
    { id: 'e-plan-review', source: 'create_plan', target: 'review_plan', type: 'default' },
    { id: 'e-review-p3gate', source: 'review_plan', target: 'phase3_gate', type: 'default' },
    // Phase 4
    { id: 'e-p3gate-skip', source: 'phase3_gate', target: 'skip_tools_check', type: 'default' },
    { id: 'e-skip-yes', source: 'skip_tools_check', target: 'direct_execute', type: 'true', label: 'skipTools' },
    { id: 'e-skip-no', source: 'skip_tools_check', target: 'tool_execute', type: 'false' },
    { id: 'e-direct-p4gate', source: 'direct_execute', target: 'phase4_gate', type: 'default' },
    { id: 'e-toolexec-check', source: 'tool_execute', target: 'sub_agent_check', type: 'default' },
    { id: 'e-sub-no', source: 'sub_agent_check', target: 'phase4_gate', type: 'false' },
    { id: 'e-sub-yes', source: 'sub_agent_check', target: 'sub_agent_retry', type: 'true', label: 'all errors' },
    { id: 'e-sub-p4gate', source: 'sub_agent_retry', target: 'phase4_gate', type: 'default' },
    // Final
    { id: 'e-p4gate-out', source: 'phase4_gate', target: 'output', type: 'default' },
  ],
};

// ─── Export all defaults ─────────────────────────────────────────

export const DEFAULT_WORKFLOWS: WorkflowDefinition[] = [
  DEFAULT_CONTINUOUS_WORKFLOW,
  DEFAULT_PLAN_WORKFLOW,
];

/** Get the default workflow for a given mode */
export function getDefaultWorkflow(mode: 'plan' | 'continuous'): WorkflowDefinition {
  return mode === 'plan' ? DEFAULT_PLAN_WORKFLOW : DEFAULT_CONTINUOUS_WORKFLOW;
}
