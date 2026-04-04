import { NextRequest, NextResponse } from 'next/server';
import { loadWorkflow, saveWorkflow, deleteWorkflow } from '@/lib/workflow';

// GET /api/workflows/[id] — load a single workflow
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const workflow = await loadWorkflow(params.id);
    if (!workflow) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ workflow });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// PUT /api/workflows/[id] — update a workflow
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await req.json();
    const workflow = body.workflow;
    if (!workflow) {
      return NextResponse.json({ error: 'workflow required' }, { status: 400 });
    }
    workflow.id = params.id;
    workflow.updatedAt = new Date().toISOString();
    await saveWorkflow(workflow);
    return NextResponse.json({ workflow, message: 'Updated' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// DELETE /api/workflows/[id] — delete a workflow
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const ok = await deleteWorkflow(params.id);
    if (!ok) {
      return NextResponse.json({ error: 'Cannot delete default workflows' }, { status: 400 });
    }
    return NextResponse.json({ message: 'Deleted' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
