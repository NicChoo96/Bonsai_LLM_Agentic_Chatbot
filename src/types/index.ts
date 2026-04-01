// ─── Chat Messages ───────────────────────────────────────────────
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

// ─── Tool Calls ──────────────────────────────────────────────────
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
  status: 'pending' | 'running' | 'success' | 'error';
}

// ─── Sandbox File Tree ───────────────────────────────────────────
export interface SandboxFile {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: SandboxFile[];
}

// ─── Chat Session ────────────────────────────────────────────────
export interface ChatSession {
  messages: ChatMessage[];
  selectedFiles: string[];
}

// ─── API Payloads ────────────────────────────────────────────────
export interface ChatRequest {
  messages: ChatMessage[];
  selectedFiles: string[];
}

export interface ChatResponse {
  message: ChatMessage;
  toolCalls: ToolCall[];
}

export interface FileCreateRequest {
  path: string;
  content: string;
}
