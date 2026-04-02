// ─── AI Client ───────────────────────────────────────────────────
// Mirrors the request shape from app.py – POST to localhost:8080
// using the OpenAI-compatible /v1/chat/completions endpoint.

const AI_BASE_URL = process.env.AI_BASE_URL || 'http://localhost:8080';
const AI_TIMEOUT_MS = 120_000;  // 2 minutes per request
const AI_MAX_RETRIES = 3;

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

  for (let attempt = 1; attempt <= AI_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

    try {
      const res = await fetch(`${AI_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text();
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
