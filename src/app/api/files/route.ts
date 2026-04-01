import { NextRequest, NextResponse } from 'next/server';
import {
  listSandboxTree,
  writeSandboxFile,
  ensureSandbox,
} from '@/lib/sandbox';

// GET /api/files – list the full sandbox file tree
export async function GET() {
  try {
    await ensureSandbox();
    const tree = await listSandboxTree();
    return NextResponse.json({ files: tree });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST /api/files – create a new file in the sandbox
export async function POST(req: NextRequest) {
  try {
    const { path, content } = (await req.json()) as {
      path: string;
      content: string;
    };

    if (!path || typeof content !== 'string') {
      return NextResponse.json(
        { error: 'path and content are required' },
        { status: 400 },
      );
    }

    await ensureSandbox();
    await writeSandboxFile(path, content);
    return NextResponse.json({ success: true, path });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
