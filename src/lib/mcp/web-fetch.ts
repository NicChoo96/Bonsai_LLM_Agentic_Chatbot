import type { McpProvider, McpToolDefinition, McpToolResult } from './types';

// ─── Tool Definitions ────────────────────────────────────────────
const tools: McpToolDefinition[] = [
  {
    name: 'http_get',
    description: 'Perform an HTTP GET request and return the response body.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch.' },
        headers: { type: 'string', description: 'Optional JSON string of headers.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'http_post',
    description: 'Perform an HTTP POST request and return the response body.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to post to.' },
        body: { type: 'string', description: 'Request body (JSON string).' },
        headers: { type: 'string', description: 'Optional JSON string of headers.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'fetch_page_text',
    description: 'Fetch a web page and extract its visible text content (strips HTML tags).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch.' },
      },
      required: ['url'],
    },
  },
];

// ─── Helpers ─────────────────────────────────────────────────────
function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000); // cap at 12k chars
}

function parseHeaders(raw?: string): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ─── Provider Implementation ─────────────────────────────────────
async function execute(
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  try {
    switch (toolName) {
      case 'http_get': {
        const resp = await fetch(args.url as string, {
          method: 'GET',
          headers: parseHeaders(args.headers as string | undefined),
        });
        const body = await resp.text();
        return {
          success: true,
          data: { status: resp.status, body: body.slice(0, 16000) },
        };
      }

      case 'http_post': {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          ...parseHeaders(args.headers as string | undefined),
        };
        const resp = await fetch(args.url as string, {
          method: 'POST',
          headers,
          body: (args.body as string) || '{}',
        });
        const body = await resp.text();
        return {
          success: true,
          data: { status: resp.status, body: body.slice(0, 16000) },
        };
      }

      case 'fetch_page_text': {
        const resp = await fetch(args.url as string);
        const html = await resp.text();
        return { success: true, data: stripHtml(html) };
      }

      default:
        return { success: false, data: null, error: `Unknown tool: ${toolName}` };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, data: null, error: message };
  }
}

export const webFetchProvider: McpProvider = {
  name: 'web-fetch',
  description: 'HTTP / web-fetch tools (GET, POST, page text extraction).',
  tools,
  execute,
};
