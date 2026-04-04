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
import { buildToolSystemPrompt, runChatWithTools, stripToolCallBlocks } from '@/lib/tool-processor';
import { readSandboxFile, ensureSandbox, listSandboxFiles } from '@/lib/sandbox';
import { sendChatCompletion, type CompletionMessage } from '@/lib/ai-client';

// Register all MCP providers
registerProvider(filesystemProvider);
registerProvider(chromeDevToolsProvider);
registerProvider(webFetchProvider);
registerProvider(systemProvider);
registerProvider(documentProvider);

// ─── Continuous mode: single-shot iterate ────────────────────────
// Each call does: elaborate → gather → act → summarize
// Client calls repeatedly until objective is achieved.

const MAX_TOOL_ITERATIONS = 20;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      userPrompt,        // The original user objective
      iteration,         // Current iteration number (1-based)
      memory,            // Current MEMORY.md content
      previousSummary,   // Summary from last iteration
      selectedFiles,
      skills,
    } = body as {
      userPrompt: string;
      iteration: number;
      memory: string;
      previousSummary: string;
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
        } catch { /* skip unreadable files */ }
      }
      if (fileContents.length) {
        bootstrapContext = `\nSelected file contents:\n\n${fileContents.join('\n\n')}`;
      }
    }

    // All tools available
    const allTools = getAllTools();
    const toolPrompt = buildToolSystemPrompt();

    const skillContext = (skills || []).length > 0
      ? `\nLoaded Skills:\n${skills.map((s) => `[Skill: ${s.name}]\n${s.content}`).join('\n---\n')}`
      : '';

    // ═══════════ STEP 1: ELABORATE + GATHER + PLAN (single shot) ═══════════
    const thinkSystem = [
      'You are an autonomous AI agent working to achieve an objective. You operate in iterative loops.',
      'Each iteration you: think about what to do next, then act using tools, then report progress.',
      '',
      `OBJECTIVE: "${userPrompt}"`,
      '',
      memory ? `MEMORY (your persistent notes from previous iterations):\n${memory}\n` : '',
      previousSummary ? `PREVIOUS ITERATION SUMMARY:\n${previousSummary}\n` : '',
      `This is iteration ${iteration}.`,
      '',
      `Sandbox files: [${fileList}]`,
      bootstrapContext,
      '',
      'Analyze the current state and decide what to do next.',
      'Respond with JSON:',
      '{',
      '  "thinking": "your analysis of current state and what needs to happen next",',
      '  "tools_needed": ["list", "of", "tool_names"] or [],',
      '  "next_actions": "describe the concrete actions you will take this iteration",',
      '  "is_complete": false/true — set true ONLY if the objective is FULLY achieved,',
      '  "completion_message": "final answer to user if is_complete is true"',
      '}',
      'Respond ONLY with valid JSON.',
    ].filter(Boolean).join('\n');

    const thinkMessages: CompletionMessage[] = [
      { role: 'system', content: thinkSystem },
      { role: 'user', content: `Iteration ${iteration}: What should we do next to achieve: "${userPrompt}"` },
    ];

    const thinkResponse = await sendChatCompletion(thinkMessages);
    const thinkRaw = thinkResponse.choices[0]?.message?.content ?? '{}';

    let thinking: any;
    try {
      thinking = JSON.parse(thinkRaw);
    } catch {
      thinking = { thinking: thinkRaw, tools_needed: [], next_actions: thinkRaw, is_complete: false };
    }

    // If the agent says the objective is complete, return immediately
    if (thinking.is_complete) {
      // Update memory with completion
      const completionMemory = await updateMemory(
        memory,
        userPrompt,
        iteration,
        thinking.thinking || '',
        thinking.completion_message || 'Objective achieved.',
        [],
      );

      return NextResponse.json({
        iteration,
        status: 'complete',
        thinking: thinking.thinking || '',
        actions: thinking.next_actions || '',
        reply: thinking.completion_message || 'Objective achieved.',
        toolCalls: [],
        summary: `Completed in ${iteration} iteration(s). ${thinking.completion_message || ''}`,
        memory: completionMemory,
        thinkPrompt: thinkSystem,
        thinkResponse: thinkRaw,
      });
    }

    // ═══════════ STEP 2: EXECUTE with tools ════════════════════════
    const actSystem = [
      'You are an autonomous AI agent executing actions to achieve an objective.',
      '',
      `OBJECTIVE: "${userPrompt}"`,
      '',
      `PLAN FOR THIS ITERATION:\n${thinking.next_actions || thinking.thinking || 'Proceed with the task.'}`,
      '',
      memory ? `MEMORY:\n${memory}\n` : '',
      previousSummary ? `PREVIOUS ITERATION RESULT:\n${previousSummary}\n` : '',
      '',
      `Sandbox files: [${fileList}]`,
      bootstrapContext,
      '',
      toolPrompt,
      skillContext,
      '',
      'Execute your plan. Use tools as needed. If a tool fails, try a different approach.',
      'After completing your actions, provide a clear summary of what you accomplished.',
    ].filter(Boolean).join('\n');

    const actMessages: CompletionMessage[] = [
      { role: 'system', content: actSystem },
      { role: 'user', content: `Execute iteration ${iteration} plan: ${thinking.next_actions || 'Proceed with the objective.'}` },
    ];

    const { reply: actReply, toolCalls } = await runChatWithTools(actMessages);

    // ═══════════ STEP 3: SUMMARIZE this iteration ═════════════════
    const hasErrors = toolCalls.some(tc => tc.status === 'error');
    const successCalls = toolCalls.filter(tc => tc.status === 'success');
    const errorCalls = toolCalls.filter(tc => tc.status === 'error');

    const summarizeSystem = [
      'Summarize this iteration into a concise paragraph. Include:',
      '1. What was attempted',
      '2. What succeeded',
      '3. What failed (if anything)',
      '4. What should happen next',
      '',
      'Also decide: is the overall objective complete?',
      '',
      'Respond with JSON:',
      '{',
      '  "summary": "concise paragraph of what happened",',
      '  "is_complete": true/false,',
      '  "progress_pct": 0-100 estimate,',
      '  "next_suggestion": "what the next iteration should do"',
      '}',
      'Respond ONLY with valid JSON.',
    ].join('\n');

    const summarizeUser = [
      `OBJECTIVE: "${userPrompt}"`,
      `ITERATION: ${iteration}`,
      `THINKING: ${thinking.thinking || ''}`,
      `PLANNED: ${thinking.next_actions || ''}`,
      `TOOLS CALLED: ${toolCalls.map(tc => `${tc.name}(${tc.status})`).join(', ') || 'none'}`,
      errorCalls.length > 0 ? `ERRORS: ${errorCalls.map(tc => `${tc.name}: ${(tc.result || '').slice(0, 100)}`).join('; ')}` : '',
      `AGENT REPLY: ${(actReply || '').slice(0, 500)}`,
    ].filter(Boolean).join('\n');

    const summarizeResponse = await sendChatCompletion([
      { role: 'system', content: summarizeSystem },
      { role: 'user', content: summarizeUser },
    ]);
    const summarizeRaw = summarizeResponse.choices[0]?.message?.content ?? '{}';

    let summary: any;
    try {
      summary = JSON.parse(summarizeRaw);
    } catch {
      summary = { summary: summarizeRaw, is_complete: false, progress_pct: 0, next_suggestion: '' };
    }

    // ═══════════ STEP 4: UPDATE MEMORY ════════════════════════════
    const updatedMemory = await updateMemory(
      memory,
      userPrompt,
      iteration,
      thinking.thinking || '',
      summary.summary || actReply || '',
      toolCalls,
    );

    return NextResponse.json({
      iteration,
      status: summary.is_complete ? 'complete' : (hasErrors && successCalls.length === 0 ? 'error' : 'progress'),
      thinking: thinking.thinking || '',
      actions: thinking.next_actions || '',
      reply: stripToolCallBlocks(actReply || ''),
      toolCalls,
      summary: summary.summary || '',
      progressPct: summary.progress_pct || 0,
      nextSuggestion: summary.next_suggestion || '',
      isComplete: !!summary.is_complete,
      memory: updatedMemory,
      // Exchange data for session panel
      thinkPrompt: thinkSystem,
      thinkResponse: thinkRaw,
      actPrompt: actSystem,
      actResponse: actReply,
      summarizePrompt: summarizeSystem,
      summarizeResponse: summarizeRaw,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ─── Memory updater ──────────────────────────────────────────────
async function updateMemory(
  currentMemory: string,
  objective: string,
  iteration: number,
  thinking: string,
  result: string,
  toolCalls: any[],
): Promise<string> {
  const toolSummary = toolCalls.length > 0
    ? toolCalls.map(tc => `- ${tc.name}: ${tc.status}`).join('\n')
    : '- No tools used';

  const newEntry = [
    `## Iteration ${iteration}`,
    `**Thinking:** ${thinking.slice(0, 200)}`,
    `**Result:** ${result.slice(0, 300)}`,
    `**Tools:**\n${toolSummary}`,
  ].join('\n');

  if (!currentMemory) {
    return [
      `# Session Memory`,
      `**Objective:** ${objective}`,
      `**Started:** ${new Date().toISOString()}`,
      '',
      newEntry,
    ].join('\n');
  }

  // Ask model to condense memory if getting long (>2000 chars)
  const combined = `${currentMemory}\n\n${newEntry}`;
  if (combined.length < 2000) {
    return combined;
  }

  // Condense
  const condenseResponse = await sendChatCompletion([
    {
      role: 'system',
      content: [
        'You are a memory manager. Condense the following session memory into a shorter version.',
        'Keep: the objective, key findings, current state, important decisions, errors encountered.',
        'Remove: redundant details, duplicate information, verbose descriptions.',
        'The latest iteration entry should be kept in full detail.',
        'Output the condensed memory as markdown. Start with # Session Memory.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: combined,
    },
  ]);

  return condenseResponse.choices[0]?.message?.content ?? combined;
}
