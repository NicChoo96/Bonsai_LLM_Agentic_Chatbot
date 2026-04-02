import type { McpProvider, McpToolDefinition, McpToolResult } from './types';
import {
  readSandboxFile,
  writeSandboxFile,
  deleteSandboxFile,
  listSandboxFiles,
  createSandboxDir,
} from '../sandbox';

// ─── Tool Definitions ────────────────────────────────────────────
const tools: McpToolDefinition[] = [
  {
    name: 'sandbox_read_file',
    description: 'Read a file in the project sandbox workspace. For files outside the sandbox (any drive), use host_read_file instead.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path inside the sandbox.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'sandbox_write_file',
    description: 'Create or overwrite a file in the project sandbox workspace. For files outside the sandbox (any drive), use host_write_file instead.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path inside the sandbox.' },
        content: { type: 'string', description: 'File content to write.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'sandbox_list_files',
    description: 'List files in the project sandbox workspace. For listing any directory on the system, use host_list_dir instead.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative directory path (empty string for root).' },
      },
      required: [],
    },
  },
  {
    name: 'sandbox_delete_file',
    description: 'Delete a file or directory from the project sandbox workspace. For deleting files anywhere on the system, use host_delete instead.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to delete.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'sandbox_create_dir',
    description: 'Create a directory in the project sandbox workspace. For creating directories anywhere on the system, use host_create_dir instead.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative directory path to create.' },
      },
      required: ['path'],
    },
  },
];

// ─── Argument Helpers ────────────────────────────────────────────
/** Extract a path string from args – models may use "path", "file", "param", etc. */
function extractPath(args: Record<string, unknown>): string {
  const raw = (args.path ?? args.file ?? args.param ?? args.filepath ??
    args.file_path ?? args.filePath ?? args.filename ??
    Object.values(args).find((v) => typeof v === 'string')) as string | undefined;
  if (!raw || typeof raw !== 'string') return '';
  // Normalise separators to forward-slash
  let cleaned = raw.replace(/\\/g, '/');
  // Strip hallucinated absolute prefixes like /workspace/sandbox/ or /sandbox/
  cleaned = cleaned.replace(/^.*?\/sandbox\//, '');
  // Strip leading slashes
  cleaned = cleaned.replace(/^\/+/, '');
  return cleaned;
}

function extractContent(args: Record<string, unknown>): string {
  return (args.content ?? args.text ?? args.body ?? '') as string;
}

// ─── Provider Implementation ─────────────────────────────────────
async function execute(
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  try {
    switch (toolName) {
      case 'sandbox_read_file': {
        const p = extractPath(args);
        if (!p) return { success: false, data: null, error: 'path is required. Use a relative path like "skills.txt" or "folder/file.md".' };
        try {
          const content = await readSandboxFile(p);
          return { success: true, data: content };
        } catch (readErr: unknown) {
          // If file not found, list available files so the model can self-correct
          const msg = readErr instanceof Error ? readErr.message : String(readErr);
          if (msg.includes('ENOENT')) {
            const available = await listSandboxFiles('');
            const names = available.map((f) => f.path).join(', ');
            return {
              success: false,
              data: null,
              error: `File "${p}" not found. Available files in sandbox root: [${names}]. Use a relative path like "skills.txt".`,
            };
          }
          throw readErr;
        }
      }
      case 'sandbox_write_file': {
        const p = extractPath(args);
        if (!p) return { success: false, data: null, error: 'path is required' };
        await writeSandboxFile(p, extractContent(args));
        return { success: true, data: `File written: ${p}` };
      }
      case 'sandbox_list_files': {
        const p = extractPath(args);
        const files = await listSandboxFiles(p || '');
        return { success: true, data: files };
      }
      case 'sandbox_delete_file': {
        const p = extractPath(args);
        if (!p) return { success: false, data: null, error: 'path is required' };
        await deleteSandboxFile(p);
        return { success: true, data: `Deleted: ${p}` };
      }
      case 'sandbox_create_dir': {
        const p = extractPath(args);
        if (!p) return { success: false, data: null, error: 'path is required' };
        await createSandboxDir(p);
        return { success: true, data: `Directory created: ${p}` };
      }
      default:
        return { success: false, data: null, error: `Unknown tool: ${toolName}` };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, data: null, error: message };
  }
}

export const filesystemProvider: McpProvider = {
  name: 'filesystem',
  description: 'Sandboxed project workspace file operations (read, write, list, delete, mkdir). For system-wide file access across all drives, use the system provider tools (host_read_file, host_write_file, host_list_dir, etc.).',
  tools,
  execute,
};
