// ─── Workflow Node Types ─────────────────────────────────────────
// Every node in a workflow graph is one of these kinds.

export type WorkflowNodeKind =
  | 'start'           // Entry point — receives user input + context
  | 'ai_call'         // AI completion with system/user prompt templates
  | 'tool_select'     // Select tool category (auto-detect or AI-based)
  | 'tool_exec'       // Execute tools via runChatWithTools
  | 'evaluate'        // Evaluate result quality, decide pass/fail
  | 'condition'       // Branch on a textual or boolean condition
  | 'loop'            // Iterate over a dynamic collection (e.g. plan steps)
  | 'memory'          // Memory operation: save, compact, read
  | 'compile'         // Synthesize multiple step results into one
  | 'output'          // Final output / terminal node
  | 'walk_search'     // Progressive filesystem search (walk mode)
  | 'direct_response' // Direct AI response (no tools)
  | 'sub_agent'       // Spawn sub-agent with handoff (plan mode retries)
  | 'phase_gate';     // Plan mode phase boundary (marks end of a phase)

// ─── Edge Types ──────────────────────────────────────────────────
export type WorkflowEdgeType =
  | 'default'    // Normal sequential flow
  | 'success'    // Evaluation passed
  | 'failure'    // Evaluation failed / retry
  | 'true'       // Condition evaluated true
  | 'false'      // Condition evaluated false
  | 'loop_body'  // Edge into loop body
  | 'loop_exit'; // Edge out of loop when done

// ─── Node Configuration ─────────────────────────────────────────
// Each node kind has its own config shape. The base properties
// are shared across all nodes.

export interface WorkflowNodeBase {
  id: string;
  kind: WorkflowNodeKind;
  label: string;
  description?: string;

  // ── Configurable properties ──
  promptPrefix?: string;   // Text prepended to the system prompt
  promptSuffix?: string;   // Text appended to the system prompt
  maxRetries?: number;     // Retry count on failure (default 0)
  timeout?: number;        // Timeout in ms (0 = no limit)

  // ── React Flow layout ──
  position: { x: number; y: number };
}

// Config-specific interfaces per node kind:

export interface StartNodeConfig {
  /** Template variables available at start: userPrompt, selectedFiles, skills, fileList, bootstrapContext, skillContext, categoryDocs */
  collectsContext: true;
}

export interface AiCallNodeConfig {
  /** System prompt template — may use {{variable}} placeholders */
  systemPrompt: string;
  /** User prompt template */
  userPrompt: string;
  /** Expected response format: 'json' | 'text' */
  responseFormat?: 'json' | 'text';
  /** JSON schema hint (for structured output) */
  jsonSchema?: string;
}

export interface ToolSelectNodeConfig {
  /** Auto-detect regex pattern — if matches step desc, skip AI call */
  autoDetectPattern?: string;
  /** Category to assign when auto-detect matches */
  autoDetectCategory?: string;
  /** Prompt template for AI-based category selection */
  decisionPrompt?: string;
}

export interface ToolExecNodeConfig {
  /** Explicit tool names to include (in addition to category tools) */
  additionalTools?: string[];
  /** Tool names to always exclude */
  excludeTools?: string[];
  /** Max iterations for the tool execution loop */
  maxIterations?: number;
  /** Inject open_app for open/launch steps */
  autoInjectOpenApp?: boolean;
}

export interface EvaluateNodeConfig {
  /** System prompt for evaluation */
  evaluationPrompt?: string;
  /** Strictness: 'strict' requires definitive success, 'lenient' accepts partial */
  strictness?: 'strict' | 'lenient';
  /** Allow cross-category retry */
  allowCategoryRetry?: boolean;
}

export interface ConditionNodeConfig {
  /** Text condition to evaluate — supports {{variable}} references */
  condition: string;
  /** How to evaluate: 'regex' tests against previous result, 'contains' checks substring, 'ai' asks AI */
  evaluator: 'regex' | 'contains' | 'ai' | 'expression';
}

export interface LoopNodeConfig {
  /** Source collection variable: e.g. 'planSteps' */
  collection: string;
  /** Variable name for current item in each iteration */
  itemVar: string;
  /** Max iterations (safety limit) */
  maxIterations?: number;
}

export interface MemoryNodeConfig {
  /** Operation: 'save' writes to MEMORY.md, 'compact' summarizes, 'read' loads */
  operation: 'save' | 'compact' | 'read';
  /** Compact threshold in characters */
  compactThreshold?: number;
  /** Max compact output length */
  compactMaxChars?: number;
}

export interface CompileNodeConfig {
  /** System prompt for compilation */
  compilePrompt?: string;
  /** Skip compilation for single-step plans */
  skipIfSingleStep?: boolean;
}

export interface WalkSearchNodeConfig {
  /** Walk tools to include */
  walkTools?: string[];
  /** Shell tools for second pass */
  shellTools?: string[];
  /** Max walk passes */
  maxPasses?: number;
}

export interface DirectResponseNodeConfig {
  /** System prompt for direct response */
  systemPrompt?: string;
}

export interface SubAgentNodeConfig {
  /** Max sub-agent retries */
  maxRetries?: number;
  /** Each sub-agent runs the full pipeline */
  fullPipeline?: boolean;
}

export interface PhaseGateNodeConfig {
  /** Phase name for plan mode */
  phaseName: string;
  /** Output key to store result under */
  outputKey: string;
}

// ─── Union types ─────────────────────────────────────────────────

export type WorkflowNodeConfig =
  | StartNodeConfig
  | AiCallNodeConfig
  | ToolSelectNodeConfig
  | ToolExecNodeConfig
  | EvaluateNodeConfig
  | ConditionNodeConfig
  | LoopNodeConfig
  | MemoryNodeConfig
  | CompileNodeConfig
  | WalkSearchNodeConfig
  | DirectResponseNodeConfig
  | SubAgentNodeConfig
  | PhaseGateNodeConfig;

export interface WorkflowNode extends WorkflowNodeBase {
  config: WorkflowNodeConfig;
}

// ─── Edges ───────────────────────────────────────────────────────

export interface WorkflowEdge {
  id: string;
  source: string;      // Source node id
  target: string;      // Target node id
  type: WorkflowEdgeType;
  label?: string;       // Display label on the edge
}

// ─── Workflow Definition ─────────────────────────────────────────

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  mode: 'plan' | 'continuous';
  version: number;
  createdAt: string;
  updatedAt: string;

  nodes: WorkflowNode[];
  edges: WorkflowEdge[];

  /** Global defaults that apply to all nodes unless overridden */
  defaults?: {
    maxRetries?: number;
    timeout?: number;
    promptPrefix?: string;
    promptSuffix?: string;
  };

  /** Whether this is a system default (cannot be deleted, only reset) */
  isDefault?: boolean;
}

// ─── Active Workflow Config ──────────────────────────────────────
// Tracks which workflow is active for each mode

export interface ActiveWorkflowConfig {
  plan: string;        // Workflow ID for plan mode
  continuous: string;  // Workflow ID for continuous mode
}

// ─── Runtime Context ─────────────────────────────────────────────
// Variables available during workflow execution

export interface WorkflowContext {
  userPrompt: string;
  selectedFiles: string[];
  skills: { name: string; content: string }[];
  fileList: string;
  bootstrapContext: string;
  skillContext: string;
  categoryDocs: string;
  memory: string;
  planSteps: any[];
  planSummary: string;
  stepResults: { index: number; description: string; result: string; toolCalls: any[] }[];
  currentStepIndex: number;
  currentStepDesc: string;
  previousStepResult: string;
  triedCategories: string[];
  categoryId: string;
  attempt: number;
  [key: string]: any;  // Extensible for custom variables
}
