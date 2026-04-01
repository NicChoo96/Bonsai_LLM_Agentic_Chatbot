import type { McpProvider } from './types';

// ─── Global Provider Registry ────────────────────────────────────
const providers = new Map<string, McpProvider>();

export function registerProvider(provider: McpProvider): void {
  providers.set(provider.name, provider);
}

export function getProvider(name: string): McpProvider | undefined {
  return providers.get(name);
}

export function getAllProviders(): McpProvider[] {
  return Array.from(providers.values());
}

/** Flat list of every tool across all providers */
export function getAllTools() {
  return getAllProviders().flatMap((p) =>
    p.tools.map((t) => ({ provider: p.name, ...t })),
  );
}

/** Execute a tool by name – searches all providers */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
) {
  for (const provider of providers.values()) {
    const tool = provider.tools.find((t) => t.name === toolName);
    if (tool) {
      return provider.execute(toolName, args);
    }
  }
  return { success: false, data: null, error: `Unknown tool: ${toolName}` };
}
