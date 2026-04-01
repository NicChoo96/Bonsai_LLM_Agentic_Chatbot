import { getAllTools, executeTool } from './mcp/registry';
import { sendChatCompletion, type CompletionMessage } from './ai-client';
import type { ToolCall } from '@/types';

// ─── Constants ───────────────────────────────────────────────────
const MAX_TOOL_ITERATIONS = 8;
const TOOL_CALL_REGEX = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;

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
You have access to the following tools. To call a tool, include one or more tool-call blocks in your response exactly like this:

<tool_call>
{"tool": "tool_name", "arguments": {"param": "value"}}
</tool_call>

You may call multiple tools in a single response. After the tools run you will receive their results and can continue the conversation.

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
      calls.push({
        id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: parsed.tool,
        arguments: parsed.arguments || {},
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
          `[Tool Result: ${tc.name}]\n${tc.result}`,
      )
      .join('\n\n');

    messages.push({ role: 'user', content: `Tool results:\n\n${toolResultContent}` });
  }

  // Safety: if we hit the iteration limit, return what we have
  return {
    reply: 'I reached the maximum number of tool-call iterations. Here are the results so far.',
    toolCalls: allToolCalls,
  };
}
