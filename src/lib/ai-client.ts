// ─── AI Client ───────────────────────────────────────────────────
// Mirrors the request shape from app.py – POST to localhost:8080
// using the OpenAI-compatible /v1/chat/completions endpoint.

const AI_BASE_URL = process.env.AI_BASE_URL || 'http://localhost:8080';
const AI_TIMEOUT_MS = 120_000;  // 2 minutes per request
const AI_MAX_RETRIES = 3;

/** Maximum context size in tokens – matches the running model's n_ctx. */
export const AI_CONTEXT_LIMIT = parseInt(process.env.AI_CONTEXT_LIMIT || '16384', 10);

/**
 * Rough token estimation (~4 chars per token for English text).
 * Conservative: slightly over-counts to stay safely under the limit.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Estimate total tokens for a message array. */
export function estimateMessagesTokens(messages: CompletionMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += 4; // role/formatting overhead per message
    total += estimateTokens(m.content);
  }
  return total;
}

/**
 * Truncate a string to fit within a token budget.
 * Appends a truncation notice if cut.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const approxChars = Math.floor(maxTokens * 3.5);
  if (text.length <= approxChars) return text;
  return text.slice(0, approxChars) + '\n\n[... truncated — output exceeded token limit ...]';
}

/**
 * Compact a messages array to fit within a token budget.
 * Strategy: keep system (first) and last user message intact,
 * progressively truncate middle messages (oldest first).
 */
export function compactMessages(
  messages: CompletionMessage[],
  tokenBudget: number,
): CompletionMessage[] {
  let total = estimateMessagesTokens(messages);
  if (total <= tokenBudget) return messages;

  const result = [...messages];

  // Phase 1: Truncate tool-result messages (user messages containing "[Tool Result:")
  // Start from oldest (index 1) toward newest, skip the last message
  for (let i = 1; i < result.length - 1 && total > tokenBudget; i++) {
    const m = result[i];
    if (m.role === 'user' && m.content.includes('[Tool Result:')) {
      const before = estimateTokens(m.content);
      // Summarize tool results: keep first 300 chars of each result block
      const summarized = m.content.replace(
        /\[Tool Result: (\S+)\] \(status: (\w+)\)\n([\s\S]*?)(?=\n\n\[Tool Result:|\n\n──|\n\n═|$)/g,
        (_match, name: string, status: string, body: string) => {
          const shortBody = body.length > 300
            ? body.slice(0, 300) + '...[truncated]'
            : body;
          return `[Tool Result: ${name}] (status: ${status})\n${shortBody}`;
        },
      );
      result[i] = { ...m, content: summarized };
      total -= before - estimateTokens(summarized);
    }
  }

  // Phase 2: If still over, aggressively truncate assistant messages (middle ones)
  for (let i = 1; i < result.length - 1 && total > tokenBudget; i++) {
    const m = result[i];
    if (m.role === 'assistant') {
      const before = estimateTokens(m.content);
      const shortened = truncateToTokens(m.content, 200);
      result[i] = { ...m, content: shortened };
      total -= before - estimateTokens(shortened);
    }
  }

  // Phase 3: If STILL over, drop middle message pairs (oldest first)
  while (result.length > 2 && total > tokenBudget) {
    // Remove the second message (oldest after system prompt)
    const removed = result.splice(1, 1)[0];
    total -= estimateTokens(removed.content) + 4;
  }

  return result;
}

export interface CompletionMessage {
  role: string;
  content: string;
}

export interface CompletionRequest {
  messages: CompletionMessage[];
  temperature?: number;
  max_tokens?: number;
}

export interface CompletionChoice {
  message: CompletionMessage;
  finish_reason: string;
}

export interface CompletionResponse {
  choices: CompletionChoice[];
}

export async function sendChatCompletion(
  messages: CompletionMessage[],
): Promise<CompletionResponse> {
  let lastError: Error | null = null;
  let currentMessages = messages;

  for (let attempt = 1; attempt <= AI_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

    try {
      const res = await fetch(`${AI_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: currentMessages }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text();

        // ── Token exceeded – compact & retry ──────────────────
        try {
          const errBody = JSON.parse(text);
          if (errBody?.error?.type === 'exceed_context_size_error' || errBody?.error?.message?.includes('exceeds the available context size')) {
            const nCtx = errBody.error.n_ctx || AI_CONTEXT_LIMIT;
            // Compact to 70% of n_ctx to leave room for the model's response
            const budget = Math.floor(nCtx * 0.7);
            const compacted = compactMessages(currentMessages, budget);

            if (compacted.length < currentMessages.length || estimateMessagesTokens(compacted) < estimateMessagesTokens(currentMessages)) {
              currentMessages = compacted;
              console.warn(`[ai-client] Token exceeded (${errBody.error.n_prompt_tokens}/${nCtx}). Compacted to ~${estimateMessagesTokens(compacted)} tokens, retrying...`);
              continue; // retry with compacted messages
            }
          }
        } catch { /* not JSON or not the expected error shape – fall through */ }

        throw new Error(`AI request failed (${res.status}): ${text}`);
      }

      return res.json() as Promise<CompletionResponse>;
    } catch (err: unknown) {
      clearTimeout(timer);
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      const isTimeout = isAbort || (err instanceof Error && err.message.includes('abort'));
      lastError = isTimeout
        ? new Error(`AI request timed out after ${AI_TIMEOUT_MS / 1000}s (attempt ${attempt}/${AI_MAX_RETRIES})`)
        : err instanceof Error ? err : new Error(String(err));

      // Don't retry on non-timeout errors (e.g. 4xx responses)
      if (!isTimeout && !(err instanceof TypeError)) {
        throw lastError;
      }

      // Wait briefly before retrying (1s, 2s, 3s)
      if (attempt < AI_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, attempt * 1000));
      }
    }
  }

  throw lastError || new Error('AI request failed after all retries');
}
