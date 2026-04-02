import { getAllTools, executeTool } from './mcp/registry';
import { sendChatCompletion, type CompletionMessage } from './ai-client';
import type { ToolCall } from '@/types';

// ─── Constants ───────────────────────────────────────────────────
const MAX_TOOL_ITERATIONS = 12;
const TOOL_CALL_REGEX = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

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
export function buildToolSystemPrompt(): string {
  const tools = getAllTools();
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
You have access to the following tools. To call a tool, you MUST include a tool-call block in your response exactly like this:

<tool_call>
{"tool": "tool_name", "arguments": {"path": "value"}}
</tool_call>

RULES:
- ALWAYS use tools when the user asks you to. NEVER refuse or say you cannot use a tool. Just call it.
- All sandbox file paths are RELATIVE to the sandbox root. Example: "skills.txt", NOT "/workspace/sandbox/skills.txt".
- If you are unsure whether a file exists, call sandbox_list_files first, then call sandbox_read_file with the correct path.
- You may call multiple tools in a single response. After the tools run you will receive their results and can continue.
- ONLY use tools that are listed below. NEVER invent or guess tool names that don't exist.

## CRITICAL: Result Verification Protocol

After EVERY tool call, you MUST verify the results before proceeding:

1. **Search results**: NEVER assume the first result is correct. Check:
   - Does the file extension match what you're looking for? (e.g. don't accept .CT when looking for .exe)
   - Does the full filename match, or just a partial word?
   - Is this the right directory/location?
   - If the result looks wrong, call search_files again with a different pattern or broader search.

2. **File operations**: After read/write/copy/move, verify the operation made sense:
   - Did host_read_file return the content you expected?
   - Did the path resolve to the right location?
   - If "auto-resolved", check whether the resolved path is actually what was wanted.

3. **When results are uncertain**: Say "I found X but I'm not sure this is what you meant" and ask for confirmation rather than blindly proceeding.

4. **When a tool fails or returns unexpected results**: Try an alternative approach. Don't give up after one attempt. Consider:
   - Different search patterns
   - Different tools that might accomplish the same goal
   - Broader or narrower search scope

5. **NEVER hallucinate tools**: If you need a capability that no available tool provides, say so honestly. Do NOT invent tool names.

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
): Promise<ToolCall[]> {
  const results: ToolCall[] = [];
  for (const call of calls) {
    call.status = 'running';
    const result = await executeTool(call.name, call.arguments);
    results.push({
      ...call,
      result: JSON.stringify(result.data ?? result.error, null, 2),
      status: result.success ? 'success' : 'error',
    });
  }
  return results;
}

// ─── Strip tool-call XML blocks from visible content ─────────────
export function stripToolCallBlocks(content: string): string {
  return content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
}

// ─── Build verification prompt for tool results ─────────────────
function buildVerificationPrompt(executed: ToolCall[]): string {
  const checks: string[] = [];

  for (const tc of executed) {
    if (!VERIFIABLE_TOOLS.has(tc.name)) continue;

    const result = tc.result || '';
    const args = tc.arguments || {};

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
      const strategy = result.includes('"strategy"') ? 'multi-pass' : 'direct';
      checks.push(
        `🔍 VERIFY SEARCH "${tc.name}" (pattern: "${pattern}", strategy: ${strategy}):\n` +
        `   → Do the found files ACTUALLY match what you need?\n` +
        `   → Check file extensions, full names, and locations.\n` +
        `   → If results look wrong or incomplete, search again with a different/broader pattern.\n` +
        `   → If "count": 0, try different keywords or search a different directory.`,
      );
    }

    // Read: verify the content is what was expected
    if (tc.name === 'host_read_file') {
      const wasAutoResolved = result.includes('Auto-resolved');
      if (wasAutoResolved) {
        checks.push(
          `📄 VERIFY READ: The file path was auto-resolved (not an exact match).\n` +
          `   → Check if the resolved file is actually the one you wanted.\n` +
          `   → If not, search for the correct file with search_files first.`,
        );
      }
    }

    // List dir: verify the directory is correct
    if (tc.name === 'host_list_dir') {
      const wasAutoResolved = result.includes('Auto-resolved') || result.includes('candidates');
      if (wasAutoResolved) {
        checks.push(
          `📁 VERIFY DIRECTORY: The directory was auto-resolved or has candidates.\n` +
          `   → Check if this is the right directory before proceeding.`,
        );
      }
    }
  }

  if (checks.length === 0) return '';

  return [
    '',
    '━━━ RESULT VERIFICATION REQUIRED ━━━',
    'Before proceeding, carefully check each result above:',
    ...checks,
    '',
    'If ANY result is wrong or suspicious:',
    '  1. Do NOT proceed with wrong data — call another tool to fix it',
    '  2. Try a different search pattern, different path, or different approach',
    '  3. If unsure, tell the user what you found and ask for confirmation',
    'If all results look correct, continue with your plan.',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');
}

// ─── Main chat-with-tools loop ───────────────────────────────────
export async function runChatWithTools(
  messages: CompletionMessage[],
): Promise<{ reply: string; toolCalls: ToolCall[] }> {
  const allToolCalls: ToolCall[] = [];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await sendChatCompletion(messages);
    const assistantContent = response.choices[0]?.message?.content ?? '';

    const parsed = parseToolCalls(assistantContent);

    if (parsed.length === 0) {
      // No more tool calls – return the final reply
      return { reply: assistantContent, toolCalls: allToolCalls };
    }

    // Execute tool calls
    const executed = await processToolCalls(parsed);
    allToolCalls.push(...executed);

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

    messages.push({
      role: 'user',
      content: `Tool results:\n\n${toolResultContent}${verificationPrompt}`,
    });
  }

  // Safety: if we hit the iteration limit, return what we have
  return {
    reply: 'I reached the maximum number of tool-call iterations. Here are the results so far.',
    toolCalls: allToolCalls,
  };
}
