import { NextRequest } from 'next/server';
import {
  registerProvider,
  filesystemProvider,
  chromeDevToolsProvider,
  webFetchProvider,
  systemProvider,
  documentProvider,
  getToolCategories,
} from '@/lib/mcp';
import { buildToolSystemPrompt, runChatWithTools, stripToolCallBlocks } from '@/lib/tool-processor';
import { readSandboxFile, ensureSandbox, listSandboxFiles } from '@/lib/sandbox';
import { sendChatCompletion, type CompletionMessage, estimateTokens } from '@/lib/ai-client';

// Register all MCP providers
registerProvider(filesystemProvider);
registerProvider(chromeDevToolsProvider);
registerProvider(webFetchProvider);
registerProvider(systemProvider);
registerProvider(documentProvider);

// ─── Continuous mode: iterative self-driven loop ────────────────
// The model acts → we evaluate → model decides what's next → repeat
// Loop continues until the model judges the goal is met, or we hit max iterations.

const MAX_ITERATIONS = 15;
const MEMORY_COMPACT_THRESHOLD = 1500;

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

  // Skill filtering
  const allSkills: { name: string; content: string }[] = skills || [];
  const lowerPrompt = userPrompt.toLowerCase();
  const referencedSkills = new Set<string>();
  for (const s of allSkills) {
    if (lowerPrompt.includes(s.name.toLowerCase())) referencedSkills.add(s.name);
  }
  for (const s of allSkills) {
    if (!referencedSkills.has(s.name)) continue;
    const lc = s.content.toLowerCase();
    for (const other of allSkills) {
      if (other.name !== s.name && lc.includes(other.name.toLowerCase())) referencedSkills.add(other.name);
    }
  }

  const activeSkills = allSkills.filter(s => referencedSkills.has(s.name));
  const filteredSkillContext = activeSkills.length > 0
    ? `\nActive Skills (follow these instructions):\n${activeSkills.map((s) => `[Skill: ${s.name}]\n${s.content}`).join('\n---\n')}`
    : '';
  const inactiveSkills = allSkills.filter(s => !referencedSkills.has(s.name));
  const skillCatalog = inactiveSkills.length > 0
    ? `\nAvailable skills (not loaded — mention by name if needed): ${inactiveSkills.map(s => s.name).join(', ')}`
    : '';

  const categories = getToolCategories();
  const categoryDocs = categories.map((c) =>
    `- ${c.id}: ${c.label} — ${c.description} (${c.toolNames.length} tools)`
  ).join('\n');

  const toolPrompt = buildToolSystemPrompt();

  // ── SSE stream ──────────────────────────────────────────
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function sendEvent(event: string, data: any) {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      }

      try {
        // ═══ PHASE 1: BUILD SYSTEM PROMPT ════════════════════
        sendEvent('status', { phase: 'planning', message: 'Thinking about approach...' });

        const skillOverrideBlock = activeSkills.length > 0
          ? [
            '═══ ACTIVE SKILL INSTRUCTIONS (HIGHEST PRIORITY) ═══',
            ...activeSkills.map(s => `[Skill: ${s.name}]\n${s.content}`),
            '═══ END SKILL INSTRUCTIONS ═══',
            '',
          ].join('\n')
          : '';

        // Persistent system prompt used throughout the loop
        const systemPrompt = [
          'You are an AI agent that works iteratively to accomplish goals.',
          'You will be called in a LOOP. Each iteration, you:',
          '1. Review what has been done so far (from session memory)',
          '2. Decide what to do NEXT — one focused action',
          '3. Execute it (using tools if needed)',
          '4. Report what happened',
          '',
          'You will keep being called until the goal is fully achieved.',
          '',
          skillOverrideBlock,
          `OBJECTIVE: "${userPrompt}"`,
          '',
          bootstrapContext ? `ATTACHED FILES:\n${bootstrapContext}\n` : '',
          `Available tool categories:\n${categoryDocs}`,
          `Sandbox files: [${fileList}]`,
          filteredSkillContext,
          skillCatalog,
          '',
          toolPrompt,
          '',
          'RESPONSE FORMAT — use <message> and <tool_call> tags:',
          '',
          '<message>',
          'Explain what you are doing and why. Be natural and conversational.',
          'After any action, describe what happened and what you learned.',
          '</message>',
          '',
          '<tool_call>',
          '{"tool": "tool_name", "arguments": {"param": "value"}}',
          '</tool_call>',
          '',
          'RULES:',
          '- Do ONE focused action per iteration. Don\'t try to do everything at once.',
          '- ALWAYS use tools for real actions (file I/O, search, open apps, run commands). NEVER fabricate results.',
          '- If something failed, explain what went wrong and try a different approach.',
          '- If you need to find a file/folder, use walk_search or find_directory.',
          '- Be specific about what you accomplished and what remains.',
          '- Include relevant data (paths, file names, errors) in your message.',
        ].filter(Boolean).join('\n');

        // ═══ MAIN ITERATIVE LOOP ═════════════════════════════
        let memory = `# Session Memory\n**Objective:** ${userPrompt}\n`;
        let iteration = 0;
        let goalComplete = false;
        const allStepResults: { index: number; description: string; result: string; toolCalls: any[] }[] = [];

        // Send an initial dynamic plan placeholder
        sendEvent('plan', {
          steps: [{ index: 1, description: 'Starting first action...', needs_tool: true }],
          summary: `Working on: ${userPrompt}`,
        });

        sendEvent('status', { phase: 'executing', message: 'Starting...' });

        while (iteration < MAX_ITERATIONS && !goalComplete) {
          iteration++;

          // ── Build the iteration prompt ─────────────────
          const iterationPrompt = iteration === 1
            ? `Begin working on the objective. What is the FIRST thing you need to do?\n\nOBJECTIVE: "${userPrompt}"`
            : [
              `Continue working on the objective. Here is what has happened so far:`,
              '',
              memory,
              '',
              'What is the NEXT action you need to take? If the objective is fully achieved, say so clearly.',
              'If something failed in a previous step, try a DIFFERENT approach.',
            ].join('\n');

          // Emit step_start for this iteration
          sendEvent('step_start', { index: iteration, description: `Iteration ${iteration}` });
          sendEvent('status', {
            phase: 'executing',
            message: `Iteration ${iteration}`,
            stepIndex: iteration,
            totalSteps: iteration,
          });

          // Run the model with tool access
          const messages: CompletionMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: iterationPrompt },
          ];

          sendEvent('exchange', {
            phase: `iteration-${iteration}`,
            role: 'user',
            label: `Iteration ${iteration} prompt`,
            content: iterationPrompt,
          });

          const { reply, toolCalls } = await runChatWithTools(messages, (tc) => {
            sendEvent('step_tool_call', { index: iteration, toolCall: tc });
          }, { maxIterations: 8 });

          const cleanReply = stripToolCallBlocks(reply || '');

          sendEvent('exchange', {
            phase: `iteration-${iteration}`,
            role: 'assistant',
            label: `Iteration ${iteration} result`,
            content: cleanReply,
          });

          // Step description from reply (first meaningful line)
          const stepDescription = cleanReply.split('\n').find(l => l.trim().length > 0)?.slice(0, 120) || `Action ${iteration}`;

          // Mark step complete in UI
          const hasErrors = toolCalls.length > 0 && toolCalls.every(tc => tc.status === 'error');
          sendEvent('step_complete', {
            index: iteration,
            result: cleanReply,
            toolCalls: toolCalls,
            status: hasErrors ? 'error' : 'complete',
          });

          // Record result
          allStepResults.push({
            index: iteration,
            description: stepDescription,
            result: cleanReply,
            toolCalls: toolCalls,
          });

          // ── Update memory ──────────────────────────────
          memory += `\n## Iteration ${iteration}: ${stepDescription}\n`;
          if (toolCalls.length > 0) {
            memory += `Tools used: ${toolCalls.map(tc => `${tc.name}(${tc.status})`).join(', ')}\n`;
            const keyFindings = toolCalls
              .filter(tc => tc.status === 'success' && tc.result)
              .map(tc => {
                const r = tc.result || '';
                // Extract paths from results
                const pathMatches = r.match(/[A-Za-z]:\\[^\s"',\]]+/g) || r.match(/\/[^\s"',\]]+/g);
                if (pathMatches?.length) return `  ${tc.name} found: ${pathMatches.slice(0, 5).join(', ')}`;
                if (r.length < 200) return `  ${tc.name}: ${r}`;
                return `  ${tc.name}: ${r.slice(0, 150)}...`;
              })
              .filter(Boolean);
            if (keyFindings.length > 0) memory += `Key findings:\n${keyFindings.join('\n')}\n`;
          }
          memory += `Response: ${cleanReply.slice(0, 400)}\n`;

          sendEvent('memory', { content: memory });

          // ── Compact memory if too long ─────────────────
          if (estimateTokens(memory) > MEMORY_COMPACT_THRESHOLD) {
            try {
              const compactResponse = await sendChatCompletion([
                {
                  role: 'system',
                  content: 'Compact this session memory into a shorter version. Keep ALL key facts: objective, what was found, what was tried, what succeeded/failed, file paths, important data. Remove verbose descriptions and redundancy. Output clean markdown. Max 800 characters.',
                },
                { role: 'user', content: memory },
              ]);
              const compacted = compactResponse.choices[0]?.message?.content;
              if (compacted && compacted.length < memory.length) {
                memory = compacted;
                sendEvent('memory', { content: memory });
              }
            } catch { /* keep original if compaction fails */ }
          }

          // ── GOAL CHECK: Is the objective met? ──────────
          sendEvent('status', {
            phase: 'executing',
            message: `Checking if goal is complete...`,
            stepIndex: iteration,
            totalSteps: iteration,
          });

          const goalCheckResponse = await sendChatCompletion([
            {
              role: 'system',
              content: [
                'You evaluate whether a user\'s objective has been FULLY accomplished based on the work done.',
                '',
                'RULES:',
                '- "complete" = the objective is fully achieved with concrete evidence (file opened, command ran, content generated, etc.)',
                '- "not_complete" = more work is needed, or something failed that wasn\'t retried differently',
                '- If the model said it will do something but hasn\'t actually done it yet → not_complete',
                '- If a tool failed and no alternative was tried → not_complete',
                '- If the task is pure text generation and the text was generated → complete',
                '- Only "complete" if there is CONCRETE evidence of success.',
                '',
                'Respond with JSON ONLY:',
                '{ "status": "complete" | "not_complete", "reason": "brief explanation", "next_suggestion": "what to try next if not complete, or null" }',
              ].join('\n'),
            },
            {
              role: 'user',
              content: [
                `OBJECTIVE: "${userPrompt}"`,
                '',
                `WORK DONE SO FAR:`,
                memory,
                '',
                `LATEST ITERATION RESULT:`,
                cleanReply.slice(0, 600),
                toolCalls.length > 0
                  ? `\nTool outcomes: ${toolCalls.map(tc => `${tc.name}(${tc.status}): ${(tc.result || '').slice(0, 200)}`).join('; ')}`
                  : '',
              ].join('\n'),
            },
          ]);

          const goalRaw = goalCheckResponse.choices[0]?.message?.content ?? '{}';

          sendEvent('exchange', {
            phase: `goal-check-${iteration}`,
            role: 'assistant',
            label: `Goal check after iteration ${iteration}`,
            content: goalRaw,
          });

          let goalResult: any;
          try {
            // Try to extract JSON from the response (model may wrap it in markdown)
            const jsonMatch = goalRaw.match(/\{[\s\S]*\}/);
            goalResult = jsonMatch ? JSON.parse(jsonMatch[0]) : { status: 'not_complete', reason: 'Could not parse goal check' };
          } catch {
            goalResult = { status: 'not_complete', reason: 'Could not parse goal check', next_suggestion: 'Continue working' };
          }

          if (goalResult.status === 'complete') {
            goalComplete = true;
            sendEvent('status', { phase: 'completing', message: 'Goal achieved! Compiling final response...' });
          } else {
            // Feed the suggestion back so the model knows what to try next
            if (goalResult.next_suggestion) {
              memory += `\n**Next:** ${goalResult.next_suggestion}\n`;
            }
            if (goalResult.reason) {
              memory += `**Why not done:** ${goalResult.reason}\n`;
            }
          }
        }

        // ═══ FINAL RESPONSE ═══════════════════════════════
        let finalReply: string;

        if (allStepResults.length === 1) {
          // Single iteration — just use the reply directly
          finalReply = allStepResults[0].result;
        } else {
          // Multiple iterations — compile a summary
          const stepSummaries = allStepResults.map(r =>
            `Iteration ${r.index}: ${r.result.slice(0, 400)}`
          );
          const compilePrompt = [
            'Compile a final response summarizing everything that was done.',
            'Be natural and conversational. Describe what was accomplished.',
            '',
            `OBJECTIVE: "${userPrompt}"`,
            '',
            'Work performed:',
            ...stepSummaries,
            '',
            goalComplete
              ? 'The objective was achieved successfully.'
              : `Stopped after ${MAX_ITERATIONS} iterations. Report what was and wasn't accomplished.`,
          ].join('\n');

          const compileResponse = await sendChatCompletion([
            { role: 'system', content: compilePrompt },
            { role: 'user', content: `Summarize what was done for: "${userPrompt}"` },
          ]);
          finalReply = compileResponse.choices[0]?.message?.content ?? 'Task completed.';
        }

        sendEvent('done', {
          reply: finalReply,
          steps: allStepResults,
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
