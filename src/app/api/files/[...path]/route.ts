import { NextRequest, NextResponse } from 'next/server';
import {
  readSandboxFile,
  writeSandboxFile,
  deleteSandboxFile,
  ensureSandbox,
} from '@/lib/sandbox';

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

function joinPath(segments: string[]): string {
  return segments.join('/');
}

// GET /api/files/[...path] – read a specific file
export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    await ensureSandbox();
    const { path: segments } = await ctx.params;
    const filePath = joinPath(segments);
    const content = await readSandboxFile(filePath);
    return NextResponse.json({ path: filePath, content });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('ENOENT') ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

// PUT /api/files/[...path] – update a specific file
export async function PUT(req: NextRequest, ctx: RouteContext) {
  try {
    await ensureSandbox();
    const { path: segments } = await ctx.params;
    const filePath = joinPath(segments);
    const { content } = (await req.json()) as { content: string };
    await writeSandboxFile(filePath, content);
    return NextResponse.json({ success: true, path: filePath });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE /api/files/[...path] – delete a file or directory
export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  try {
    await ensureSandbox();
    const { path: segments } = await ctx.params;
    const filePath = joinPath(segments);
    await deleteSandboxFile(filePath);
    return NextResponse.json({ success: true, path: filePath });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
