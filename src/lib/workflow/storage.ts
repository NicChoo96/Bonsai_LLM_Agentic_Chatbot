import fs from 'fs/promises';
import path from 'path';
import type { WorkflowDefinition, ActiveWorkflowConfig } from './types';
import { DEFAULT_WORKFLOWS, getDefaultWorkflow } from './defaults';

// ─── Storage paths ───────────────────────────────────────────────
const WORKFLOWS_DIR = path.resolve(process.cwd(), 'workflows');
const ACTIVE_CONFIG_PATH = path.join(WORKFLOWS_DIR, '.active.json');

async function ensureDir() {
  await fs.mkdir(WORKFLOWS_DIR, { recursive: true });
}

// ─── CRUD ────────────────────────────────────────────────────────

export async function saveWorkflow(workflow: WorkflowDefinition): Promise<void> {
  await ensureDir();
  workflow.updatedAt = new Date().toISOString();
  const filePath = path.join(WORKFLOWS_DIR, `${workflow.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf-8');
}

export async function loadWorkflow(id: string): Promise<WorkflowDefinition | null> {
  try {
    const filePath = path.join(WORKFLOWS_DIR, `${id}.json`);
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as WorkflowDefinition;
  } catch {
    // Try defaults
    const def = DEFAULT_WORKFLOWS.find(w => w.id === id);
    return def || null;
  }
}

export async function listWorkflows(): Promise<WorkflowDefinition[]> {
  await ensureDir();
  const results: WorkflowDefinition[] = [];
  const seenIds = new Set<string>();

  // Load saved workflows
  try {
    const files = await fs.readdir(WORKFLOWS_DIR);
    for (const file of files) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue;
      try {
        const raw = await fs.readFile(path.join(WORKFLOWS_DIR, file), 'utf-8');
        const wf = JSON.parse(raw) as WorkflowDefinition;
        results.push(wf);
        seenIds.add(wf.id);
      } catch { /* skip invalid files */ }
    }
  } catch { /* dir may not exist yet */ }

  // Add defaults that aren't already saved
  for (const def of DEFAULT_WORKFLOWS) {
    if (!seenIds.has(def.id)) {
      results.push(def);
    }
  }

  return results;
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  // Don't allow deleting defaults
  if (DEFAULT_WORKFLOWS.some(w => w.id === id)) return false;
  try {
    const filePath = path.join(WORKFLOWS_DIR, `${id}.json`);
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

// ─── Active workflow tracking ────────────────────────────────────

export async function getActiveWorkflows(): Promise<ActiveWorkflowConfig> {
  try {
    const raw = await fs.readFile(ACTIVE_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as ActiveWorkflowConfig;
  } catch {
    return { plan: 'default-plan', continuous: 'default-continuous' };
  }
}

export async function setActiveWorkflow(mode: 'plan' | 'continuous', workflowId: string): Promise<void> {
  await ensureDir();
  const config = await getActiveWorkflows();
  config[mode] = workflowId;
  await fs.writeFile(ACTIVE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/** Load the active workflow definition for a given mode */
export async function getActiveWorkflowForMode(mode: 'plan' | 'continuous'): Promise<WorkflowDefinition> {
  const config = await getActiveWorkflows();
  const id = config[mode];
  const loaded = await loadWorkflow(id);
  return loaded || getDefaultWorkflow(mode);
}

// ─── Reset to defaults ───────────────────────────────────────────

export async function resetToDefaults(): Promise<void> {
  await ensureDir();
  for (const def of DEFAULT_WORKFLOWS) {
    await saveWorkflow({ ...def, updatedAt: new Date().toISOString() });
  }
  await fs.writeFile(
    ACTIVE_CONFIG_PATH,
    JSON.stringify({ plan: 'default-plan', continuous: 'default-continuous' }, null, 2),
    'utf-8',
  );
}
