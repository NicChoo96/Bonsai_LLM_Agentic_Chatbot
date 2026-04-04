import { getAllTools, executeTool } from './mcp/registry';
import { sendChatCompletion, type CompletionMessage, AI_CONTEXT_LIMIT, estimateMessagesTokens, compactMessages, truncateToTokens } from './ai-client';
import type { ToolCall } from '@/types';

// ─── Constants ───────────────────────────────────────────────────
const MAX_TOOL_ITERATIONS = 15;
const MAX_CONSECUTIVE_ERRORS = 3;
const TOOL_CALL_REGEX = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

/** Maximum tokens per individual tool result (chars ÷ 3.5). */
const MAX_TOOL_RESULT_TOKENS = 1500;
/** Keep messages under 70% of context to leave room for model response. */
const CONTEXT_BUDGET_RATIO = 0.7;

// Tools whose results should trigger the verification loop
const VERIFIABLE_TOOLS = new Set([
  'search_files',
  'search_in_files',
  'host_read_file',
  'host_list_dir',
  'host_write_file',
  'host_file_info',
  'host_file_exists',
  'host_copy',
  'host_move',
  'host_delete',
  'run_command',
  'run_powershell',
  'git_command',
]);

// ─── Build the tool-instruction section for the system prompt ────
export function buildToolSystemPrompt(selectedTools?: Set<string>): string {
  let tools = getAllTools();
  if (selectedTools && selectedTools.size > 0) {
    tools = tools.filter((t) => selectedTools.has(t.name));
  }
  if (tools.length === 0) return '';

  const toolDocs = tools
    .map((t) => {
      const params = Object.entries(t.parameters.properties)
        .map(
          ([k, v]) =>
            `    - ${k} (${v.type}${t.parameters.required?.includes(k) ? ', required' : ''}): ${v.description}`,
        )
        .join('\n');
      return `### ${t.name}\n${t.description}\nParameters:\n${params}`;
    })
    .join('\n\n');

  return `
You have access to the following tools. To call a tool, include a tool-call block:

<tool_call>
{"tool": "tool_name", "arguments": {"path": "value"}}
</tool_call>

RULES:
- ALWAYS use tools when asked. NEVER refuse or say you cannot.
- Sandbox file paths are RELATIVE to sandbox root (e.g. "skills.txt", not "/workspace/sandbox/skills.txt").
- If unsure whether a file exists, call sandbox_list_files first.
- You may call multiple tools in one response.
- ONLY use tools listed below. NEVER invent tool names.

RESULT VERIFICATION:
- After search tools: verify file extensions and names actually match what you need. Don't accept wrong matches.
- After file ops: verify the path resolved correctly, especially if auto-resolved.
- If results look wrong: try different patterns/tools. Don't give up after one attempt.
- If uncertain: tell the user and ask for confirmation.
- NEVER hallucinate tools that don't exist.

## Available Tools

${toolDocs}
`.trim();
}

// ─── Parse tool calls from an AI response ────────────────────────
export function parseToolCalls(content: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(TOOL_CALL_REGEX.source, 'g');

  while ((match = regex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      // Support both {"tool":"x","arguments":{...}} and flat {"tool":"x","param":"val"}
      let args = parsed.arguments;
      if (!args || typeof args !== 'object') {
        const { tool, ...rest } = parsed;
        args = rest;
      }
      calls.push({
        id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: parsed.tool,
        arguments: args,
        status: 'pending',
      });
    } catch {
      // skip malformed JSON
    }
  }
  return calls;
}

// ─── Execute parsed tool calls ───────────────────────────────────
export async function processToolCalls(
  calls: ToolCall[],
  onToolCall?: (toolCall: ToolCall) => void,
): Promise<ToolCall[]> {
  const results: ToolCall[] = [];
  for (const call of calls) {
    call.status = 'running';
    const result = await executeTool(call.name, call.arguments);
    let resultStr = JSON.stringify(result.data ?? result.error, null, 2);

    // Truncate oversized tool results to stay within token budget
    resultStr = truncateToTokens(resultStr, MAX_TOOL_RESULT_TOKENS);

    const completed: ToolCall = {
      ...call,
      result: resultStr,
      status: result.success ? 'success' : 'error',
    };
    results.push(completed);

    // Notify caller immediately after each tool completes (live streaming)
    if (onToolCall) onToolCall(completed);
  }
  return results;
}

// ─── Strip tool-call XML blocks from visible content ─────────────
export function stripToolCallBlocks(content: string): string {
  return content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
}

// ─── Build error-recovery prompt for failed tool calls ──────────
function buildErrorRecoveryPrompt(executed: ToolCall[]): string {
  const errors = executed.filter((tc) => tc.status === 'error');
  if (errors.length === 0) return '';

  const errorDetails = errors
    .map(
      (tc) =>
        `- Tool "${tc.name}" with args ${JSON.stringify(tc.arguments)} FAILED:\n  ${tc.result}`,
    )
    .join('\n');

  return [
    '',
    '═══ TOOL ERROR — RECOVERY REQUIRED ═══',
    'One or more tool calls failed. You MUST NOT give up or stop.',
    '',
    'Failed calls:',
    errorDetails,
    '',
    'RECOVERY STEPS — follow these in order:',
    '1. ANALYZE: Why did the tool fail? Wrong name, wrong args, missing file, wrong path?',
    '2. REASON: What alternative tool or approach can achieve the same goal?',
    '3. ACT: Make a new tool call using a corrected approach.',
    '',
    'Common recovery strategies:',
    '- UNKNOWN TOOL → You invented a tool that does not exist! ONLY use tools listed in your prompt.',
    '  → For random selection, listing files, opening files, or any custom logic: use run_python with standard Python (os.listdir, random.sample, os.startfile, etc.)',
    '  → run_python runs STANDALONE Python — do NOT call MCP tools (host_list_dir, open_app) from inside Python scripts.',
    '- Wrong tool name → check available tools list and use the correct one',
    '- Wrong path → use sandbox_list_files to discover the correct path first',
    '- Missing file → create it, or check if a differently-named file exists',
    '- Permission/capability error → try an alternative tool that achieves the same thing',
    '- Malformed args → re-read the tool parameter docs and fix the arguments',
    '',
    'Do NOT apologize or explain failure to the user. Just try again with a better approach.',
    '═══════════════════════════════════════',
  ].join('\n');
}

// ─── Build verification prompt for tool results ─────────────────
function buildVerificationPrompt(executed: ToolCall[]): string {
  const checks: string[] = [];

  for (const tc of executed) {
    const result = tc.result || '';
    const args = tc.arguments || {};

    // Catch unknown/invented tool names — these won't be in VERIFIABLE_TOOLS
    if (tc.status === 'error' && result.includes('Unknown tool:')) {
      checks.push(
        `🚫 UNKNOWN TOOL: "${tc.name}" does not exist! You invented this tool.\n` +
        `   → Use ONLY tools listed in your system prompt.\n` +
        `   → For custom logic (random selection, batch ops, filtering): use run_python with standard Python.\n` +
        `   → Example: run_python with script "import os, random; files = os.listdir(r'E:\\\\path'); print(random.choice(files))"`,
      );
      continue;
    }

    if (!VERIFIABLE_TOOLS.has(tc.name)) continue;

    if (tc.status === 'error') {
      checks.push(
        `⚠️ TOOL FAILED: "${tc.name}" returned an error: ${result}\n` +
        `   → This tool does not exist or the arguments were wrong.\n` +
        `   → Do NOT retry with the same tool name. Check the available tools list and use a correct one.`,
      );
      continue;
    }

    // Search tools: verify the results actually match what was sought
    if (tc.name === 'search_files' || tc.name === 'search_in_files') {
      const pattern = (args as any).pattern || (args as any).text || '';
      checks.push(
        `🔍 VERIFY "${tc.name}" (pattern: "${pattern}"): Do results actually match? Check extensions, names, locations.`,
      );
    }

    // Read: verify the content is what was expected
    if (tc.name === 'host_read_file') {
      const wasAutoResolved = result.includes('Auto-resolved');
      if (wasAutoResolved) {
        checks.push(`📄 VERIFY READ: Path was auto-resolved — confirm it's the right file.`);
      }
    }

    // List dir: verify the directory is correct
    if (tc.name === 'host_list_dir') {
      const wasAutoResolved = result.includes('Auto-resolved') || result.includes('candidates');
      if (wasAutoResolved) {
        checks.push(`📁 VERIFY DIR: Directory was auto-resolved — confirm correct location.`);
      }
    }
  }

  if (checks.length === 0) return '';

  return [
    '',
    '── VERIFY RESULTS ──',
    ...checks,
    'If any result is wrong: try a different approach. If all correct: continue.',
    '────────────────────',
  ].join('\n');
}

// ─── Fingerprint a tool call for dedup ───────────────────────────
function toolCallFingerprint(tc: ToolCall): string {
  return `${tc.name}::${JSON.stringify(tc.arguments)}`;
}

/** Key for success dedup — tool name + primary path/target arg (ignores flags like recursive, max_depth) */
function toolCallBaseKey(tc: ToolCall): string {
  const args = tc.arguments || {};
  const primaryArg = (args as any).path || (args as any).name || (args as any).directory || (args as any).pattern || '';
  return `${tc.name}::${primaryArg}`;
}

// ─── Main chat-with-tools loop ───────────────────────────────────
export async function runChatWithTools(
  messages: CompletionMessage[],
  onToolCall?: (toolCall: ToolCall) => void,
  options?: {
    /** Check after each iteration; if it returns a truthy string, exit early with that as reply. */
    earlyExitCheck?: (toolCalls: ToolCall[]) => string | false;
    /** Override the default max iterations (15). */
    maxIterations?: number;
    /** Called after dedup, before execution. Can modify/filter/cancel proposed tool calls.
     *  Receives proposed calls + all previous calls for context. Returns the calls to actually execute. */
    beforeExecute?: (proposed: ToolCall[], allPrevious: ToolCall[]) => Promise<ToolCall[]>;
  },
): Promise<{ reply: string; toolCalls: ToolCall[] }> {
  const allToolCalls: ToolCall[] = [];
  let consecutiveErrors = 0;
  let consecutiveDedupRounds = 0; // Track rounds where ALL calls were deduped
  const tokenBudget = Math.floor(AI_CONTEXT_LIMIT * CONTEXT_BUDGET_RATIO);
  const maxIter = options?.maxIterations ?? MAX_TOOL_ITERATIONS;
  /** Track tool calls that already failed — skip if retried with identical args */
  const failedFingerprints = new Map<string, string>(); // fingerprint → error message
  /** Track successful tool calls by base key (tool+path) — return cached result instead of re-executing */
  const successCache = new Map<string, ToolCall>(); // baseKey → completed ToolCall

  for (let i = 0; i < maxIter; i++) {
    // ── Proactive compaction: ensure messages fit within context ──
    const currentTokens = estimateMessagesTokens(messages);
    if (currentTokens > tokenBudget) {
      messages = await compactMessages(messages, tokenBudget);
    }

    const response = await sendChatCompletion(messages);
    const assistantContent = response.choices[0]?.message?.content ?? '';

    const parsed = parseToolCalls(assistantContent);

    if (parsed.length === 0) {
      // No more tool calls – return the final reply
      return { reply: assistantContent, toolCalls: allToolCalls };
    }

    // ── Dedup: skip tool calls that already failed with identical args ──
    // ── Also skip SUCCESS calls to the same tool+path (AI re-calling with different flags) ──
    const deduped: ToolCall[] = [];
    const skippedErrors: ToolCall[] = [];
    const cachedResults: ToolCall[] = [];
    for (const tc of parsed) {
      const fp = toolCallFingerprint(tc);
      const baseKey = toolCallBaseKey(tc);

      // Check failed dedup first (exact match)
      const prevError = failedFingerprints.get(fp);
      if (prevError) {
        const skipped: ToolCall = {
          ...tc,
          status: 'error',
          result: `SKIPPED (identical call already failed): ${prevError}`,
        };
        skippedErrors.push(skipped);
        if (onToolCall) onToolCall(skipped);
        continue;
      }

      // Check success dedup (same tool + primary arg, even if flags differ)
      const prevSuccess = successCache.get(baseKey);
      if (prevSuccess) {
        const cached: ToolCall = {
          ...tc,
          status: 'success',
          result: `CACHED (this tool already returned data for this path — use the results you already have):\n${(prevSuccess.result || '').slice(0, 500)}`,
        };
        cachedResults.push(cached);
        if (onToolCall) onToolCall(cached);
        continue;
      }

      deduped.push(tc);
    }

    // If ALL calls were deduped away, the model is stuck
    if (deduped.length === 0 && (skippedErrors.length > 0 || cachedResults.length > 0)) {
      consecutiveDedupRounds++;
      allToolCalls.push(...skippedErrors, ...cachedResults);

      // After 2 consecutive all-dedup rounds, HARD STOP — synthesize reply from cached data
      if (consecutiveDedupRounds >= 2) {
        const cachedData = [...successCache.values()]
          .map(tc => `[${tc.name}] ${(tc.result || '').slice(0, 800)}`)
          .join('\n\n');
        return {
          reply: cachedData
            ? `Data already retrieved:\n${cachedData}`
            : stripToolCallBlocks(assistantContent) || 'All tool calls were duplicates. Stopping.',
          toolCalls: allToolCalls,
        };
      }

      // First dedup round: give the AI ONE more chance with a strong "use what you have" instruction
      if (cachedResults.length > 0) {
        messages.push({ role: 'assistant', content: assistantContent });
        const cachedContent = cachedResults
          .map(tc => `[Tool Result: ${tc.name}] (status: ${tc.status})\n${tc.result}`)
          .join('\n\n');
        messages.push({
          role: 'user',
          content: [
            `Tool results:\n\n${cachedContent}`,
            '',
            '═══ DUPLICATE TOOL CALL DETECTED ═══',
            'You already have this data from a previous call. Do NOT call this tool again.',
            'Use the data you already received to complete the task.',
            'If you need to select random items, just pick from the list above.',
            'Respond with your final answer NOW — no more tool calls.',
            '═══════════════════════════════════════',
          ].join('\n'),
        });
        continue;
      }
      return {
        reply: stripToolCallBlocks(assistantContent) || 'All tool calls were duplicates of previous failures. Stopping to avoid an infinite loop.',
        toolCalls: allToolCalls,
      };
    }

    // Reset dedup counter when there are new (non-deduped) calls
    consecutiveDedupRounds = 0;

    // ── beforeExecute hook: review/modify proposed calls before running them ──
    let toExecute = deduped;
    if (options?.beforeExecute && deduped.length > 0) {
      try {
        toExecute = await options.beforeExecute(deduped, allToolCalls);
        // If review cancelled all calls, feed back as errors so the LLM can retry with a different approach
        if (toExecute.length === 0) {
          const cancelledCalls = deduped.map(tc => ({
            ...tc,
            status: 'error' as const,
            result: (tc as any)._skipReason
              ? `PRE-EXECUTION REVIEW REJECTED: ${(tc as any)._skipReason}`
              : 'Tool call rejected by pre-execution review.',
          }));
          allToolCalls.push(...cancelledCalls);
          if (onToolCall) cancelledCalls.forEach(tc => onToolCall(tc));

          // Feed results back to the conversation so the LLM can try a different approach
          const resultContent = cancelledCalls
            .map(tc => `[Tool Result: ${tc.name}] (status: ${tc.status})\n${tc.result}`)
            .join('\n\n');
          messages.push({ role: 'assistant', content: assistantContent });
          messages.push({
            role: 'user',
            content: [
              `Tool results:\n\n${resultContent}`,
              '',
              '═══ TOOL CALLS REJECTED BY REVIEW ═══',
              'Your proposed tool calls were rejected. Read the reasons above.',
              'Try a DIFFERENT approach or fix the arguments and try again.',
              '═══════════════════════════════════════',
            ].join('\n'),
          });
          continue; // retry the loop instead of returning
        }
      } catch {
        // If review itself fails, proceed with original calls
        toExecute = deduped;
      }
    }

    // Execute tool calls — onToolCall fires immediately per tool completion
    const executed = await processToolCalls(toExecute, onToolCall);
    executed.push(...skippedErrors, ...cachedResults); // include deduped for context
    allToolCalls.push(...executed);

    // Track newly failed calls for future dedup
    for (const tc of executed) {
      if (tc.status === 'error' && !cachedResults.includes(tc)) {
        failedFingerprints.set(toolCallFingerprint(tc), (tc.result || 'unknown error').slice(0, 200));
      }
    }

    // Track successful calls for success dedup
    for (const tc of deduped) {
      if (tc.status === 'success') {
        const baseKey = toolCallBaseKey(tc);
        if (!successCache.has(baseKey)) {
          successCache.set(baseKey, tc);
        }
      }
    }

    // Early exit check (e.g. walk mode found its target)
    if (options?.earlyExitCheck) {
      const exitReply = options.earlyExitCheck(allToolCalls);
      if (exitReply) {
        return { reply: exitReply, toolCalls: allToolCalls };
      }
    }

    // Check if any calls errored
    const hasErrors = executed.some((tc) => tc.status === 'error');
    const allErrors = executed.every((tc) => tc.status === 'error');

    if (allErrors) {
      consecutiveErrors++;
    } else {
      consecutiveErrors = 0;
    }

    // If we've had too many consecutive all-error rounds, STOP — don't keep looping
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      // Build a meaningful reply from any successful calls we did get
      const successes = allToolCalls.filter(tc => tc.status === 'success');
      const successSummary = successes.length > 0
        ? `Partial results from successful calls:\n${successes.map(tc => `- ${tc.name}: ${(tc.result || '').slice(0, 300)}`).join('\n')}`
        : 'No tools succeeded.';
      return {
        reply: `Stopped after ${MAX_CONSECUTIVE_ERRORS} consecutive failures. ${successSummary}`,
        toolCalls: allToolCalls,
      };
    }

    // Feed assistant response + tool results back into the conversation
    messages.push({ role: 'assistant', content: assistantContent });

    const toolResultContent = executed
      .map(
        (tc) =>
          `[Tool Result: ${tc.name}] (status: ${tc.status})\n${tc.result}`,
      )
      .join('\n\n');

    // Build verification prompt for verifiable tools
    const verificationPrompt = buildVerificationPrompt(executed);

    // Build error recovery prompt if any tools failed
    const errorRecoveryPrompt = hasErrors ? buildErrorRecoveryPrompt(executed) : '';

    messages.push({
      role: 'user',
      content: `Tool results:\n\n${toolResultContent}${verificationPrompt}${errorRecoveryPrompt}`,
    });
  }

  // Safety: if we hit the iteration limit, return what we have
  return {
    reply: 'I reached the maximum number of tool-call iterations. Here are the results so far.',
    toolCalls: allToolCalls,
  };
}
