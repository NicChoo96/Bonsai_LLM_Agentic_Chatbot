// ─── AI Client ───────────────────────────────────────────────────
// Mirrors the request shape from app.py – POST to localhost:8080
// using the OpenAI-compatible /v1/chat/completions endpoint.

const AI_BASE_URL = process.env.AI_BASE_URL || 'http://localhost:8080';

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
  const res = await fetch(`${AI_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI request failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<CompletionResponse>;
}
