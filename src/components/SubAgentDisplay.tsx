'use client';

import React, { useState } from 'react';
import { type PlanState, type PlanPhase, INITIAL_PLAN_STATE } from './PlanDisplay';

// ─── Sub-agent types ─────────────────────────────────────────────

export interface SubAgentRun {
  /** Which retry attempt this is (1-based) */
  attempt: number;
  /** Current status */
  status: 'running' | 'success' | 'error';
  /** Compact handoff that was sent to the sub-agent */
  handoff: string;
  /** Sub-agent's own phase state */
  planState: PlanState;
  /** Final reply from the sub-agent (null while running) */
  reply: string | null;
  /** Tool calls made by the sub-agent */
  toolCalls: any[];
  /** Error message if the sub-agent itself failed */
  error: string | null;
}

export const MAX_SUB_AGENT_RETRIES = 2;

// ─── Build a compact handoff for a sub-agent ─────────────────────
export function buildHandoff(
  originalPrompt: string,
  planSummary: string | null,
  failedSteps: { action: string; tool: string; error: string }[],
  partialResults: string[],
): string {
  const lines: string[] = [];

  lines.push(`TASK: ${originalPrompt}`);
  lines.push('');

  if (planSummary) {
    lines.push(`PREVIOUS APPROACH: ${planSummary}`);
  }

  if (failedSteps.length > 0) {
    lines.push('');
    lines.push('WHAT FAILED:');
    for (const f of failedSteps) {
      lines.push(`- "${f.action}" using tool ${f.tool}: ${f.error}`);
    }
  }

  if (partialResults.length > 0) {
    lines.push('');
    lines.push('PARTIAL RESULTS (already completed, do NOT redo):');
    for (const r of partialResults) {
      lines.push(`- ${r}`);
    }
  }

  lines.push('');
  lines.push('INSTRUCTIONS: Try a DIFFERENT approach to accomplish the task. Do NOT repeat the same method that failed.');

  return lines.join('\n');
}

// ─── Sub-agent phase display ─────────────────────────────────────

const PHASES: { id: PlanPhase; label: string; icon: string }[] = [
  { id: 'understand', label: 'Reanalyze', icon: 'bi-chat-left-text' },
  { id: 'gather', label: 'Gather', icon: 'bi-collection' },
  { id: 'plan', label: 'Replan', icon: 'bi-list-check' },
  { id: 'execute', label: 'Execute', icon: 'bi-play-circle' },
];

interface SubAgentDisplayProps {
  runs: SubAgentRun[];
  onAbort?: () => void;
}

export function SubAgentDisplay({ runs, onAbort }: SubAgentDisplayProps) {
  const [expandedRun, setExpandedRun] = useState<number | null>(null);
  const [showHandoff, setShowHandoff] = useState<number | null>(null);

  if (runs.length === 0) return null;

  return (
    <div className="ms-3 mb-3">
      {runs.map((run, idx) => {
        const isExpanded = expandedRun === idx;
        const isRunning = run.status === 'running';
        const isActive = isRunning;

        return (
          <div key={idx} className="card border-start border-4 mb-2" style={{
            borderLeftColor: isRunning ? '#ffc107' : run.status === 'success' ? '#198754' : '#dc3545',
            background: '#fefcf3',
          }}>
            <div className="card-body p-2">
              {/* Header row */}
              <div className="d-flex align-items-center justify-content-between">
                <div className="d-flex align-items-center gap-2">
                  {isRunning && (
                    <div className="spinner-border spinner-border-sm text-warning" />
                  )}
                  {run.status === 'success' && (
                    <i className="bi bi-check-circle-fill text-success" />
                  )}
                  {run.status === 'error' && (
                    <i className="bi bi-x-circle-fill text-danger" />
                  )}
                  <strong style={{ fontSize: '0.85rem' }}>
                    <i className="bi bi-arrow-return-right me-1 text-muted"></i>
                    Sub-Agent #{run.attempt}
                  </strong>
                  <span className="badge bg-secondary" style={{ fontSize: '0.7rem' }}>
                    {isRunning ? 'Running' : run.status === 'success' ? 'Done' : 'Failed'}
                  </span>
                </div>
                <div className="d-flex gap-1">
                  <button
                    className="btn btn-sm btn-outline-secondary py-0 px-1"
                    style={{ fontSize: '0.72rem' }}
                    onClick={() => setShowHandoff(showHandoff === idx ? null : idx)}
                    title="View handoff context"
                  >
                    <i className="bi bi-envelope-open me-1"></i>Handoff
                  </button>
                  <button
                    className="btn btn-sm btn-outline-secondary py-0 px-1"
                    style={{ fontSize: '0.72rem' }}
                    onClick={() => setExpandedRun(isExpanded ? null : idx)}
                  >
                    <i className={`bi bi-chevron-${isExpanded ? 'up' : 'down'}`}></i>
                  </button>
                  {isRunning && onAbort && (
                    <button
                      className="btn btn-sm btn-outline-danger py-0 px-1"
                      style={{ fontSize: '0.72rem' }}
                      onClick={onAbort}
                      title="Abort sub-agent"
                    >
                      <i className="bi bi-stop-fill"></i>
                    </button>
                  )}
                </div>
              </div>

              {/* Handoff view */}
              {showHandoff === idx && (
                <div className="mt-2 p-2 rounded" style={{ background: '#f8f0d8', fontSize: '0.78rem' }}>
                  <strong className="d-block mb-1 text-muted">Handoff Context:</strong>
                  <pre className="mb-0" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: '0.76rem' }}>
                    {run.handoff}
                  </pre>
                </div>
              )}

              {/* Mini phase progress */}
              <div className="d-flex gap-1 mt-2">
                {PHASES.map((phase) => {
                  const ps = run.planState;
                  const isDone = ps.completedPhases.includes(phase.id);
                  const isCurrent = ps.currentPhase === phase.id;

                  return (
                    <div
                      key={phase.id}
                      className="d-flex align-items-center gap-1 px-2 py-1 rounded"
                      style={{
                        fontSize: '0.72rem',
                        background: isCurrent ? '#fff3cd' : isDone ? '#d1e7dd' : '#e9ecef',
                        color: isCurrent ? '#856404' : isDone ? '#0f5132' : '#6c757d',
                        transition: 'all 0.2s ease',
                      }}
                    >
                      {isCurrent && <div className="spinner-border spinner-border-sm" style={{ width: 10, height: 10, borderWidth: 2 }} />}
                      {isDone && <i className="bi bi-check" style={{ fontSize: '0.7rem' }} />}
                      <i className={`bi ${phase.icon}`} style={{ fontSize: '0.7rem' }} />
                      <span>{phase.label}</span>
                    </div>
                  );
                })}
              </div>

              {/* Error display */}
              {run.error && (
                <div className="alert alert-danger mt-2 mb-0 py-1 px-2" style={{ fontSize: '0.78rem' }}>
                  <i className="bi bi-exclamation-triangle me-1"></i>{run.error}
                </div>
              )}

              {/* Expanded details */}
              {isExpanded && (
                <div className="mt-2" style={{ fontSize: '0.78rem' }}>
                  {/* Understanding summary */}
                  {run.planState.understanding && (
                    <div className="mb-2">
                      <strong className="text-muted d-block">Understanding:</strong>
                      <span>{run.planState.understanding.summary}</span>
                    </div>
                  )}

                  {/* Plan steps */}
                  {run.planState.plan?.steps && (
                    <div className="mb-2">
                      <strong className="text-muted d-block">Plan:</strong>
                      <ol className="mb-0 ps-3" style={{ fontSize: '0.76rem' }}>
                        {run.planState.plan.steps.map((step: any, si: number) => (
                          <li key={si} className={si < run.planState.executingStep ? 'text-success' : ''}>
                            {step.action}
                            {step.tool !== 'none' && (
                              <span className="badge bg-info ms-1" style={{ fontSize: '0.65rem' }}>
                                {step.tool}
                              </span>
                            )}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {/* Tool calls */}
                  {run.toolCalls.length > 0 && (
                    <div className="mb-2">
                      <strong className="text-muted d-block">Tool Calls:</strong>
                      {run.toolCalls.map((tc: any, ti: number) => (
                        <div key={ti} className="d-flex align-items-center gap-1 ms-2">
                          <i className={`bi ${tc.status === 'success' ? 'bi-check-circle text-success' : tc.status === 'error' ? 'bi-x-circle text-danger' : 'bi-circle text-muted'}`}
                             style={{ fontSize: '0.7rem' }} />
                          <code style={{ fontSize: '0.72rem' }}>{tc.name}</code>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
