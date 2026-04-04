import { NextRequest, NextResponse } from 'next/server';
import {
  listWorkflows,
  saveWorkflow,
  getActiveWorkflows,
  setActiveWorkflow,
  resetToDefaults,
} from '@/lib/workflow';

// GET /api/workflows — list all workflows + active config
export async function GET() {
  try {
    const [workflows, active] = await Promise.all([
      listWorkflows(),
      getActiveWorkflows(),
    ]);
    return NextResponse.json({ workflows, active });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST /api/workflows — create or update a workflow, or special actions
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Special action: reset to defaults
    if (body.action === 'reset') {
      await resetToDefaults();
      const [workflows, active] = await Promise.all([
        listWorkflows(),
        getActiveWorkflows(),
      ]);
      return NextResponse.json({ workflows, active, message: 'Reset to defaults' });
    }

    // Special action: set active workflow for a mode
    if (body.action === 'setActive') {
      const { mode, workflowId } = body;
      if (!mode || !workflowId) {
        return NextResponse.json({ error: 'mode and workflowId required' }, { status: 400 });
      }
      await setActiveWorkflow(mode, workflowId);
      const active = await getActiveWorkflows();
      return NextResponse.json({ active, message: `Set ${mode} workflow to ${workflowId}` });
    }

    // Default: save/create workflow
    const workflow = body.workflow;
    if (!workflow?.id || !workflow?.mode) {
      return NextResponse.json({ error: 'workflow with id and mode required' }, { status: 400 });
    }
    if (!workflow.createdAt) workflow.createdAt = new Date().toISOString();
    workflow.updatedAt = new Date().toISOString();

    await saveWorkflow(workflow);
    return NextResponse.json({ workflow, message: 'Saved' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
