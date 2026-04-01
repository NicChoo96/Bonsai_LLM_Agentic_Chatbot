import type { McpProvider, McpToolDefinition, McpToolResult } from './types';

// ─── Tool Definitions ────────────────────────────────────────────
const tools: McpToolDefinition[] = [
  {
    name: 'devtools_navigate',
    description: 'Navigate the browser to a URL and return the page title.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to navigate to.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'devtools_evaluate',
    description: 'Evaluate a JavaScript expression in the browser console and return the result.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate.' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'devtools_screenshot',
    description: 'Capture a screenshot of the current browser page (returns base64 PNG).',
    parameters: {
      type: 'object',
      properties: {
        fullPage: { type: 'string', description: '"true" for full-page screenshot, "false" for viewport only.' },
      },
      required: [],
    },
  },
  {
    name: 'devtools_get_dom',
    description: 'Retrieve the outer HTML of the current page DOM.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to scope the returned HTML (default: "html").' },
      },
      required: [],
    },
  },
  {
    name: 'devtools_console_logs',
    description: 'Retrieve recent browser console log entries.',
    parameters: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          description: 'Filter by log level.',
          enum: ['all', 'log', 'warn', 'error', 'info'],
        },
      },
      required: [],
    },
  },
  {
    name: 'devtools_network_log',
    description: 'Retrieve recent network requests.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Filter by URL substring (optional).' },
      },
      required: [],
    },
  },
];

// ─── CDP Connection Placeholder ─────────────────────────────────
// To connect to a real Chrome DevTools Protocol instance:
// 1. Launch Chrome with --remote-debugging-port=9222
// 2. Connect via WebSocket using the CDP protocol
// 3. Replace the stub implementations below with real CDP calls.
//
// For now, these tools use HTTP fetch as a lightweight fallback
// to demonstrate the MCP pattern.

async function execute(
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  try {
    switch (toolName) {
      case 'devtools_navigate': {
        const url = args.url as string;
        // Lightweight: just fetch the URL and return status + title
        const resp = await fetch(url);
        const html = await resp.text();
        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        return {
          success: true,
          data: {
            status: resp.status,
            title: titleMatch?.[1] ?? '(no title)',
            url,
            contentLength: html.length,
          },
        };
      }

      case 'devtools_evaluate': {
        return {
          success: false,
          data: null,
          error:
            'CDP not connected. Launch Chrome with --remote-debugging-port=9222 and configure the CDP WebSocket URL.',
        };
      }

      case 'devtools_screenshot': {
        return {
          success: false,
          data: null,
          error:
            'CDP not connected. Screenshots require a live CDP connection to Chrome.',
        };
      }

      case 'devtools_get_dom': {
        return {
          success: false,
          data: null,
          error:
            'CDP not connected. DOM inspection requires a live CDP connection to Chrome.',
        };
      }

      case 'devtools_console_logs': {
        return {
          success: false,
          data: null,
          error:
            'CDP not connected. Console logs require a live CDP connection to Chrome.',
        };
      }

      case 'devtools_network_log': {
        return {
          success: false,
          data: null,
          error:
            'CDP not connected. Network log requires a live CDP connection to Chrome.',
        };
      }

      default:
        return { success: false, data: null, error: `Unknown tool: ${toolName}` };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, data: null, error: message };
  }
}

export const chromeDevToolsProvider: McpProvider = {
  name: 'chrome-devtools',
  description:
    'Chrome DevTools Protocol tools (navigate, evaluate JS, screenshot, DOM, console, network).',
  tools,
  execute,
};
