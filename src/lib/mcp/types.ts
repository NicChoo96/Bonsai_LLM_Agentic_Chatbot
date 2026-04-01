// ─── MCP Tool Definition ─────────────────────────────────────────
export interface McpToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, McpParameterDef>;
    required?: string[];
  };
}

export interface McpParameterDef {
  type: string;
  description: string;
  enum?: string[];
}

// ─── MCP Execution ───────────────────────────────────────────────
export interface McpToolResult {
  success: boolean;
  data: unknown;
  error?: string;
}

// ─── MCP Provider ────────────────────────────────────────────────
export interface McpProvider {
  name: string;
  description: string;
  tools: McpToolDefinition[];
  execute(toolName: string, args: Record<string, unknown>): Promise<McpToolResult>;
}
