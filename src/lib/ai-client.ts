// ─── AI Client ───────────────────────────────────────────────────
// Mirrors the request shape from app.py – POST to localhost:8080
// using the OpenAI-compatible /v1/chat/completions endpoint.

const AI_BASE_URL = process.env.AI_BASE_URL || 'http://localhost:8080';
const AI_TIMEOUT_MS = 120_000;  // 2 minutes per request
const AI_MAX_RETRIES = 3;
const MODEL_NAME = process.env.MODEL_NAME;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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

  // Count total lines/items for context
  const totalLines = text.split('\n').length;
  const shownLines = text.slice(0, approxChars).split('\n').length;
  const remaining = totalLines - shownLines;

  return text.slice(0, approxChars) +
    `\n\n[... ${remaining} more lines truncated. ${totalLines} total lines. ` +
    `DO NOT re-call this tool — work with the data shown above. ` +
    `If you need to pick random items, select from the items already listed.]`;
}

/**
 * Compact a messages array by asking the AI to summarize the conversation.
 *
 * Keeps the system prompt (first message) and the latest user message intact.
 * Everything in between is summarized by the model into 5-10% of AI_CONTEXT_LIMIT,
 * then returned as a single "user" message containing the summary.
 *
 * Falls back to mechanical truncation if the AI summarization call itself fails.
 */
export async function compactMessages(
  messages: CompletionMessage[],
  tokenBudget: number,
): Promise<CompletionMessage[]> {
  const total = estimateMessagesTokens(messages);
  if (total <= tokenBudget) return messages;

  // Target summary size: 5-10% of the context limit
  const summaryMaxTokens = Math.floor(AI_CONTEXT_LIMIT * 0.08);

  // Separate the parts we want to keep vs. summarize
  const systemMsg = messages[0]; // always keep the system prompt
  const lastMsg = messages[messages.length - 1]; // always keep the latest message
  const middle = messages.slice(1, messages.length - 1); // everything to summarize

  if (middle.length === 0) return messages; // nothing to compact

  // Build a conversation transcript for the AI to summarize
  const transcript = middle.map(
    (m) => `[${m.role}]: ${m.content}`
  ).join('\n\n---\n\n');

  // Truncate the transcript mechanically first so the summarization call itself
  // doesn't exceed context. Leave room for the system prompt + summary instructions.
  const transcriptBudget = Math.floor(AI_CONTEXT_LIMIT * 0.6);
  const safeTranscript = truncateToTokens(transcript, transcriptBudget);

  try {
    const summaryResponse = await sendChatCompletionRaw([
      {
        role: 'system',
        content: [
          'You are a conversation compactor. Summarize the following conversation transcript into a concise summary.',
          `Your summary MUST be under ${summaryMaxTokens} tokens (~${Math.floor(summaryMaxTokens * 3.5)} characters).`,
          '',
          'RULES:',
          '- Preserve ALL important facts: file paths, tool results, values found, errors encountered, decisions made.',
          '- Preserve the sequence of events and what was accomplished vs. what failed.',
          '- Drop verbose tool output details — keep only the key findings.',
          '- Use dense bullet points, not full sentences.',
          '- Output ONLY the summary, no preamble.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `Summarize this conversation transcript:\n\n${safeTranscript}`,
      },
    ]);

    const summary = summaryResponse.choices[0]?.message?.content ?? '';

    if (summary.length > 0) {
      return [
        systemMsg,
        { role: 'user', content: `[Conversation Summary — previous messages compacted]:\n${summary}` },
        lastMsg,
      ];
    }
  } catch (err) {
    console.warn('[ai-client] AI-based compaction failed, falling back to mechanical truncation:', err);
  }

  // ── Fallback: mechanical truncation if AI summary fails ──
  return fallbackCompact(messages, tokenBudget);
}

/** Mechanical fallback: aggressively truncate and drop middle messages. */
function fallbackCompact(
  messages: CompletionMessage[],
  tokenBudget: number,
): CompletionMessage[] {
  let total = estimateMessagesTokens(messages);
  const result = [...messages];

  // Truncate all middle messages to 150 tokens each
  for (let i = 1; i < result.length - 1 && total > tokenBudget; i++) {
    const before = estimateTokens(result[i].content);
    const shortened = truncateToTokens(result[i].content, 150);
    result[i] = { ...result[i], content: shortened };
    total -= before - estimateTokens(shortened);
  }

  // Drop middle messages oldest-first if still over
  while (result.length > 2 && total > tokenBudget) {
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

/**
 * Raw completion call — NO automatic compaction.
 * Used internally by compactMessages to avoid infinite recursion.
 */
async function sendChatCompletionRaw(
  messages: CompletionMessage[],
): Promise<CompletionResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const res = await fetch(`${AI_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.AI_API_KEY || ''}`,
       },
      body: JSON.stringify({ 
        // 1. You MUST specify the model here
        model: MODEL_NAME,
        messages: messages,
        stream: false 
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AI request failed (${res.status}): ${text}`);
    }

    return res.json() as Promise<CompletionResponse>;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Send a chat completion with automatic token-overflow recovery.
 * If the request exceeds context, compactMessages is called (AI-based
 * summarization) and the request is retried.
 */
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
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.AI_API_KEY || ''}`,
        },
        body: JSON.stringify({ 
          model: MODEL_NAME,
          messages: currentMessages,
          stream: false,
        }),
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
            const budget = Math.floor(nCtx * 0.7);
            const compacted = await compactMessages(currentMessages, budget);

            if (estimateMessagesTokens(compacted) < estimateMessagesTokens(currentMessages)) {
              console.warn(`[ai-client] Token exceeded (${errBody.error.n_prompt_tokens}/${nCtx}). Compacted to ~${estimateMessagesTokens(compacted)} tokens, retrying...`);
              currentMessages = compacted;
              continue;
            }
          }
        } catch { /* not JSON or not the expected error shape – fall through */ }

        throw new Error(`AI request failed (${res.status}): ${text}`);
      }

      return res.json() as Promise<CompletionResponse>;
    } catch (err: unknown) {
      clearTimeout(timer);
      // Log the full error including cause (undici wraps network errors)
      console.error(`[ai-client] Fetch error (attempt ${attempt}/${AI_MAX_RETRIES}):`, err);
      if (err instanceof Error && 'cause' in err) {
        console.error(`[ai-client] Cause:`, (err as any).cause);
      }
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
