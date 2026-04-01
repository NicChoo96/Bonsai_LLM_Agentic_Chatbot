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
    description: 'Read the contents of a file in the sandbox workspace.',
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
    description: 'Create or overwrite a file in the sandbox workspace.',
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
    description: 'List files and directories in a sandbox folder.',
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
    description: 'Delete a file or directory from the sandbox workspace.',
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
    description: 'Create a new directory in the sandbox workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative directory path to create.' },
      },
      required: ['path'],
    },
  },
];

// ─── Provider Implementation ─────────────────────────────────────
async function execute(
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  try {
    switch (toolName) {
      case 'sandbox_read_file': {
        const content = await readSandboxFile(args.path as string);
        return { success: true, data: content };
      }
      case 'sandbox_write_file': {
        await writeSandboxFile(args.path as string, args.content as string);
        return { success: true, data: `File written: ${args.path}` };
      }
      case 'sandbox_list_files': {
        const files = await listSandboxFiles((args.path as string) || '');
        return { success: true, data: files };
      }
      case 'sandbox_delete_file': {
        await deleteSandboxFile(args.path as string);
        return { success: true, data: `Deleted: ${args.path}` };
      }
      case 'sandbox_create_dir': {
        await createSandboxDir(args.path as string);
        return { success: true, data: `Directory created: ${args.path}` };
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
  description: 'Sandboxed file-system operations (read, write, list, delete, mkdir).',
  tools,
  execute,
};
