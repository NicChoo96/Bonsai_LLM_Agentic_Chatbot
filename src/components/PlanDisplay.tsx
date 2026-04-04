'use client';

import React, { useState } from 'react';

// ─── Types ───────────────────────────────────────────────────────
export type PlanPhase = 'understand' | 'gather' | 'plan' | 'execute';

export interface ReviewRound {
  round: number;
  prompt: string;
  analysis: string;
  review_notes: string;
}

export interface PlanStep {
  step: number;
  action: string;
  tool: string;
  args: Record<string, unknown> | null;
  depends_on: number[];
}

export interface PlanState {
  /** Which phase is currently running (null = not started) */
  currentPhase: PlanPhase | null;
  /** Completed phases */
  completedPhases: PlanPhase[];
  /** Phase 1 output */
  understanding: {
    summary: string;
    requirements: string[];
    context_needed: string[];
    assumptions?: string[];
    risks?: string[];
    alternative_approaches?: string[];
    suggested_tools?: string[];
    suggested_skills?: string[];
    tool_skill_reasoning?: string;
  } | null;
  /** Phase 1 review rounds */
  understandingRounds: ReviewRound[];
  /** Phase 2 output */
  gathered: {
    selected_tools: string[];
    selected_skills: string[];
    reasoning: string;
  } | null;
  /** Phase 2 review rounds */
  gatheredRounds: ReviewRound[];
  /** Phase 3 output */
  plan: {
    steps: PlanStep[];
    summary: string;
  } | null;
  /** Phase 3 review rounds */
  planRounds: ReviewRound[];
  /** Plan validation (embedded in plan phase) */
  review: {
    verdict: 'pass' | 'fail' | 'needs_correction';
    issues: string[];
    corrected_plan: any;
    reasoning: string;
    confidence: number;
  } | null;
  /** Phase 5: which plan step index is executing */
  executingStep: number;
  /** Whether the user aborted the pipeline */
  aborted: boolean;
  /** Error if any phase fails */
  error: string | null;
}

export const INITIAL_PLAN_STATE: PlanState = {
  currentPhase: null,
  completedPhases: [],
  understanding: null,
  understandingRounds: [],
  gathered: null,
  gatheredRounds: [],
  plan: null,
  planRounds: [],
  review: null,
  executingStep: -1,
  aborted: false,
  error: null,
};

// ─── Phase metadata ──────────────────────────────────────────────
const PHASES: { id: PlanPhase; label: string; icon: string; description: string }[] = [
  { id: 'understand', label: 'Understanding', icon: 'bi-chat-left-text', description: 'Analyzing your request…' },
  { id: 'gather', label: 'Gathering', icon: 'bi-collection', description: 'Collecting tools & skills…' },
  { id: 'plan', label: 'Plan & Review', icon: 'bi-list-check', description: 'Building & validating plan…' },
  { id: 'execute', label: 'Executing', icon: 'bi-play-circle', description: 'Running the plan…' },
];

// ─── Component ───────────────────────────────────────────────────
interface PlanDisplayProps {
  planState: PlanState;
  onAbort?: () => void;
}

// ─── Collapsible review rounds sub-component ─────────────────────
function ReviewRoundsPanel({ rounds, label }: { rounds: ReviewRound[]; label: string }) {
  const [expanded, setExpanded] = useState(false);

  if (!rounds || rounds.length === 0) return null;

  const latestRound = rounds[rounds.length - 1]?.round ?? 1;

  return (
    <div className="ms-2 mt-2">
      <button
        className="btn btn-sm btn-outline-secondary d-flex align-items-center gap-1 py-0 px-2"
        style={{ fontSize: '0.76rem' }}
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <i className={`bi ${expanded ? 'bi-chevron-down' : 'bi-chevron-right'}`}></i>
        <i className="bi bi-braces me-1"></i>
        {label} ({rounds.length} rounds)
      </button>

      {expanded && (
        <div className="mt-1 ms-1" style={{ borderLeft: '2px solid #dee2e6', paddingLeft: 10 }}>
          {rounds.map((r) => {
            let parsed: any = null;
            try { parsed = JSON.parse(r.analysis); } catch { /* raw text */ }

            const isCurrent = r.round === latestRound;
            const isInitial = r.round === 1;

            return (
              <div
                key={r.round}
                className="mb-3 rounded"
                style={{
                  background: isCurrent ? '#e7f1ff' : '#f8f9fa',
                  border: isCurrent ? '1px solid #b6d4fe' : '1px solid #e9ecef',
                  fontSize: '0.78rem',
                }}
              >
                {/* Round header */}
                <div
                  className="d-flex align-items-center gap-2 px-2 py-1"
                  style={{
                    borderBottom: '1px solid #e9ecef',
                    background: isCurrent ? '#cfe2ff' : '#eee',
                    borderRadius: '0.25rem 0.25rem 0 0',
                  }}
                >
                  <span
                    className="badge rounded-pill"
                    style={{
                      fontSize: '0.68rem',
                      background: isCurrent ? '#0d6efd' : '#6c757d',
                      color: '#fff',
                    }}
                  >
                    Round {r.round}
                  </span>
                  <small className="text-muted fst-italic flex-grow-1">{r.review_notes}</small>
                  {isCurrent && (
                    <span className="badge bg-primary" style={{ fontSize: '0.64rem' }}>Latest</span>
                  )}
                </div>

                <div className="p-2">
                  {/* ── Prompt to AI ─────────────────────────── */}
                  {r.prompt && (
                    <details className="mb-2">
                      <summary
                        style={{ cursor: 'pointer', fontSize: '0.76rem' }}
                        className="text-secondary d-flex align-items-center gap-1"
                      >
                        <i className="bi bi-arrow-right-circle text-warning"></i>
                        <span>{isInitial ? 'Prompt to AI' : 'Review prompt to AI'}</span>
                      </summary>
                      <pre
                        className="mb-0 mt-1 p-2 rounded"
                        style={{
                          fontSize: '0.72rem',
                          background: '#fff8e1',
                          border: '1px solid #ffe082',
                          maxHeight: 200,
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        {r.prompt}
                      </pre>
                    </details>
                  )}

                  {/* ── Response from AI ─────────────────────── */}
                  <details open={isCurrent}>
                    <summary
                      style={{ cursor: 'pointer', fontSize: '0.76rem' }}
                      className="text-secondary d-flex align-items-center gap-1"
                    >
                      <i className="bi bi-arrow-left-circle text-success"></i>
                      <span>AI response</span>
                    </summary>
                    {parsed ? (
                      <pre
                        className="mb-0 mt-1 p-2 rounded"
                        style={{
                          fontSize: '0.72rem',
                          background: '#fff',
                          border: '1px solid #e9ecef',
                          maxHeight: 250,
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        {JSON.stringify(parsed, null, 2)}
                      </pre>
                    ) : (
                      <pre
                        className="mb-0 mt-1 p-2 rounded"
                        style={{
                          fontSize: '0.72rem',
                          background: '#fff',
                          border: '1px solid #e9ecef',
                          maxHeight: 250,
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        {r.analysis}
                      </pre>
                    )}
                  </details>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function PlanDisplay({ planState, onAbort }: PlanDisplayProps) {
  const { currentPhase, completedPhases, understanding, gathered, plan, executingStep, error, aborted,
          understandingRounds, gatheredRounds, planRounds, review } = planState;

  if (!currentPhase && completedPhases.length === 0) return null;

  return (
    <div className="card mb-3 border-primary" style={{ fontSize: '0.88rem' }}>
      <div className="card-header bg-primary text-white d-flex align-items-center gap-2 py-2">
        <i className="bi bi-diagram-3"></i>
        <strong>Agent Plan</strong>
        {aborted && (
          <span className="badge bg-danger ms-2">Aborted</span>
        )}
        {currentPhase && onAbort && !aborted && (
          <button
            className="btn btn-sm btn-outline-light ms-auto d-flex align-items-center gap-1"
            onClick={onAbort}
            title="Abort the current pipeline"
          >
            <i className="bi bi-stop-circle"></i>
            Abort
          </button>
        )}
      </div>
      <div className="card-body p-0">
        {/* ── Phase timeline ──────────────────────────────────── */}
        <div className="d-flex border-bottom" style={{ background: '#f8f9fa' }}>
          {PHASES.map((ph, idx) => {
            const isCompleted = completedPhases.includes(ph.id);
            const isActive = currentPhase === ph.id;
            const isPending = !isCompleted && !isActive;
            return (
              <div
                key={ph.id}
                className="flex-fill text-center py-2 px-1"
                style={{
                  borderRight: idx < PHASES.length - 1 ? '1px solid #dee2e6' : undefined,
                  background: isActive ? '#e7f1ff' : isCompleted ? '#d1e7dd' : 'transparent',
                  opacity: isPending ? 0.5 : 1,
                  transition: 'all 0.3s ease',
                }}
              >
                <div className="d-flex align-items-center justify-content-center gap-1">
                  {isActive && <div className="spinner-border spinner-border-sm text-primary" style={{ width: 14, height: 14 }} />}
                  {isCompleted && <i className="bi bi-check-circle-fill text-success" />}
                  {isPending && <i className={`bi ${ph.icon} text-muted`} />}
                  <small className={`fw-semibold ${isActive ? 'text-primary' : isCompleted ? 'text-success' : 'text-muted'}`}>
                    {ph.label}
                  </small>
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Phase 1 output: Understanding ───────────────────── */}
        {understanding && (
          <div className="p-3 border-bottom">
            <div className="d-flex align-items-center gap-2 mb-2">
              <i className="bi bi-chat-left-text text-primary"></i>
              <strong className="text-primary">Understanding</strong>
              <small className="text-muted ms-auto" style={{ fontSize: '0.72rem' }}>
                <i className="bi bi-arrow-repeat me-1"></i>{understandingRounds.length || 4} review rounds
              </small>
            </div>
            <p className="mb-1">{understanding.summary}</p>

            {understanding.requirements.length > 0 && (
              <div className="ms-2 mb-2">
                <small className="text-muted fw-semibold">Requirements:</small>
                <ul className="mb-0 ps-3" style={{ fontSize: '0.84rem' }}>
                  {understanding.requirements.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            )}

            {(understanding.suggested_tools?.length || understanding.suggested_skills?.length) ? (
              <div className="ms-2 mb-2">
                <small className="text-muted fw-semibold">
                  <i className="bi bi-lightbulb me-1"></i>Suggested Tools & Skills:
                </small>
                <div className="d-flex flex-wrap gap-1 mt-1">
                  {(understanding.suggested_tools || []).map((t) => (
                    <span key={t} className="badge bg-info text-dark" style={{ fontSize: '0.76rem' }}>
                      <i className="bi bi-wrench me-1"></i>{t}
                    </span>
                  ))}
                  {(understanding.suggested_skills || []).map((s) => (
                    <span key={s} className="badge bg-warning text-dark" style={{ fontSize: '0.76rem' }}>
                      <i className="bi bi-book me-1"></i>{s}
                    </span>
                  ))}
                </div>
                {understanding.tool_skill_reasoning && (
                  <small className="text-muted d-block mt-1" style={{ fontSize: '0.78rem' }}>
                    {understanding.tool_skill_reasoning}
                  </small>
                )}
              </div>
            ) : null}

            {understanding.assumptions?.length ? (
              <div className="ms-2 mb-2">
                <small className="text-muted fw-semibold">Assumptions:</small>
                <ul className="mb-0 ps-3" style={{ fontSize: '0.84rem' }}>
                  {understanding.assumptions.map((a, i) => (
                    <li key={i} className="text-secondary">{a}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {understanding.risks?.length ? (
              <div className="ms-2">
                <small className="text-muted fw-semibold">
                  <i className="bi bi-exclamation-triangle me-1"></i>Risks:
                </small>
                <ul className="mb-0 ps-3" style={{ fontSize: '0.84rem' }}>
                  {understanding.risks.map((r, i) => (
                    <li key={i} className="text-danger-emphasis">{r}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <ReviewRoundsPanel rounds={understandingRounds} label="Understanding thinking" />
          </div>
        )}

        {/* ── Phase 2 output: Gathered tools/skills ───────────── */}
        {gathered && (
          <div className="p-3 border-bottom">
            <div className="d-flex align-items-center gap-2 mb-2">
              <i className="bi bi-collection text-primary"></i>
              <strong className="text-primary">Gathered Resources</strong>
              <small className="text-muted ms-auto" style={{ fontSize: '0.72rem' }}>
                <i className="bi bi-arrow-repeat me-1"></i>{gatheredRounds.length || 3} review rounds
              </small>
            </div>
            <p className="mb-1 text-muted" style={{ fontSize: '0.82rem' }}>{gathered.reasoning}</p>
            <div className="d-flex flex-wrap gap-1 mt-1">
              {gathered.selected_tools.map((t) => (
                <span key={t} className="badge bg-info text-dark">{t}</span>
              ))}
              {gathered.selected_skills.map((s) => (
                <span key={s} className="badge bg-warning text-dark">{s}</span>
              ))}
              {gathered.selected_tools.length === 0 && gathered.selected_skills.length === 0 && (
                <span className="text-muted">No specific tools/skills selected</span>
              )}
            </div>

            <ReviewRoundsPanel rounds={gatheredRounds} label="Gathering thinking" />
          </div>
        )}

        {/* ── Phase 3 output: Plan steps ──────────────────────── */}
        {plan && (
          <div className="p-3 border-bottom">
            <div className="d-flex align-items-center gap-2 mb-2">
              <i className="bi bi-list-check text-primary"></i>
              <strong className="text-primary">Execution Plan</strong>
              <small className="text-muted ms-auto">
                <span style={{ fontSize: '0.72rem' }}><i className="bi bi-arrow-repeat me-1"></i>{planRounds.length || 3} review rounds</span>
                <span className="ms-2">{plan.summary}</span>
              </small>
            </div>
            <div className="list-group list-group-flush">
              {plan.steps.map((s, idx) => {
                const isDone = currentPhase === 'execute'
                  ? (completedPhases.includes('execute') || idx < executingStep)
                  : completedPhases.includes('execute');
                const isRunning = currentPhase === 'execute' && idx === executingStep;
                return (
                  <div
                    key={s.step}
                    className={`list-group-item d-flex align-items-start gap-2 px-2 py-1 ${isRunning ? 'list-group-item-primary' : isDone ? 'list-group-item-success' : ''}`}
                    style={{ fontSize: '0.84rem', border: 'none', borderBottom: '1px solid #eee' }}
                  >
                    <div style={{ minWidth: 22 }} className="text-center">
                      {isRunning && <div className="spinner-border spinner-border-sm text-primary" style={{ width: 14, height: 14 }} />}
                      {isDone && <i className="bi bi-check-circle-fill text-success" />}
                      {!isRunning && !isDone && (
                        <span className="badge rounded-pill bg-secondary" style={{ fontSize: '0.7rem' }}>{s.step}</span>
                      )}
                    </div>
                    <div>
                      <span>{s.action}</span>
                      {s.tool !== 'none' && (
                        <span className="badge bg-outline-primary text-primary ms-1" style={{ fontSize: '0.72rem', border: '1px solid #0d6efd' }}>
                          {s.tool}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <ReviewRoundsPanel rounds={planRounds} label="Plan & review thinking" />

            {/* ── Inline review verdict (from combined plan+review) ── */}
            {review && (
              <div className="mt-2 pt-2" style={{ borderTop: '1px dashed #dee2e6' }}>
                <div className="d-flex align-items-center gap-2 mb-2">
                  <i className="bi bi-shield-check text-primary" style={{ fontSize: '0.9rem' }}></i>
                  <small className="fw-semibold text-primary">Validation</small>
                  <span
                    className={`badge ${
                      review.verdict === 'pass' ? 'bg-success' :
                      review.verdict === 'needs_correction' ? 'bg-warning text-dark' :
                      'bg-danger'
                    }`}
                    style={{ fontSize: '0.76rem' }}
                  >
                    {review.verdict === 'pass' && <><i className="bi bi-check-circle me-1"></i>Validated</>}
                    {review.verdict === 'needs_correction' && <><i className="bi bi-pencil-square me-1"></i>Corrected</>}
                    {review.verdict === 'fail' && <><i className="bi bi-x-circle me-1"></i>Failed</>}
                  </span>
                  {review.confidence != null && (
                    <span className="badge bg-outline-secondary text-secondary" style={{ fontSize: '0.72rem', border: '1px solid #6c757d' }}>
                      {review.confidence}%
                    </span>
                  )}
                </div>
                {review.reasoning && (
                  <p className="mb-1 text-muted" style={{ fontSize: '0.8rem' }}>{review.reasoning}</p>
                )}
                {review.issues && review.issues.length > 0 && (
                  <div className="ms-2 mb-1">
                    <ul className="mb-0 ps-3" style={{ fontSize: '0.8rem' }}>
                      {review.issues.map((issue, i) => (
                        <li key={i} className="text-danger-emphasis">{issue}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {review.corrected_plan && (
                  <small className="text-success fw-semibold ms-2">
                    <i className="bi bi-arrow-clockwise me-1"></i>Plan was corrected before execution.
                  </small>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Aborted notice ─────────────────────────────────── */}
        {aborted && (
          <div className="p-3 text-danger d-flex align-items-center gap-2">
            <i className="bi bi-stop-circle-fill"></i>
            <span>Pipeline aborted by user{currentPhase ? ` during ${PHASES.find((p) => p.id === currentPhase)?.label || currentPhase}` : ''}.</span>
          </div>
        )}

        {/* ── Error ───────────────────────────────────────────── */}
        {error && !aborted && (
          <div className="p-3 text-danger">
            <i className="bi bi-exclamation-triangle me-1"></i>
            {error}
          </div>
        )}

        {/* ── Active phase description ────────────────────────── */}
        {currentPhase && !error && !aborted && (
          <div className="p-2 text-center">
            <div className="d-flex align-items-center justify-content-center gap-2 text-muted">
              <div className="spinner-border spinner-border-sm" style={{ width: 14, height: 14 }} />
              <small>{PHASES.find((p) => p.id === currentPhase)?.description}</small>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
