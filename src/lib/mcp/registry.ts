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
  const allNames = getAllTools().map(t => t.name);
  return { success: false, data: null, error: `Unknown tool: ${toolName}. This tool does not exist. Available tools: [${allNames.join(', ')}]. Use run_python to write a standalone Python script if no existing tool fits.` };
}

// ─── Tool Categories ─────────────────────────────────────────────
// Mixture-of-experts: first select relevant categories, then only
// evaluate tools within those categories.
export interface ToolCategory {
  id: string;
  label: string;
  description: string;
  toolNames: string[];
}

export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    id: 'sandbox_files',
    label: 'Sandbox Files',
    description: 'Read, write, list, and delete files in the project sandbox workspace',
    toolNames: ['sandbox_read_file', 'sandbox_write_file', 'sandbox_list_files', 'sandbox_delete_file', 'sandbox_create_dir'],
  },
  {
    id: 'host_filesystem',
    label: 'Host File System',
    description: 'Read, write, inspect, and navigate files anywhere on the system (any drive). Includes directory tree view and structured walk. For OPENING files, use desktop_utils category instead.',
    toolNames: ['host_list_dir', 'host_read_file', 'host_write_file', 'host_move', 'host_delete', 'host_create_dir', 'host_file_info', 'host_file_exists', 'directory_tree', 'walk_directory'],
  },
  {
    id: 'search',
    label: 'File Search & Navigation',
    description: 'Find directories by name, search for files by name/pattern/glob, progressive walk-search across all drives – like Windows grep for the filesystem',
    toolNames: ['find_directory', 'walk_search', 'search_files', 'search_in_files', 'glob_search'],
  },
  {
    id: 'shell_exec',
    label: 'Shell & Commands',
    description: 'Run shell commands (cmd/PowerShell/Python) and git operations anywhere on the system. Use run_python to execute generated scripts for tasks like picking random files, batch processing, data filtering, etc.',
    toolNames: ['run_command', 'run_powershell', 'run_python', 'git_command'],
  },
  {
    id: 'web_http',
    label: 'Web & HTTP',
    description: 'HTTP GET/POST requests, fetch and extract text from web pages',
    toolNames: ['http_get', 'http_post', 'fetch_page_text'],
  },
  {
    id: 'browser',
    label: 'Browser Automation',
    description: 'Chrome DevTools: navigate pages, evaluate JS, take screenshots, inspect DOM/console/network',
    toolNames: ['devtools_navigate', 'devtools_evaluate', 'devtools_screenshot', 'devtools_get_dom', 'devtools_console_logs', 'devtools_network_log'],
  },
  {
    id: 'system_info',
    label: 'System & Hardware',
    description: 'System info, running processes, drives, disk usage, date/time',
    toolNames: ['system_info', 'list_processes', 'kill_process', 'list_drives', 'disk_usage', 'current_datetime'],
  },
  {
    id: 'networking',
    label: 'Networking',
    description: 'Ping hosts, DNS lookup, network adapters, check listening ports',
    toolNames: ['ping_host', 'network_info', 'dns_lookup', 'check_ports'],
  },
  {
    id: 'software',
    label: 'Software & Packages',
    description: 'List installed applications, install packages via winget/npm/pip',
    toolNames: ['installed_apps', 'install_package'],
  },
  {
    id: 'desktop_utils',
    label: 'Desktop Utilities',
    description: 'OPEN/LAUNCH files and applications. Use open_app to open ANY file (images, videos, documents, executables) with its default program. Also: clipboard read/write, open URLs, environment variables.',
    toolNames: ['clipboard_read', 'clipboard_write', 'open_url', 'open_app', 'env_get', 'env_list'],
  },
  {
    id: 'documents',
    label: 'Document Creation',
    description: 'Create well-formatted Markdown documents and PowerPoint presentations',
    toolNames: ['write_markdown_doc', 'create_pptx'],
  },
];

/** Get categories with their tools populated from the registry */
export function getToolCategories() {
  const allTools = getAllTools();
  const toolMap = new Map(allTools.map(t => [t.name, t]));
  return TOOL_CATEGORIES.map(cat => ({
    ...cat,
    tools: cat.toolNames
      .map(name => toolMap.get(name))
      .filter(Boolean),
  }));
}
