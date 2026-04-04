'use client';

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import ReactFlow, {
  ReactFlowProvider,
  Controls,
  Background,
  MiniMap,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type NodeTypes,
  Handle,
  Position,
  MarkerType,
} from 'reactflow';
import 'reactflow/dist/style.css';

import type {
  WorkflowDefinition,
  WorkflowNode as WfNode,
  WorkflowEdge as WfEdge,
  WorkflowNodeKind,
  WorkflowEdgeType,
  ActiveWorkflowConfig,
} from '@/lib/workflow/types';

/* ─── CSS overrides to ensure React Flow works inside Bootstrap modal ─── */
const MODAL_STYLE = `
.wf-modal-backdrop {
  position: fixed; inset: 0; z-index: 2000;
  background: rgba(0,0,0,.55); display: flex;
  align-items: center; justify-content: center;
}
.wf-modal-content {
  width: 95vw; height: 90vh; background: #fff;
  border-radius: 10px; overflow: hidden; display: flex;
  flex-direction: column; box-shadow: 0 8px 40px rgba(0,0,0,.3);
  position: relative; z-index: 2001;
}
.wf-modal-content .react-flow {
  flex: 1; width: 100%; height: 100%;
}
.wf-modal-content .react-flow__renderer,
.wf-modal-content .react-flow__zoompane,
.wf-modal-content .react-flow__pane {
  pointer-events: all !important;
}
.wf-modal-content .react-flow__node { cursor: grab; }
.wf-modal-content .react-flow__node.selected { cursor: grabbing; }
.wf-modal-content .react-flow__handle { cursor: crosshair; }
.wf-modal-content .react-flow__controls { z-index: 5; }
.wf-modal-content .react-flow__minimap { z-index: 5; }
`;

// ═══════════════════════════════════════════════════════════════════
// Node type visual config
// ═══════════════════════════════════════════════════════════════════

const NODE_COLORS: Record<WorkflowNodeKind, string> = {
  start: '#28a745',
  ai_call: '#007bff',
  tool_select: '#6f42c1',
  tool_exec: '#fd7e14',
  evaluate: '#dc3545',
  condition: '#ffc107',
  loop: '#17a2b8',
  memory: '#6c757d',
  compile: '#20c997',
  output: '#28a745',
  walk_search: '#e83e8c',
  direct_response: '#007bff',
  sub_agent: '#fd7e14',
  phase_gate: '#adb5bd',
};

const NODE_ICONS: Record<WorkflowNodeKind, string> = {
  start: 'bi-play-circle-fill',
  ai_call: 'bi-robot',
  tool_select: 'bi-funnel',
  tool_exec: 'bi-gear-fill',
  evaluate: 'bi-check-circle',
  condition: 'bi-signpost-split',
  loop: 'bi-arrow-repeat',
  memory: 'bi-memory',
  compile: 'bi-layers',
  output: 'bi-stop-circle-fill',
  walk_search: 'bi-search',
  direct_response: 'bi-chat-dots',
  sub_agent: 'bi-diagram-3',
  phase_gate: 'bi-flag',
};

// ═══════════════════════════════════════════════════════════════════
// Custom Node Component
// ═══════════════════════════════════════════════════════════════════

function WorkflowNodeComponent({ data, selected }: { data: any; selected: boolean }) {
  const kind: WorkflowNodeKind = data.kind;
  const color = NODE_COLORS[kind] || '#6c757d';
  const icon = NODE_ICONS[kind] || 'bi-circle';

  return (
    <div
      style={{
        background: '#fff',
        border: `2px solid ${selected ? '#0d6efd' : color}`,
        borderRadius: 8,
        padding: '8px 12px',
        minWidth: 160,
        boxShadow: selected ? `0 0 0 2px ${color}40` : '0 1px 3px rgba(0,0,0,.15)',
        fontSize: 13,
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: color }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <i className={`bi ${icon}`} style={{ color, fontSize: 16 }} />
        <strong style={{ flex: 1 }}>{data.label}</strong>
        {data.maxRetries ? (
          <span className="badge bg-warning text-dark" style={{ fontSize: 10 }}>
            ×{data.maxRetries}
          </span>
        ) : null}
      </div>
      {data.description && (
        <div style={{ color: '#666', fontSize: 11, marginTop: 4, lineHeight: 1.3 }}>
          {data.description.length > 60 ? data.description.slice(0, 57) + '...' : data.description}
        </div>
      )}
      <div style={{ marginTop: 4 }}>
        <span
          className="badge"
          style={{ background: `${color}22`, color, fontSize: 10, fontWeight: 500 }}
        >
          {kind}
        </span>
        {data.timeout ? (
          <span className="badge bg-secondary ms-1" style={{ fontSize: 10 }}>
            {(data.timeout / 1000).toFixed(0)}s
          </span>
        ) : null}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: color }} />
    </div>
  );
}

const nodeTypes: NodeTypes = {
  workflowNode: WorkflowNodeComponent,
};

// ═══════════════════════════════════════════════════════════════════
// Convert between workflow definition and React Flow format
// ═══════════════════════════════════════════════════════════════════

function wfToFlowNodes(nodes: WfNode[]): Node[] {
  return nodes.map(n => ({
    id: n.id,
    type: 'workflowNode',
    position: n.position,
    data: {
      label: n.label,
      kind: n.kind,
      description: n.description,
      maxRetries: n.maxRetries,
      timeout: n.timeout,
      config: n.config,
      promptPrefix: n.promptPrefix,
      promptSuffix: n.promptSuffix,
    },
  }));
}

function wfToFlowEdges(edges: WfEdge[]): Edge[] {
  return edges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    type: 'smoothstep',
    animated: e.type === 'failure' || e.type === 'loop_body',
    style: {
      stroke:
        e.type === 'success' ? '#28a745' :
        e.type === 'failure' ? '#dc3545' :
        e.type === 'true' ? '#28a745' :
        e.type === 'false' ? '#dc3545' :
        e.type === 'loop_body' ? '#17a2b8' :
        e.type === 'loop_exit' ? '#6c757d' :
        '#666',
      strokeWidth: 2,
    },
    markerEnd: { type: MarkerType.ArrowClosed },
    data: { edgeType: e.type },
  }));
}

function flowToWfNodes(nodes: Node[], existingWf: WfNode[]): WfNode[] {
  const existingMap = new Map(existingWf.map(n => [n.id, n]));
  return nodes.map(n => {
    const existing = existingMap.get(n.id);
    return {
      id: n.id,
      kind: n.data.kind as WorkflowNodeKind,
      label: n.data.label,
      description: n.data.description,
      promptPrefix: n.data.promptPrefix,
      promptSuffix: n.data.promptSuffix,
      maxRetries: n.data.maxRetries,
      timeout: n.data.timeout,
      position: n.position,
      config: n.data.config || existing?.config || ({} as any),
    };
  });
}

function flowToWfEdges(edges: Edge[]): WfEdge[] {
  return edges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: (e.data?.edgeType || 'default') as WorkflowEdgeType,
    label: typeof e.label === 'string' ? e.label : undefined,
  }));
}

// ═══════════════════════════════════════════════════════════════════
// Edge type options for the selector
// ═══════════════════════════════════════════════════════════════════

const EDGE_TYPE_OPTIONS: { value: WorkflowEdgeType; label: string; color: string }[] = [
  { value: 'default', label: 'Default', color: '#666' },
  { value: 'success', label: 'Success', color: '#28a745' },
  { value: 'failure', label: 'Failure / Retry', color: '#dc3545' },
  { value: 'true', label: 'Condition True', color: '#28a745' },
  { value: 'false', label: 'Condition False', color: '#dc3545' },
  { value: 'loop_body', label: 'Loop Body', color: '#17a2b8' },
  { value: 'loop_exit', label: 'Loop Exit', color: '#6c757d' },
];

// ═══════════════════════════════════════════════════════════════════
// Node kind options for the add-node dropdown
// ═══════════════════════════════════════════════════════════════════

const NODE_KIND_OPTIONS: { value: WorkflowNodeKind; label: string }[] = [
  { value: 'ai_call', label: 'AI Call' },
  { value: 'tool_select', label: 'Tool Select' },
  { value: 'tool_exec', label: 'Tool Execute' },
  { value: 'evaluate', label: 'Evaluate' },
  { value: 'condition', label: 'Condition' },
  { value: 'loop', label: 'Loop' },
  { value: 'memory', label: 'Memory Op' },
  { value: 'compile', label: 'Compile' },
  { value: 'walk_search', label: 'Walk Search' },
  { value: 'direct_response', label: 'Direct Response' },
  { value: 'sub_agent', label: 'Sub-Agent' },
  { value: 'phase_gate', label: 'Phase Gate' },
];

// ═══════════════════════════════════════════════════════════════════
// Default configs for new nodes
// ═══════════════════════════════════════════════════════════════════

function defaultConfigForKind(kind: WorkflowNodeKind): any {
  switch (kind) {
    case 'ai_call': return { systemPrompt: '', userPrompt: '', responseFormat: 'text' };
    case 'tool_select': return { autoDetectPattern: '', autoDetectCategory: '', decisionPrompt: '' };
    case 'tool_exec': return { additionalTools: [], excludeTools: [], maxIterations: 15, autoInjectOpenApp: false };
    case 'evaluate': return { evaluationPrompt: '', strictness: 'strict', allowCategoryRetry: true };
    case 'condition': return { condition: '', evaluator: 'expression' };
    case 'loop': return { collection: '', itemVar: '', maxIterations: 20 };
    case 'memory': return { operation: 'compact', compactThreshold: 1500, compactMaxChars: 800 };
    case 'compile': return { compilePrompt: '', skipIfSingleStep: true };
    case 'walk_search': return { walkTools: [], shellTools: [], maxPasses: 2 };
    case 'direct_response': return { systemPrompt: '' };
    case 'sub_agent': return { maxRetries: 3, fullPipeline: true };
    case 'phase_gate': return { phaseName: '', outputKey: '' };
    default: return {};
  }
}

// ═══════════════════════════════════════════════════════════════════
// Property Editor Panel
// ═══════════════════════════════════════════════════════════════════

interface PropertyEditorProps {
  node: Node | null;
  edge: Edge | null;
  onUpdateNode: (id: string, data: any) => void;
  onUpdateEdge: (id: string, data: any) => void;
  onDeleteNode: (id: string) => void;
  onDeleteEdge: (id: string) => void;
}

function PropertyEditor({ node, edge, onUpdateNode, onUpdateEdge, onDeleteNode, onDeleteEdge }: PropertyEditorProps) {
  if (!node && !edge) {
    return (
      <div className="p-3 text-muted" style={{ fontSize: 13 }}>
        <i className="bi bi-info-circle me-1" />
        Select a node or edge to edit its properties
      </div>
    );
  }

  if (edge) {
    const edgeType = edge.data?.edgeType || 'default';
    return (
      <div className="p-3" style={{ fontSize: 13 }}>
        <h6 className="mb-3"><i className="bi bi-arrow-right me-1" />Edge Properties</h6>
        <div className="mb-2">
          <label className="form-label fw-bold mb-1">Type</label>
          <select
            className="form-select form-select-sm"
            value={edgeType}
            onChange={e => onUpdateEdge(edge.id, { edgeType: e.target.value })}
          >
            {EDGE_TYPE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="mb-2">
          <label className="form-label fw-bold mb-1">Label</label>
          <input
            className="form-control form-control-sm"
            value={typeof edge.label === 'string' ? edge.label : ''}
            onChange={e => onUpdateEdge(edge.id, { label: e.target.value })}
          />
        </div>
        <button className="btn btn-outline-danger btn-sm mt-2" onClick={() => onDeleteEdge(edge.id)}>
          <i className="bi bi-trash me-1" />Delete Edge
        </button>
      </div>
    );
  }

  if (!node) return null;
  const d = node.data;
  const kind = d.kind as WorkflowNodeKind;
  const config = d.config || {};

  const updateData = (patch: any) => onUpdateNode(node.id, { ...d, ...patch });
  const updateConfig = (patch: any) => onUpdateNode(node.id, { ...d, config: { ...config, ...patch } });

  return (
    <div className="p-3" style={{ fontSize: 13, overflowY: 'auto' }}>
      <h6 className="mb-3">
        <i className={`bi ${NODE_ICONS[kind]} me-1`} style={{ color: NODE_COLORS[kind] }} />
        Node Properties
      </h6>

      {/* Common fields */}
      <div className="mb-2">
        <label className="form-label fw-bold mb-1">Label</label>
        <input className="form-control form-control-sm" value={d.label || ''} onChange={e => updateData({ label: e.target.value })} />
      </div>
      <div className="mb-2">
        <label className="form-label fw-bold mb-1">Description</label>
        <textarea className="form-control form-control-sm" rows={2} value={d.description || ''} onChange={e => updateData({ description: e.target.value })} />
      </div>
      <div className="row mb-2">
        <div className="col-6">
          <label className="form-label fw-bold mb-1">Max Retries</label>
          <input type="number" className="form-control form-control-sm" value={d.maxRetries || 0} onChange={e => updateData({ maxRetries: parseInt(e.target.value) || 0 })} />
        </div>
        <div className="col-6">
          <label className="form-label fw-bold mb-1">Timeout (ms)</label>
          <input type="number" className="form-control form-control-sm" value={d.timeout || 0} onChange={e => updateData({ timeout: parseInt(e.target.value) || 0 })} />
        </div>
      </div>
      <div className="mb-2">
        <label className="form-label fw-bold mb-1">Prompt Prefix</label>
        <textarea className="form-control form-control-sm font-monospace" rows={2} value={d.promptPrefix || ''} onChange={e => updateData({ promptPrefix: e.target.value })} placeholder="Text prepended to system prompt" />
      </div>
      <div className="mb-3">
        <label className="form-label fw-bold mb-1">Prompt Suffix</label>
        <textarea className="form-control form-control-sm font-monospace" rows={2} value={d.promptSuffix || ''} onChange={e => updateData({ promptSuffix: e.target.value })} placeholder="Text appended to system prompt" />
      </div>

      <hr />

      {/* Kind-specific config */}
      <h6 className="text-muted mb-2" style={{ fontSize: 11 }}>{kind.toUpperCase()} CONFIG</h6>

      {kind === 'ai_call' && (
        <>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">System Prompt</label>
            <textarea className="form-control form-control-sm font-monospace" rows={6} value={config.systemPrompt || ''} onChange={e => updateConfig({ systemPrompt: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">User Prompt</label>
            <textarea className="form-control form-control-sm font-monospace" rows={3} value={config.userPrompt || ''} onChange={e => updateConfig({ userPrompt: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Response Format</label>
            <select className="form-select form-select-sm" value={config.responseFormat || 'text'} onChange={e => updateConfig({ responseFormat: e.target.value })}>
              <option value="text">Text</option>
              <option value="json">JSON</option>
            </select>
          </div>
        </>
      )}

      {kind === 'tool_select' && (
        <>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Auto-Detect Pattern (regex)</label>
            <input className="form-control form-control-sm font-monospace" value={config.autoDetectPattern || ''} onChange={e => updateConfig({ autoDetectPattern: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Auto-Detect Category</label>
            <input className="form-control form-control-sm" value={config.autoDetectCategory || ''} onChange={e => updateConfig({ autoDetectCategory: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Decision Prompt</label>
            <textarea className="form-control form-control-sm font-monospace" rows={4} value={config.decisionPrompt || ''} onChange={e => updateConfig({ decisionPrompt: e.target.value })} />
          </div>
        </>
      )}

      {kind === 'tool_exec' && (
        <>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Additional Tools (comma-separated)</label>
            <input className="form-control form-control-sm" value={(config.additionalTools || []).join(', ')} onChange={e => updateConfig({ additionalTools: e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean) })} />
          </div>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Exclude Tools (comma-separated)</label>
            <input className="form-control form-control-sm" value={(config.excludeTools || []).join(', ')} onChange={e => updateConfig({ excludeTools: e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean) })} />
          </div>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Max Iterations</label>
            <input type="number" className="form-control form-control-sm" value={config.maxIterations || 15} onChange={e => updateConfig({ maxIterations: parseInt(e.target.value) || 15 })} />
          </div>
          <div className="form-check mb-2">
            <input className="form-check-input" type="checkbox" checked={!!config.autoInjectOpenApp} onChange={e => updateConfig({ autoInjectOpenApp: e.target.checked })} />
            <label className="form-check-label">Auto-inject open_app for open/launch steps</label>
          </div>
        </>
      )}

      {kind === 'evaluate' && (
        <>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Evaluation Prompt</label>
            <textarea className="form-control form-control-sm font-monospace" rows={4} value={config.evaluationPrompt || ''} onChange={e => updateConfig({ evaluationPrompt: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Strictness</label>
            <select className="form-select form-select-sm" value={config.strictness || 'strict'} onChange={e => updateConfig({ strictness: e.target.value })}>
              <option value="strict">Strict</option>
              <option value="lenient">Lenient</option>
            </select>
          </div>
          <div className="form-check mb-2">
            <input className="form-check-input" type="checkbox" checked={config.allowCategoryRetry !== false} onChange={e => updateConfig({ allowCategoryRetry: e.target.checked })} />
            <label className="form-check-label">Allow cross-category retry</label>
          </div>
        </>
      )}

      {kind === 'condition' && (
        <>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Condition</label>
            <input className="form-control form-control-sm font-monospace" value={config.condition || ''} onChange={e => updateConfig({ condition: e.target.value })} placeholder="e.g. {{currentStep.walk_mode}}" />
          </div>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Evaluator</label>
            <select className="form-select form-select-sm" value={config.evaluator || 'expression'} onChange={e => updateConfig({ evaluator: e.target.value })}>
              <option value="expression">Expression</option>
              <option value="regex">Regex</option>
              <option value="contains">Contains</option>
              <option value="ai">AI Evaluation</option>
            </select>
          </div>
        </>
      )}

      {kind === 'loop' && (
        <>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Collection Variable</label>
            <input className="form-control form-control-sm" value={config.collection || ''} onChange={e => updateConfig({ collection: e.target.value })} placeholder="e.g. planSteps" />
          </div>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Item Variable</label>
            <input className="form-control form-control-sm" value={config.itemVar || ''} onChange={e => updateConfig({ itemVar: e.target.value })} placeholder="e.g. currentStep" />
          </div>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Max Iterations</label>
            <input type="number" className="form-control form-control-sm" value={config.maxIterations || 20} onChange={e => updateConfig({ maxIterations: parseInt(e.target.value) || 20 })} />
          </div>
        </>
      )}

      {kind === 'memory' && (
        <>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Operation</label>
            <select className="form-select form-select-sm" value={config.operation || 'compact'} onChange={e => updateConfig({ operation: e.target.value })}>
              <option value="save">Save</option>
              <option value="compact">Compact</option>
              <option value="read">Read</option>
            </select>
          </div>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Compact Threshold (chars)</label>
            <input type="number" className="form-control form-control-sm" value={config.compactThreshold || 1500} onChange={e => updateConfig({ compactThreshold: parseInt(e.target.value) || 1500 })} />
          </div>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Compact Max Output (chars)</label>
            <input type="number" className="form-control form-control-sm" value={config.compactMaxChars || 800} onChange={e => updateConfig({ compactMaxChars: parseInt(e.target.value) || 800 })} />
          </div>
        </>
      )}

      {kind === 'compile' && (
        <>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Compile Prompt</label>
            <textarea className="form-control form-control-sm font-monospace" rows={4} value={config.compilePrompt || ''} onChange={e => updateConfig({ compilePrompt: e.target.value })} />
          </div>
          <div className="form-check mb-2">
            <input className="form-check-input" type="checkbox" checked={config.skipIfSingleStep !== false} onChange={e => updateConfig({ skipIfSingleStep: e.target.checked })} />
            <label className="form-check-label">Skip compilation for single-step plans</label>
          </div>
        </>
      )}

      {kind === 'walk_search' && (
        <>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Walk Tools (comma-separated)</label>
            <input className="form-control form-control-sm" value={(config.walkTools || []).join(', ')} onChange={e => updateConfig({ walkTools: e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean) })} />
          </div>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Shell Tools (comma-separated)</label>
            <input className="form-control form-control-sm" value={(config.shellTools || []).join(', ')} onChange={e => updateConfig({ shellTools: e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean) })} />
          </div>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Max Passes</label>
            <input type="number" className="form-control form-control-sm" value={config.maxPasses || 2} onChange={e => updateConfig({ maxPasses: parseInt(e.target.value) || 2 })} />
          </div>
        </>
      )}

      {kind === 'direct_response' && (
        <div className="mb-2">
          <label className="form-label fw-bold mb-1">System Prompt</label>
          <textarea className="form-control form-control-sm font-monospace" rows={4} value={config.systemPrompt || ''} onChange={e => updateConfig({ systemPrompt: e.target.value })} />
        </div>
      )}

      {kind === 'sub_agent' && (
        <>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Max Retries</label>
            <input type="number" className="form-control form-control-sm" value={config.maxRetries || 3} onChange={e => updateConfig({ maxRetries: parseInt(e.target.value) || 3 })} />
          </div>
          <div className="form-check mb-2">
            <input className="form-check-input" type="checkbox" checked={config.fullPipeline !== false} onChange={e => updateConfig({ fullPipeline: e.target.checked })} />
            <label className="form-check-label">Full pipeline per sub-agent</label>
          </div>
        </>
      )}

      {kind === 'phase_gate' && (
        <>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Phase Name</label>
            <input className="form-control form-control-sm" value={config.phaseName || ''} onChange={e => updateConfig({ phaseName: e.target.value })} />
          </div>
          <div className="mb-2">
            <label className="form-label fw-bold mb-1">Output Key</label>
            <input className="form-control form-control-sm" value={config.outputKey || ''} onChange={e => updateConfig({ outputKey: e.target.value })} />
          </div>
        </>
      )}

      <hr />
      {kind !== 'start' && kind !== 'output' && (
        <button className="btn btn-outline-danger btn-sm" onClick={() => onDeleteNode(node.id)}>
          <i className="bi bi-trash me-1" />Delete Node
        </button>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Main Workflow Canvas Modal
// ═══════════════════════════════════════════════════════════════════

interface WorkflowCanvasModalProps {
  open: boolean;
  onClose: () => void;
  initialMode?: 'plan' | 'continuous';
  /** Called when active workflow changes so parent can update its badge */
  onActiveChange?: (info: ActiveWorkflowConfig) => void;
}

function WorkflowCanvasInner({ open, onClose, initialMode, onActiveChange }: WorkflowCanvasModalProps) {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [active, setActive] = useState<ActiveWorkflowConfig>({ plan: 'default-plan', continuous: 'default-continuous' });
  const [currentWorkflowId, setCurrentWorkflowId] = useState('');
  const [currentWorkflow, setCurrentWorkflow] = useState<WorkflowDefinition | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveAsName, setSaveAsName] = useState('');
  const [showSaveAs, setShowSaveAs] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [loaded, setLoaded] = useState(false);
  const nodeIdCounter = useRef(0);

  // Stable nodeTypes ref — CRITICAL for React Flow
  const stableNodeTypes: NodeTypes = useMemo(() => ({ workflowNode: WorkflowNodeComponent }), []);

  // ── Load workflows when modal opens ──
  useEffect(() => {
    if (!open) { setLoaded(false); return; }
    fetch('/api/workflows')
      .then(r => r.json())
      .then(data => {
        const wfs = data.workflows || [];
        const act = data.active || { plan: 'default-plan', continuous: 'default-continuous' };
        setWorkflows(wfs);
        setActive(act);
        const mode = initialMode || 'continuous';
        const activeId = act[mode] || `default-${mode}`;
        loadWorkflowFromList(activeId, wfs);
        setLoaded(true);
      })
      .catch(() => setStatusMessage('Failed to load workflows'));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadWorkflowFromList = (id: string, wfList: WorkflowDefinition[]) => {
    const wf = wfList.find(w => w.id === id);
    if (wf) {
      setCurrentWorkflowId(wf.id);
      setCurrentWorkflow(wf);
      setNodes(wfToFlowNodes(wf.nodes));
      setEdges(wfToFlowEdges(wf.edges));
      setDirty(false);
      setSelectedNode(null);
      setSelectedEdge(null);
      nodeIdCounter.current = wf.nodes.length + 10;
    }
  };

  const loadWorkflowById = (id: string) => {
    loadWorkflowFromList(id, workflows);
  };

  // ── React Flow callbacks ──
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes(nds => applyNodeChanges(changes, nds));
    setDirty(true);
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges(eds => applyEdgeChanges(changes, eds));
    setDirty(true);
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    const newEdge = {
      ...connection,
      id: `e-${connection.source}-${connection.target}-${Date.now()}`,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
      data: { edgeType: 'default' },
    };
    setEdges(eds => addEdge(newEdge, eds));
    setDirty(true);
  }, []);

  const onNodeClick = useCallback((_: any, node: Node) => {
    setSelectedNode(node);
    setSelectedEdge(null);
  }, []);

  const onEdgeClick = useCallback((_: any, edge: Edge) => {
    setSelectedEdge(edge);
    setSelectedNode(null);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
  }, []);

  // ── CRUD operations ──
  const handleUpdateNode = useCallback((id: string, data: any) => {
    setNodes(nds => nds.map(n => n.id === id ? { ...n, data } : n));
    setSelectedNode(prev => prev?.id === id ? { ...prev, data } : prev);
    setDirty(true);
  }, []);

  const handleUpdateEdge = useCallback((id: string, data: any) => {
    setEdges(eds => eds.map(e => {
      if (e.id !== id) return e;
      const edgeType = data.edgeType || e.data?.edgeType || 'default';
      return {
        ...e,
        label: data.label ?? e.label,
        data: { ...e.data, edgeType },
        animated: edgeType === 'failure' || edgeType === 'loop_body',
        style: {
          stroke:
            edgeType === 'success' ? '#28a745' :
            edgeType === 'failure' ? '#dc3545' :
            edgeType === 'true' ? '#28a745' :
            edgeType === 'false' ? '#dc3545' :
            edgeType === 'loop_body' ? '#17a2b8' :
            edgeType === 'loop_exit' ? '#6c757d' : '#666',
          strokeWidth: 2,
        },
      };
    }));
    setSelectedEdge(prev => prev?.id === id ? { ...prev, data: { ...prev.data, ...data } } : prev);
    setDirty(true);
  }, []);

  const handleDeleteNode = useCallback((id: string) => {
    setNodes(nds => nds.filter(n => n.id !== id));
    setEdges(eds => eds.filter(e => e.source !== id && e.target !== id));
    setSelectedNode(null);
    setDirty(true);
  }, []);

  const handleDeleteEdge = useCallback((id: string) => {
    setEdges(eds => eds.filter(e => e.id !== id));
    setSelectedEdge(null);
    setDirty(true);
  }, []);

  const handleAddNode = useCallback((kind: WorkflowNodeKind) => {
    const id = `node_${kind}_${++nodeIdCounter.current}`;
    const newNode: Node = {
      id,
      type: 'workflowNode',
      position: { x: 400, y: 50 + nodeIdCounter.current * 20 },
      data: {
        label: kind.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
        kind,
        description: '',
        config: defaultConfigForKind(kind),
      },
    };
    setNodes(nds => [...nds, newNode]);
    setSelectedNode(newNode);
    setSelectedEdge(null);
    setDirty(true);
  }, []);

  // ── Save workflow ──
  const handleSave = async () => {
    if (!currentWorkflow) return;
    const wfNodes = flowToWfNodes(nodes, currentWorkflow.nodes);
    const wfEdges = flowToWfEdges(edges);
    const updated: WorkflowDefinition = {
      ...currentWorkflow,
      nodes: wfNodes,
      edges: wfEdges,
      updatedAt: new Date().toISOString(),
    };
    try {
      const res = await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow: updated }),
      });
      if (res.ok) {
        setCurrentWorkflow(updated);
        setDirty(false);
        setStatusMessage('Saved!');
        // Refresh list
        const list = await fetch('/api/workflows').then(r => r.json());
        setWorkflows(list.workflows || []);
        setTimeout(() => setStatusMessage(''), 2000);
      }
    } catch {
      setStatusMessage('Save failed');
    }
  };

  // ── Save As ──
  const handleSaveAs = async () => {
    if (!currentWorkflow || !saveAsName.trim()) return;
    const id = saveAsName.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const wfNodes = flowToWfNodes(nodes, currentWorkflow.nodes);
    const wfEdges = flowToWfEdges(edges);
    const newWf: WorkflowDefinition = {
      ...currentWorkflow,
      id,
      name: saveAsName.trim(),
      isDefault: false,
      nodes: wfNodes,
      edges: wfEdges,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      const res = await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow: newWf }),
      });
      if (res.ok) {
        setShowSaveAs(false);
        setSaveAsName('');
        setCurrentWorkflow(newWf);
        setCurrentWorkflowId(id);
        setDirty(false);
        setStatusMessage(`Saved as "${saveAsName.trim()}"`);
        const list = await fetch('/api/workflows').then(r => r.json());
        setWorkflows(list.workflows || []);
        setTimeout(() => setStatusMessage(''), 2000);
      }
    } catch {
      setStatusMessage('Save As failed');
    }
  };

  // ── Set active ──
  const handleSetActive = async (mode: 'plan' | 'continuous') => {
    if (!currentWorkflowId) return;
    try {
      const res = await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setActive', mode, workflowId: currentWorkflowId }),
      });
      if (res.ok) {
        const data = await res.json();
        setActive(data.active);
        onActiveChange?.(data.active);
        setStatusMessage(`Set as active ${mode} workflow`);
        setTimeout(() => setStatusMessage(''), 2000);
      }
    } catch {
      setStatusMessage('Failed to set active');
    }
  };

  // ── Reset defaults ──
  const handleReset = async () => {
    try {
      const res = await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset' }),
      });
      if (res.ok) {
        const data = await res.json();
        const wfs = data.workflows || [];
        setWorkflows(wfs);
        setActive(data.active);
        const mode = currentWorkflow?.mode || 'continuous';
        loadWorkflowFromList(`default-${mode}`, wfs);
        setStatusMessage('Reset to defaults');
        setTimeout(() => setStatusMessage(''), 2000);
      }
    } catch {
      setStatusMessage('Reset failed');
    }
  };

  // ── Delete workflow ──
  const handleDelete = async () => {
    if (!currentWorkflowId || currentWorkflow?.isDefault) return;
    try {
      const res = await fetch(`/api/workflows/${currentWorkflowId}`, { method: 'DELETE' });
      if (res.ok) {
        const list = await fetch('/api/workflows').then(r => r.json());
        const wfs = list.workflows || [];
        setWorkflows(wfs);
        const mode = currentWorkflow?.mode || 'continuous';
        loadWorkflowFromList(`default-${mode}`, wfs);
        setStatusMessage('Deleted');
        setTimeout(() => setStatusMessage(''), 2000);
      }
    } catch {
      setStatusMessage('Delete failed');
    }
  };

  // ── Compute summary ──
  const nodeCount = nodes.length;
  const edgeCount = edges.length;
  const isActive = currentWorkflow && (
    active[currentWorkflow.mode] === currentWorkflowId
  );

  if (!open) return null;

  return (
    <>
      <style>{MODAL_STYLE}</style>
      <div className="wf-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="wf-modal-content">
          {/* ── Header bar ── */}
          <div style={{ display: 'flex', alignItems: 'center', padding: '8px 16px', borderBottom: '1px solid #dee2e6', background: '#f8f9fa', gap: 12, flexShrink: 0 }}>
            <i className="bi bi-diagram-3" style={{ fontSize: 18, color: '#0d6efd' }} />
            <strong style={{ flex: 1 }}>Workflow Editor</strong>
            <select
              className="form-select form-select-sm"
              style={{ width: 220 }}
              value={currentWorkflowId}
              onChange={e => loadWorkflowById(e.target.value)}
            >
              <optgroup label="Plan Mode">
                {workflows.filter(w => w.mode === 'plan').map(w => (
                  <option key={w.id} value={w.id}>
                    {w.name} {active.plan === w.id ? ' ✓' : ''}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Continuous Mode">
                {workflows.filter(w => w.mode === 'continuous').map(w => (
                  <option key={w.id} value={w.id}>
                    {w.name} {active.continuous === w.id ? ' ✓' : ''}
                  </option>
                ))}
              </optgroup>
            </select>
            <div className="btn-group btn-group-sm">
              <button className="btn btn-primary" onClick={handleSave} disabled={!dirty} title="Save">
                <i className="bi bi-save" />
              </button>
              <button className="btn btn-outline-secondary" onClick={() => setShowSaveAs(true)} title="Save As">
                <i className="bi bi-save2" />
              </button>
              <button className="btn btn-outline-warning" onClick={handleReset} title="Reset to defaults">
                <i className="bi bi-arrow-counterclockwise" />
              </button>
              {currentWorkflow && !currentWorkflow.isDefault && (
                <button className="btn btn-outline-danger" onClick={handleDelete} title="Delete">
                  <i className="bi bi-trash" />
                </button>
              )}
            </div>
            {currentWorkflow && (
              <button
                className={`btn btn-sm ${isActive ? 'btn-success' : 'btn-outline-success'}`}
                onClick={() => handleSetActive(currentWorkflow.mode)}
                disabled={!!isActive}
              >
                {isActive ? <><i className="bi bi-check-circle me-1" />Active</> : <><i className="bi bi-play me-1" />Set Active</>}
              </button>
            )}
            {statusMessage && <span className="text-success" style={{ fontSize: 12 }}>{statusMessage}</span>}
            <span className="text-muted" style={{ fontSize: 11 }}>{nodeCount}n · {edgeCount}e{dirty ? ' ·unsaved' : ''}</span>
            <button className="btn btn-sm btn-outline-secondary" onClick={onClose} title="Close">
              <i className="bi bi-x-lg" />
            </button>
          </div>

          {/* ── Save As inline ── */}
          {showSaveAs && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 16px', borderBottom: '1px solid #dee2e6', background: '#fff' }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>Save As:</span>
              <input
                className="form-control form-control-sm"
                style={{ width: 200 }}
                placeholder="Workflow name"
                value={saveAsName}
                onChange={e => setSaveAsName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSaveAs()}
                autoFocus
              />
              <button className="btn btn-primary btn-sm" onClick={handleSaveAs}>Save</button>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowSaveAs(false)}>Cancel</button>
            </div>
          )}

          {/* ── Main body: sidebar + canvas + properties ── */}
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
            {/* Left: Add Node panel */}
            <div style={{ width: 170, borderRight: '1px solid #dee2e6', overflowY: 'auto', background: '#f8f9fa', padding: 8, flexShrink: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, color: '#6c757d' }}>ADD NODE</div>
              {NODE_KIND_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  className="btn btn-outline-secondary btn-sm text-start d-flex align-items-center w-100 mb-1"
                  onClick={() => handleAddNode(opt.value)}
                  style={{ fontSize: 11, padding: '4px 8px' }}
                >
                  <i className={`bi ${NODE_ICONS[opt.value]} me-2`} style={{ color: NODE_COLORS[opt.value] }} />
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Center: React Flow canvas */}
            <div style={{ flex: 1, position: 'relative' }}>
              {loaded ? (
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onNodeClick={onNodeClick}
                  onEdgeClick={onEdgeClick}
                  onPaneClick={onPaneClick}
                  nodeTypes={stableNodeTypes}
                  fitView
                  fitViewOptions={{ padding: 0.2 }}
                  snapToGrid
                  snapGrid={[20, 20]}
                  minZoom={0.2}
                  maxZoom={2}
                  deleteKeyCode="Delete"
                >
                  <Controls position="bottom-left" />
                  <Background gap={20} size={1} />
                  <MiniMap
                    nodeColor={n => NODE_COLORS[n.data?.kind as WorkflowNodeKind] || '#6c757d'}
                    style={{ background: '#f8f9fa' }}
                    position="bottom-right"
                  />
                </ReactFlow>
              ) : (
                <div className="d-flex align-items-center justify-content-center h-100">
                  <div className="spinner-border text-primary" />
                </div>
              )}
            </div>

            {/* Right: Property editor */}
            <div style={{ width: 300, borderLeft: '1px solid #dee2e6', background: '#fff', overflowY: 'auto', flexShrink: 0 }}>
              <PropertyEditor
                node={selectedNode}
                edge={selectedEdge}
                onUpdateNode={handleUpdateNode}
                onUpdateEdge={handleUpdateEdge}
                onDeleteNode={handleDeleteNode}
                onDeleteEdge={handleDeleteEdge}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Exported modal wrapper with provider
// ═══════════════════════════════════════════════════════════════════

export function WorkflowCanvasModal(props: WorkflowCanvasModalProps) {
  if (!props.open) return null;
  return (
    <ReactFlowProvider>
      <WorkflowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
