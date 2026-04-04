import { NextRequest, NextResponse } from 'next/server';
import {
  registerProvider,
  filesystemProvider,
  chromeDevToolsProvider,
  webFetchProvider,
  systemProvider,
  documentProvider,
  executeTool,
  getAllTools,
} from '@/lib/mcp';

// Ensure providers are registered
registerProvider(filesystemProvider);
registerProvider(chromeDevToolsProvider);
registerProvider(webFetchProvider);
registerProvider(systemProvider);
registerProvider(documentProvider);

// GET /api/mcp/execute – list all available MCP tools
export async function GET() {
  const tools = getAllTools();
  return NextResponse.json({ tools });
}

// POST /api/mcp/execute – directly invoke an MCP tool
export async function POST(req: NextRequest) {
  try {
    const { tool, arguments: args } = (await req.json()) as {
      tool: string;
      arguments: Record<string, unknown>;
    };

    if (!tool) {
      return NextResponse.json(
        { error: 'tool name is required' },
        { status: 400 },
      );
    }

    const result = await executeTool(tool, args || {});
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, data: null, error: message },
      { status: 500 },
    );
  }
}
