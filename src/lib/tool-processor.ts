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
