import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowEdge,
  WorkflowEdgeType,
  WorkflowContext,
  WorkflowNodeKind,
} from './types';

// ═══════════════════════════════════════════════════════════════════
// WorkflowProcessor — loads a workflow definition and provides
// methods to walk the graph, resolve templates, and read node config.
//
// The route handlers use this to get configurable values from the
// active workflow instead of hardcoding them.
// ═══════════════════════════════════════════════════════════════════

export class WorkflowProcessor {
  private nodeMap: Map<string, WorkflowNode>;
  private edgesBySource: Map<string, WorkflowEdge[]>;
  private edgesByTarget: Map<string, WorkflowEdge[]>;

  constructor(public readonly workflow: WorkflowDefinition) {
    this.nodeMap = new Map(workflow.nodes.map(n => [n.id, n]));
    this.edgesBySource = new Map();
    this.edgesByTarget = new Map();
    for (const edge of workflow.edges) {
      const src = this.edgesBySource.get(edge.source) || [];
      src.push(edge);
      this.edgesBySource.set(edge.source, src);
      const tgt = this.edgesByTarget.get(edge.target) || [];
      tgt.push(edge);
      this.edgesByTarget.set(edge.target, tgt);
    }
  }

  // ─── Node access ──────────────────────────────────────────

  getNode(id: string): WorkflowNode | undefined {
    return this.nodeMap.get(id);
  }

  getNodesByKind(kind: WorkflowNodeKind): WorkflowNode[] {
    return this.workflow.nodes.filter(n => n.kind === kind);
  }

  getStartNode(): WorkflowNode | undefined {
    return this.workflow.nodes.find(n => n.kind === 'start');
  }

  getOutputNode(): WorkflowNode | undefined {
    return this.workflow.nodes.find(n => n.kind === 'output');
  }

  // ─── Edge traversal ───────────────────────────────────────

  getOutgoingEdges(nodeId: string): WorkflowEdge[] {
    return this.edgesBySource.get(nodeId) || [];
  }

  getIncomingEdges(nodeId: string): WorkflowEdge[] {
    return this.edgesByTarget.get(nodeId) || [];
  }

  /** Get the next node(s) from a given node, optionally filtered by edge type */
  getNextNodes(nodeId: string, edgeType?: WorkflowEdgeType): WorkflowNode[] {
    const edges = this.getOutgoingEdges(nodeId);
    const filtered = edgeType ? edges.filter(e => e.type === edgeType) : edges;
    return filtered.map(e => this.nodeMap.get(e.target)).filter(Boolean) as WorkflowNode[];
  }

  /** Follow a specific edge type from a node (e.g., true/false branch) */
  followEdge(nodeId: string, edgeType: WorkflowEdgeType): WorkflowNode | undefined {
    const next = this.getNextNodes(nodeId, edgeType);
    return next[0];
  }

  // ─── Template resolution ──────────────────────────────────

  /** Resolve {{variable}} placeholders in a template string */
  resolveTemplate(template: string, ctx: Partial<WorkflowContext>): string {
    return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, path: string) => {
      const parts = path.split('.');
      let value: any = ctx;
      for (const part of parts) {
        if (value == null) return '';
        value = value[part];
      }
      if (value == null) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    });
  }

  // ─── Node property helpers ────────────────────────────────

  /** Get effective maxRetries for a node (node override > workflow default) */
  getMaxRetries(nodeId: string): number {
    const node = this.getNode(nodeId);
    if (node?.maxRetries != null) return node.maxRetries;
    return this.workflow.defaults?.maxRetries ?? 0;
  }

  /** Get effective timeout for a node */
  getTimeout(nodeId: string): number {
    const node = this.getNode(nodeId);
    if (node?.timeout != null) return node.timeout;
    return this.workflow.defaults?.timeout ?? 0;
  }

  /** Get effective prompt prefix (node + workflow default combined) */
  getPromptPrefix(nodeId: string): string {
    const node = this.getNode(nodeId);
    const parts: string[] = [];
    if (this.workflow.defaults?.promptPrefix) parts.push(this.workflow.defaults.promptPrefix);
    if (node?.promptPrefix) parts.push(node.promptPrefix);
    return parts.join('\n');
  }

  /** Get effective prompt suffix */
  getPromptSuffix(nodeId: string): string {
    const node = this.getNode(nodeId);
    const parts: string[] = [];
    if (node?.promptSuffix) parts.push(node.promptSuffix);
    if (this.workflow.defaults?.promptSuffix) parts.push(this.workflow.defaults.promptSuffix);
    return parts.join('\n');
  }

  /** Build full system prompt for a node by combining prefix + template + suffix */
  buildSystemPrompt(nodeId: string, ctx: Partial<WorkflowContext>): string {
    const node = this.getNode(nodeId);
    if (!node) return '';
    const config = node.config as any;
    const template = config.systemPrompt || '';
    const prefix = this.getPromptPrefix(nodeId);
    const suffix = this.getPromptSuffix(nodeId);
    const resolved = this.resolveTemplate(template, ctx);
    return [prefix, resolved, suffix].filter(Boolean).join('\n');
  }

  /** Build full user prompt for a node */
  buildUserPrompt(nodeId: string, ctx: Partial<WorkflowContext>): string {
    const node = this.getNode(nodeId);
    if (!node) return '';
    const config = node.config as any;
    const template = config.userPrompt || '';
    return this.resolveTemplate(template, ctx);
  }

  // ─── Graph traversal (linear walk) ────────────────────────

  /** Walk the graph from start to output, yielding nodes in execution order.
   *  For branching, the caller must handle condition evaluation.
   *  This returns the linear default path. */
  *walkDefault(): Generator<WorkflowNode> {
    const visited = new Set<string>();
    let current = this.getStartNode();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      yield current;
      if (current.kind === 'output') break;
      // Follow 'default' edge, or first available edge
      const outEdges = this.getOutgoingEdges(current.id);
      const defaultEdge = outEdges.find(e => e.type === 'default') || outEdges[0];
      if (!defaultEdge) break;
      current = this.nodeMap.get(defaultEdge.target);
    }
  }

  // ─── Validation ───────────────────────────────────────────

  /** Validate the workflow definition for structural issues */
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const nodeIds = new Set(this.workflow.nodes.map(n => n.id));

    // Must have start and output
    if (!this.getStartNode()) errors.push('Missing start node');
    if (!this.getOutputNode()) errors.push('Missing output node');

    // Check edges reference valid nodes
    for (const edge of this.workflow.edges) {
      if (!nodeIds.has(edge.source)) errors.push(`Edge ${edge.id}: source "${edge.source}" not found`);
      if (!nodeIds.has(edge.target)) errors.push(`Edge ${edge.id}: target "${edge.target}" not found`);
    }

    // Check for orphan nodes (no incoming or outgoing edges, except start/output)
    for (const node of this.workflow.nodes) {
      if (node.kind === 'start') continue;
      const incoming = this.getIncomingEdges(node.id);
      if (incoming.length === 0) errors.push(`Node "${node.id}" has no incoming edges`);
    }
    for (const node of this.workflow.nodes) {
      if (node.kind === 'output') continue;
      const outgoing = this.getOutgoingEdges(node.id);
      if (outgoing.length === 0) errors.push(`Node "${node.id}" has no outgoing edges`);
    }

    // Condition nodes must have both true/false edges
    for (const node of this.workflow.nodes) {
      if (node.kind === 'condition') {
        const outEdges = this.getOutgoingEdges(node.id);
        const types = new Set(outEdges.map(e => e.type));
        if (!types.has('true')) errors.push(`Condition node "${node.id}" missing 'true' edge`);
        if (!types.has('false')) errors.push(`Condition node "${node.id}" missing 'false' edge`);
      }
    }

    // Loop nodes need loop_body and loop_exit edges
    for (const node of this.workflow.nodes) {
      if (node.kind === 'loop') {
        const outEdges = this.getOutgoingEdges(node.id);
        const types = new Set(outEdges.map(e => e.type));
        if (!types.has('loop_body')) errors.push(`Loop node "${node.id}" missing 'loop_body' edge`);
        if (!types.has('loop_exit')) errors.push(`Loop node "${node.id}" missing 'loop_exit' edge`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // ─── Serialization ────────────────────────────────────────

  /** Export the workflow as a plain JSON object */
  toJSON(): WorkflowDefinition {
    return { ...this.workflow };
  }

  /** Create a processor from a JSON definition */
  static fromJSON(json: WorkflowDefinition): WorkflowProcessor {
    return new WorkflowProcessor(json);
  }
}
