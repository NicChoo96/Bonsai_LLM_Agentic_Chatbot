import { NextRequest } from 'next/server';
import {
  registerProvider,
  filesystemProvider,
  chromeDevToolsProvider,
  webFetchProvider,
  systemProvider,
  documentProvider,
  getAllTools,
  getToolCategories,
} from '@/lib/mcp';
import { buildToolSystemPrompt, runChatWithTools, stripToolCallBlocks } from '@/lib/tool-processor';
import type { ToolCall } from '@/types';
import { readSandboxFile, ensureSandbox, listSandboxFiles } from '@/lib/sandbox';
import { sendChatCompletion, type CompletionMessage } from '@/lib/ai-client';

// Register all MCP providers
registerProvider(filesystemProvider);
registerProvider(chromeDevToolsProvider);
registerProvider(webFetchProvider);
registerProvider(systemProvider);
registerProvider(documentProvider);

// ─── Continuous mode: SSE streaming with step-by-step execution ──
// Flow: plan (2 rounds) → execute each step (tool or direct) → final answer
// Each step: decide tool category → select tool → execute → next step

export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    userPrompt,
    selectedFiles,
    skills,
  } = body as {
    userPrompt: string;
    selectedFiles: string[];
    skills: { name: string; content: string }[];
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
        fileContents.push(`--- ${filePath} ---\n${content}`);
      } catch { /* skip unreadable */ }
    }
    if (fileContents.length) {
      bootstrapContext = `\nSelected file contents:\n\n${fileContents.join('\n\n')}`;
    }
  }

  // Filter skills: only include those explicitly referenced in the user prompt
  // or mentioned by another referenced skill. AI can request more later via plan steps.
  const allSkills: { name: string; content: string }[] = skills || [];
  const lowerPrompt = userPrompt.toLowerCase();
  const referencedSkills = new Set<string>();

  // Pass 1: find skills whose name appears in the user prompt
  for (const s of allSkills) {
    if (lowerPrompt.includes(s.name.toLowerCase())) {
      referencedSkills.add(s.name);
    }
  }

  // Pass 2: find skills referenced by already-selected skills
  for (const s of allSkills) {
    if (!referencedSkills.has(s.name)) continue;
    const lc = s.content.toLowerCase();
    for (const other of allSkills) {
      if (other.name !== s.name && lc.includes(other.name.toLowerCase())) {
        referencedSkills.add(other.name);
      }
    }
  }

  const activeSkills = allSkills.filter(s => referencedSkills.has(s.name));
  const filteredSkillContext = activeSkills.length > 0
    ? `\nActive Skills (follow these instructions):\n${activeSkills.map((s) => `[Skill: ${s.name}]\n${s.content}`).join('\n---\n')}`
    : '';

  // Provide a summary of available (but not loaded) skills so the AI knows they exist
  const inactiveSkills = allSkills.filter(s => !referencedSkills.has(s.name));
  const skillCatalog = inactiveSkills.length > 0
    ? `\nAvailable skills (not loaded — mention by name if needed): ${inactiveSkills.map(s => s.name).join(', ')}`
    : '';

  // Tool categories for category-first selection
  const categories = getToolCategories();
  const categoryDocs = categories.map((c) =>
    `- ${c.id}: ${c.label} — ${c.description} (${c.toolNames.length} tools)`
  ).join('\n');

  // ── SSE stream ──────────────────────────────────────────
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function sendEvent(event: string, data: any) {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      }

      try {
        // ═══ PHASE 1: CREATE PLAN ═══════════════════════════
        sendEvent('status', { phase: 'planning', message: 'Creating step-by-step plan...' });

        const planSystem = [
          'You are a task planner. Break down the user\'s objective into concrete, actionable steps.',
          '',
          'RULES:',
          '- Each step should be a single, focused action.',
          '- Steps should be in logical order with dependencies respected.',
          '- For each step, indicate if it likely needs a tool (file I/O, web requests, shell commands, etc.) or can be done directly (text generation, analysis, creative writing).',
          '- If a step involves FINDING or LOCATING a file/folder on the system (not in the sandbox), set "walk_mode": true. Walk mode will progressively search drives and depths until found.',
          '- Be practical — don\'t over-split simple tasks. A single-sentence request may only need 1 step.',
          '- ALWAYS assign "likely_category" — pick the most appropriate category from the list below.',
          '',
          'CATEGORY HINTS:',
          '- To OPEN/LAUNCH/PLAY a file → "desktop_utils" (has open_app tool)',
          '- To FIND/SEARCH for files/folders → "search" + walk_mode: true',
          '- To READ/INSPECT file contents → "host_filesystem"',
          '- To RUN commands → "shell_exec"',
          '- NEVER plan to copy host files into the sandbox — that is a security violation.',
          '',
          `Available tool categories:\n${categoryDocs}`,
          '',
          `Sandbox files: [${fileList}]`,
          bootstrapContext,
          filteredSkillContext,
          skillCatalog,
          '',
          'Respond with JSON:',
          '{',
          '  "summary": "brief description of the overall plan",',
          '  "steps": [',
          '    { "index": 1, "description": "what to do", "needs_tool": true/false, "likely_category": "category_id or null", "walk_mode": false }',
          '  ]',
          '}',
          'walk_mode should be true ONLY for steps that need to locate/find something on the host filesystem.',
          'Respond ONLY with valid JSON.',
        ].filter(Boolean).join('\n');

        const planUser = `OBJECTIVE: "${userPrompt}"`;

        const planResponse = await sendChatCompletion([
          { role: 'system', content: planSystem },
          { role: 'user', content: planUser },
        ]);
        const planRaw = planResponse.choices[0]?.message?.content ?? '{}';

        let plan: any;
        try {
          plan = JSON.parse(planRaw);
        } catch {
          plan = {
            summary: 'Execute the task directly',
            steps: [{ index: 1, description: userPrompt, needs_tool: false, likely_category: null }],
          };
        }

        sendEvent('plan', { steps: plan.steps, summary: plan.summary });
        sendEvent('exchange', { phase: 'plan', role: 'user', label: 'Plan prompt', content: planUser });
        sendEvent('exchange', { phase: 'plan', role: 'assistant', label: 'Plan response', content: planRaw });

        // ═══ PHASE 2: REVIEW PLAN ══════════════════════════
        sendEvent('status', { phase: 'reviewing', message: 'Reviewing plan...' });

        const reviewSystem = [
          'You are a plan reviewer. Review and improve the task plan if needed.',
          '',
          'Check for:',
          '1. Missing steps that are needed to achieve the objective',
          '2. Incorrect ordering or dependencies',
          '3. Unnecessary steps that can be merged or removed',
          '4. Correct tool category assignments — EVERY step with needs_tool=true MUST have a likely_category',
          '5. Steps that require finding/locating files or folders on the host system should have "walk_mode": true',
          '6. SECURITY: No step should copy host files into the sandbox. To open a file, use "desktop_utils" category.',
          '',
          'CATEGORY REFERENCE:',
          '- "desktop_utils" → open/launch/play files or apps (open_app tool)',
          '- "search" → find/locate files or folders (with walk_mode: true)',
          '- "host_filesystem" → read/write/inspect files on host',
          '- "shell_exec" → run shell commands',
          '',
          `Available tool categories:\n${categoryDocs}`,
          '',
          'Respond with the FINAL plan as JSON (same format):',
          '{ "summary": "...", "steps": [ { "index": N, "description": "...", "needs_tool": bool, "likely_category": "...", "walk_mode": bool } ], "changes": "what you changed, or No changes needed" }',
          'Respond ONLY with valid JSON.',
        ].join('\n');

        const reviewUser = `OBJECTIVE: "${userPrompt}"\n\nCURRENT PLAN:\n${planRaw}`;

        const reviewResponse = await sendChatCompletion([
          { role: 'system', content: reviewSystem },
          { role: 'user', content: reviewUser },
        ]);
        const reviewRaw = reviewResponse.choices[0]?.message?.content ?? '{}';

        let reviewed: any;
        try {
          reviewed = JSON.parse(reviewRaw);
        } catch {
          reviewed = plan;
        }

        const finalSteps: any[] = reviewed.steps || plan.steps || [];
        const planSummary = reviewed.summary || plan.summary || '';

        sendEvent('plan_review', {
          steps: finalSteps,
          summary: planSummary,
          changes: reviewed.changes || '',
        });
        sendEvent('exchange', { phase: 'review', role: 'user', label: 'Review prompt', content: reviewUser });
        sendEvent('exchange', { phase: 'review', role: 'assistant', label: 'Review response', content: reviewRaw });

        // ═══ PHASE 3: EXECUTE STEPS (with evaluation + retry + memory compaction) ═══
        const MAX_STEP_ATTEMPTS = 3;
        const MEMORY_COMPACT_THRESHOLD = 1500;
        let memory = `# Session Memory\n**Objective:** ${userPrompt}\n**Plan:** ${planSummary}\n`;
        const stepResults: { index: number; description: string; result: string; toolCalls: any[] }[] = [];

        for (let i = 0; i < finalSteps.length; i++) {
          const step = finalSteps[i];
          const stepIndex = step.index || (i + 1);
          const stepDesc = step.description || userPrompt;

          sendEvent('step_start', { index: stepIndex, description: stepDesc });
          sendEvent('status', { phase: 'executing', message: `Step ${stepIndex}/${finalSteps.length}: ${stepDesc}`, stepIndex, totalSteps: finalSteps.length });

          let stepReply = '';
          let stepToolCalls: any[] = [];
          let finalStatus = 'complete';

          if (step.walk_mode && step.needs_tool) {
            // ══ WALK MODE: Progressive filesystem search ══════════
            // Instead of a single tool call, walk mode iterates:
            // 1. Try find_directory / walk_search with progressively wider scope
            // 2. If found, proceed; if not, widen search and retry
            // 3. Report each walk pass to the UI
            sendEvent('step_decision', {
              index: stepIndex,
              needsTool: true,
              categories: ['search', 'host_filesystem'],
              walkMode: true,
              attempt: 1,
            });

            const walkTools = new Set([
              'find_directory', 'walk_search', 'search_files', 'glob_search',
              'host_list_dir', 'host_file_info', 'host_file_exists',
              'directory_tree', 'walk_directory', 'list_drives',
            ]);
            const walkToolPrompt = buildToolSystemPrompt(walkTools);

            const walkSystem = [
              `You are executing a WALK MODE step — your job is to FIND something on the filesystem.`,
              '',
              `OBJECTIVE: "${userPrompt}"`,
              `STEP: ${stepDesc}`,
              memory.length > 100 ? `\nSession memory:\n${memory}` : '',
              '',
              'WALK MODE STRATEGY:',
              '1. First try find_directory or walk_search — these search fast across all drives.',
              '2. If walk_search finds it, you have the path. Call directory_tree ONCE to list contents if needed.',
              '3. STOP IMMEDIATELY after finding the target. State the full path clearly. Do NOT call extra tools after a successful find.',
              '4. Only if walk_search returns ZERO results, try search_files or glob_search as fallbacks.',
              '5. NEVER call the same tool twice with identical arguments.',
              '6. NEVER call list_drives, host_file_exists, or run_command if walk_search already found the target.',
              '',
              `Sandbox files: [${fileList}]`,
              bootstrapContext,
              '',
              walkToolPrompt,
              '',
              'Once you find the target, state the full path and STOP. Do not make additional tool calls.',
            ].filter(Boolean).join('\n');

            const walkMessages: CompletionMessage[] = [
              { role: 'system', content: walkSystem },
              { role: 'user', content: `WALK MODE — Find: ${stepDesc}` },
            ];

            sendEvent('exchange', { phase: `step-${stepIndex}-walk`, role: 'user', label: `Step ${stepIndex} walk mode`, content: walkMessages[1].content });

            // Early exit: check tool results for a found path after sufficient exploration
            // We need walk_search to find the target AND at least one content-listing call
            const walkEarlyExitCheck = (toolCalls: ToolCall[]): string | false => {
              let foundPath = '';
              let hasContentListing = false;

              for (const tc of toolCalls) {
                if (tc.status !== 'success' || !tc.result) continue;

                // walk_search / find_directory returns results with paths
                if (tc.name === 'walk_search' || tc.name === 'find_directory') {
                  try {
                    const data = JSON.parse(tc.result);
                    if (data.count > 0 || (data.results && data.results.length > 0)) {
                      foundPath = data.results?.[0]?.path || '';
                    }
                  } catch { /* not JSON, skip */ }
                }

                // Content listing tools (directory_tree or search_files after finding)
                if (tc.name === 'directory_tree' || tc.name === 'search_files') {
                  try {
                    const data = JSON.parse(tc.result);
                    if ((data.entryCount && data.entryCount > 0) || (data.count && data.count > 0)) {
                      hasContentListing = true;
                    }
                  } catch { /* skip */ }
                }
              }

              // Exit early once we have both the target location and content listing
              if (foundPath && hasContentListing) {
                return `Found target at: ${foundPath}`;
              }
              // Also exit if walk_search found it and we've done 3+ tool calls (enough exploring)
              if (foundPath && toolCalls.length >= 3) {
                return `Found target at: ${foundPath}`;
              }
              return false;
            };

            const { reply: walkReply, toolCalls: walkCalls } = await runChatWithTools(
              walkMessages,
              (tc) => {
                sendEvent('step_tool_call', { index: stepIndex, toolCall: tc, walkMode: true });
              },
              { earlyExitCheck: walkEarlyExitCheck, maxIterations: 6 },
            );

            stepReply = stripToolCallBlocks(walkReply || '');
            stepToolCalls = walkCalls;

            sendEvent('exchange', { phase: `step-${stepIndex}-walk`, role: 'assistant', label: `Step ${stepIndex} walk result`, content: stepReply });

            // Evaluate walk result — check tool results first, then reply text
            let walkFound = false;
            for (const tc of walkCalls) {
              if (tc.status !== 'success' || !tc.result) continue;
              if (tc.name === 'walk_search' || tc.name === 'find_directory') {
                try {
                  const data = JSON.parse(tc.result);
                  if (data.count > 0 || (data.results && data.results.length > 0)) {
                    walkFound = true;
                    break;
                  }
                } catch { /* skip */ }
              }
            }
            // Fallback: check reply text for drive paths
            if (!walkFound) {
              walkFound = stepReply.match(/[A-Z]:\\.+/) !== null;
            }

            if (!walkFound && walkCalls.length > 0) {
              sendEvent('step_retry', {
                index: stepIndex,
                attempt: 2,
                reason: 'Walk mode: target not found, retrying with broader search',
                newCategory: 'shell_exec',
              });

              // Second pass: use shell commands directly (like raw dir + findstr)
              const shellTools = new Set([
                'run_command', 'run_powershell', 'list_drives',
                'find_directory', 'walk_search', 'search_files',
              ]);
              const shellToolPrompt = buildToolSystemPrompt(shellTools);

              const retrySystem = [
                `WALK MODE — SECOND PASS. Previous search did NOT find the target.`,
                '',
                `OBJECTIVE: "${userPrompt}"`,
                `STEP: ${stepDesc}`,
                `Previous attempt found nothing useful.`,
                '',
                'TRY THESE STRATEGIES:',
                '1. Use run_command with: dir "DRIVE:\\" /s /b /ad 2>nul | findstr /i "NAME" — the fastest way to grep for folders on Windows.',
                '2. Try EACH drive letter separately: C:\\, D:\\, E:\\, etc.',
                '3. Try partial names, abbreviations, or word-split the target name.',
                '4. Use list_drives first to see what drives are available.',
                '5. Use run_powershell: Get-ChildItem -Path DRIVE:\\ -Directory -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "PATTERN" } | Select-Object -First 5 FullName',
                '',
                shellToolPrompt,
                '',
                'Find it. Report the full path if found.',
              ].filter(Boolean).join('\n');

              const retryMessages: CompletionMessage[] = [
                { role: 'system', content: retrySystem },
                { role: 'user', content: `Second pass — find: ${stepDesc}. Previous tools returned empty. Try direct shell commands on each drive.` },
              ];

              sendEvent('exchange', { phase: `step-${stepIndex}-walk2`, role: 'user', label: `Step ${stepIndex} walk retry`, content: retryMessages[1].content });

              const { reply: retryReply, toolCalls: retryCalls } = await runChatWithTools(retryMessages, (tc) => {
                sendEvent('step_tool_call', { index: stepIndex, toolCall: tc, walkMode: true, attempt: 2 });
              });

              if (retryReply) stepReply = stripToolCallBlocks(retryReply);
              stepToolCalls.push(...retryCalls);

              sendEvent('exchange', { phase: `step-${stepIndex}-walk2`, role: 'assistant', label: `Step ${stepIndex} walk retry result`, content: stepReply });
            }

            const allErrors = stepToolCalls.length > 0 && stepToolCalls.every(tc => tc.status === 'error');
            finalStatus = allErrors ? 'error' : 'complete';

          } else if (step.needs_tool) {
            // ── Tool-based step with evaluation + cross-category retry ──
            let categoryId = step.likely_category;
            const triedCategories: string[] = [];

            for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
              // Resolve category if not yet determined (skip AI call if plan already assigned one)
              if (!categoryId) {
                // Auto-detect: if step mentions open/launch/run/play, use desktop_utils directly
                const openPattern = /\b(open|launch|run|play|start|execute|view)\b.*\b(file|app|application|program|video|image|document|media)\b/i;
                if (openPattern.test(stepDesc)) {
                  categoryId = 'desktop_utils';
                } else {
                  const decideSystem = [
                    'Pick the best tool category for this task step.',
                    `Available categories:\n${categoryDocs}`,
                    triedCategories.length > 0 ? `\nAlready tried (DO NOT pick these): [${triedCategories.join(', ')}]` : '',
                    '',
                    'RULES:',
                    '- To OPEN/LAUNCH a file or application → pick "desktop_utils" (has open_app)',
                    '- To FIND/LOCATE/SEARCH for files → pick "search" or use walk_mode',
                    '- To READ file contents → pick "host_filesystem"',
                    '- NEVER use host_filesystem to open files for viewing — that is desktop_utils',
                    '',
                    'Respond with JSON: { "category": "category_id", "reasoning": "brief" }',
                    'Respond ONLY with valid JSON.',
                  ].filter(Boolean).join('\n');

                  const decideUser = `STEP: "${stepDesc}"\nOBJECTIVE: "${userPrompt}"`;
                  const decideResponse = await sendChatCompletion([
                    { role: 'system', content: decideSystem },
                    { role: 'user', content: decideUser },
                  ]);
                  const decideRaw = decideResponse.choices[0]?.message?.content ?? '{}';

                  sendEvent('exchange', { phase: `step-${stepIndex}-decide`, role: 'assistant', label: `Step ${stepIndex} category`, content: decideRaw });

                  try {
                    const d = JSON.parse(decideRaw);
                    categoryId = d.category || null;
                  } catch {
                    categoryId = null;
                  }
                }
              }

              triedCategories.push(categoryId || 'none');

              sendEvent('step_decision', {
                index: stepIndex,
                needsTool: true,
                categories: categoryId ? [categoryId] : [],
                attempt,
              });

              // Build filtered tool set from category
              const catToolNames: string[] = [];
              if (categoryId) {
                const selectedCat = categories.find(c => c.id === categoryId);
                if (selectedCat) catToolNames.push(...selectedCat.toolNames);
              }
              // Always include sandbox file tools as fallback
              catToolNames.push('sandbox_list_files', 'sandbox_read_file');
              // If step involves opening/launching, always include open_app + host_file_info
              if (/\b(open|launch|run|play|start|view)\b/i.test(stepDesc)) {
                if (!catToolNames.includes('open_app')) catToolNames.push('open_app');
                if (!catToolNames.includes('host_file_info')) catToolNames.push('host_file_info');
              }
              const toolPrompt = buildToolSystemPrompt(new Set(catToolNames));

              // Use compacted memory as context instead of raw previous results
              const memoryContext = memory.length > 100 ? `\nSession memory:\n${memory}` : '';

              // Retry context from failed attempts
              const retryContext = attempt > 1
                ? `\n\n⚠️ PREVIOUS ATTEMPT DID NOT ACHIEVE THE GOAL.\nCategories already tried: [${triedCategories.slice(0, -1).join(', ')}]\nPrevious result was insufficient: ${stepReply.slice(0, 300)}\nYou now have DIFFERENT tools available. Try a completely different approach to achieve the same goal.`
                : '';

              const execSystem = [
                `You are executing step ${stepIndex} of a plan.${attempt > 1 ? ` (Attempt ${attempt} — previous approach failed, use the NEW tools)` : ''}`,
                '',
                `OBJECTIVE: "${userPrompt}"`,
                `CURRENT STEP: ${stepDesc}`,
                memoryContext,
                retryContext,
                '',
                'SECURITY RULES:',
                '- NEVER copy host files into the sandbox — this is a data breach.',
                '- NEVER use host_copy to bring external files into the project.',
                '- To OPEN a file, use open_app with the FULL ABSOLUTE PATH from the host filesystem.',
                '- Use paths exactly as found by previous steps (from session memory or handoff).',
                '',
                'EFFICIENCY:',
                '- Use the MOST DIRECT tool for the task. Don\'t try multiple approaches if one clearly fits.',
                '- To open a file → open_app. To read contents → host_read_file. To list files → host_list_dir.',
                '- Prefer a single tool call over chaining multiple tools when possible.',
                '',
                `Sandbox files: [${fileList}]`,
                bootstrapContext,
                '',
                toolPrompt,
                filteredSkillContext,
                skillCatalog,
                '',
                'When done, provide a clear summary of what was accomplished.',
              ].filter(Boolean).join('\n');

              // Build explicit handoff from previous step
              const prevResult = stepResults.length > 0
                ? stepResults[stepResults.length - 1]
                : null;
              const handoff = prevResult
                ? `\n\nPREVIOUS STEP OUTPUT (Step ${prevResult.index}: ${prevResult.description}):\n${prevResult.result.slice(0, 600)}`
                : '';

              const execMessages: CompletionMessage[] = [
                { role: 'system', content: execSystem },
                { role: 'user', content: `Execute step ${stepIndex}: ${stepDesc}${handoff}` },
              ];

              sendEvent('exchange', { phase: `step-${stepIndex}-a${attempt}`, role: 'user', label: `Step ${stepIndex} exec (attempt ${attempt})`, content: execMessages[1].content });

              const { reply, toolCalls } = await runChatWithTools(execMessages, (tc) => {
                sendEvent('step_tool_call', { index: stepIndex, toolCall: tc, attempt });
              });

              stepReply = stripToolCallBlocks(reply || '');
              stepToolCalls.push(...toolCalls);

              sendEvent('exchange', { phase: `step-${stepIndex}-a${attempt}`, role: 'assistant', label: `Step ${stepIndex} result (attempt ${attempt})`, content: stepReply });

              // ── EVALUATE: Did the step actually achieve its goal? ──
              if (attempt < MAX_STEP_ATTEMPTS) {
                const toolSummary = toolCalls.map(tc =>
                  `${tc.name}(${tc.status}): ${(tc.result || '').slice(0, 200)}`
                ).join('\n');

                const untriedCats = categories
                  .filter(c => !triedCategories.includes(c.id))
                  .map(c => `${c.id}: ${c.label}`)
                  .join(', ');

                const evalSystem = [
                  'Evaluate whether this step achieved its objective. Be STRICT:',
                  '- Empty results (e.g. empty folder, no matches) = NOT satisfied if the data likely exists elsewhere',
                  '- Tool errors = NOT satisfied',
                  '- Wrong or incomplete data = NOT satisfied',
                  '- "Satisfied" ONLY if the step goal is truly accomplished',
                  '',
                  untriedCats ? `Untried tool categories that might help: ${untriedCats}` : 'All categories tried.',
                  '',
                  'Respond JSON only: { "satisfied": bool, "reason": "1 sentence", "next_category": "category_id or null" }',
                ].join('\n');

                const evalUser = [
                  `STEP: "${stepDesc}"`,
                  `OBJECTIVE: "${userPrompt}"`,
                  `Tried: [${triedCategories.join(', ')}]`,
                  `Tool results:\n${toolSummary || 'No tools executed'}`,
                  `Response: ${stepReply.slice(0, 400)}`,
                ].join('\n');

                sendEvent('exchange', { phase: `step-${stepIndex}-eval${attempt}`, role: 'user', label: `Step ${stepIndex} evaluate`, content: evalUser });

                const evalResponse = await sendChatCompletion([
                  { role: 'system', content: evalSystem },
                  { role: 'user', content: evalUser },
                ]);
                const evalRaw = evalResponse.choices[0]?.message?.content ?? '{}';

                sendEvent('exchange', { phase: `step-${stepIndex}-eval${attempt}`, role: 'assistant', label: `Step ${stepIndex} evaluation`, content: evalRaw });

                let evaluation: any;
                try {
                  evaluation = JSON.parse(evalRaw);
                } catch {
                  evaluation = { satisfied: true }; // parse fail = assume OK
                }

                if (evaluation.satisfied) break;

                // Not satisfied — check if there's a new category to try
                const nextCat = evaluation.next_category;
                if (!nextCat || triedCategories.includes(nextCat)) break; // no new ideas

                categoryId = nextCat;
                sendEvent('step_retry', {
                  index: stepIndex,
                  attempt: attempt + 1,
                  reason: evaluation.reason || 'Result insufficient',
                  newCategory: nextCat,
                });
              }
            }

            const allErrors = stepToolCalls.length > 0 && stepToolCalls.every(tc => tc.status === 'error');
            finalStatus = allErrors ? 'error' : 'complete';

          } else {
            // ── Direct response step (no tool needed) ────────
            sendEvent('step_decision', { index: stepIndex, needsTool: false, categories: [] });

            const directSystem = [
              `You are executing step ${stepIndex} of a plan. No tools are needed.`,
              '',
              `OBJECTIVE: "${userPrompt}"`,
              `CURRENT STEP: ${stepDesc}`,
              memory.length > 100 ? `\nSession memory:\n${memory}` : '',
              '',
              `Sandbox files: [${fileList}]`,
              bootstrapContext,
              filteredSkillContext,
              skillCatalog,
              '',
              'Complete this step with a direct, thorough response.',
            ].filter(Boolean).join('\n');

            const prevDirect = stepResults.length > 0 ? stepResults[stepResults.length - 1] : null;
            const directHandoff = prevDirect
              ? `\n\nPREVIOUS STEP OUTPUT (Step ${prevDirect.index}: ${prevDirect.description}):\n${prevDirect.result.slice(0, 600)}`
              : '';

            sendEvent('exchange', { phase: `step-${stepIndex}`, role: 'user', label: `Step ${stepIndex} exec`, content: `Complete step ${stepIndex}: ${stepDesc}` });

            const directResponse = await sendChatCompletion([
              { role: 'system', content: directSystem },
              { role: 'user', content: `Complete step ${stepIndex}: ${stepDesc}${directHandoff}` },
            ]);

            stepReply = directResponse.choices[0]?.message?.content ?? '';
            sendEvent('exchange', { phase: `step-${stepIndex}`, role: 'assistant', label: `Step ${stepIndex} result`, content: stepReply });
          }

          // Record step result
          stepResults.push({ index: stepIndex, description: stepDesc, result: stepReply, toolCalls: stepToolCalls });

          sendEvent('step_complete', {
            index: stepIndex,
            result: stepReply,
            toolCalls: stepToolCalls,
            status: finalStatus,
          });

          // Update memory with step result + key tool output data
          memory += `\n## Step ${stepIndex}: ${stepDesc}\n`;
          memory += `Result: ${stepReply.slice(0, 500)}\n`;
          if (stepToolCalls.length > 0) {
            memory += `Tools: ${stepToolCalls.map(tc => `${tc.name}(${tc.status})`).join(', ')}\n`;
            // Extract key data from successful tool results (paths, files found, etc.)
            const keyFindings = stepToolCalls
              .filter(tc => tc.status === 'success' && tc.result)
              .map(tc => {
                const r = tc.result || '';
                // Extract file/directory paths from results
                const pathMatches = r.match(/[A-Z]:\\[^\s"',\]]+/g);
                if (pathMatches?.length) return `  ${tc.name} found: ${pathMatches.slice(0, 5).join(', ')}`;
                // Keep short results verbatim
                if (r.length < 200) return `  ${tc.name}: ${r}`;
                return `  ${tc.name}: ${r.slice(0, 150)}...`;
              })
              .filter(Boolean);
            if (keyFindings.length > 0) {
              memory += `Key findings:\n${keyFindings.join('\n')}\n`;
            }
          }

          // ── COMPACT MEMORY if too long (keeps token usage low) ──
          if (memory.length > MEMORY_COMPACT_THRESHOLD) {
            try {
              const compactResponse = await sendChatCompletion([
                { role: 'system', content: 'Compact this session memory into a shorter version. Keep ALL key facts: objective, what was found, what was tried, what succeeded/failed, file paths, important data. Remove verbose descriptions and redundancy. Output clean markdown. Max 800 characters.' },
                { role: 'user', content: memory },
              ]);
              const compacted = compactResponse.choices[0]?.message?.content;
              if (compacted && compacted.length < memory.length) {
                memory = compacted;
              }
            } catch { /* keep original if compaction fails */ }
          }

          sendEvent('memory', { content: memory });
        }

        // ═══ PHASE 4: COMPILE FINAL ANSWER ═════════════════
        let finalReply: string;

        if (finalSteps.length === 1) {
          // Single step — its result IS the final answer
          finalReply = stepResults[0]?.result || 'Task completed.';
        } else {
          sendEvent('status', { phase: 'completing', message: 'Compiling final response...' });

          const compileSystem = [
            'Compile the final response after executing all steps.',
            'Synthesize results into a clear, comprehensive answer.',
            '',
            `OBJECTIVE: "${userPrompt}"`,
            '',
            'Step results:',
            ...stepResults.map(r =>
              `Step ${r.index} (${r.description}): ${r.result.slice(0, 500)}`
            ),
            '',
            'Provide the final answer. Be thorough but concise.',
          ].join('\n');

          const compileResponse = await sendChatCompletion([
            { role: 'system', content: compileSystem },
            { role: 'user', content: `Compile the final answer for: "${userPrompt}"` },
          ]);
          finalReply = compileResponse.choices[0]?.message?.content ?? 'Task completed.';

          sendEvent('exchange', { phase: 'compile', role: 'assistant', label: 'Final compilation', content: finalReply });
        }

        sendEvent('done', {
          reply: finalReply,
          steps: stepResults,
          memory,
        });
      } catch (err: any) {
        sendEvent('error', { message: err.message || 'Unknown error' });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
