'use client';

import React, { useState } from 'react';
import { TerminalDisplay, type TerminalStep } from './TerminalDisplay';

// ─── Types ───────────────────────────────────────────────────────
export interface ContinuousStep {
  index: number;
  description: string;
  status: 'pending' | 'deciding' | 'executing' | 'complete' | 'error';
  needsTool?: boolean;
  categories?: string[];
  toolCalls: any[];
  result?: string;
  startedAt?: number;
  finishedAt?: number;
  attempt?: number;
  retryReason?: string;
  walkMode?: boolean;
}

export type ContinuousPhase = 'idle' | 'planning' | 'reviewing' | 'executing' | 'completing' | 'complete' | 'error';

interface ContinuousDisplayProps {
  phase: ContinuousPhase;
  planSummary: string;
  steps: ContinuousStep[];
  currentStepIndex: number;
  memory: string;
  onAbort?: () => void;
}

// ─── Component ───────────────────────────────────────────────────
export function ContinuousDisplay({ phase, planSummary, steps, currentStepIndex, memory, onAbort }: ContinuousDisplayProps) {
  const [showMemory, setShowMemory] = useState(false);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);

  if (phase === 'idle' && steps.length === 0) return null;

  const isRunning = phase !== 'complete' && phase !== 'error' && phase !== 'idle';
  const isComplete = phase === 'complete';
  const completedSteps = steps.filter(s => s.status === 'complete').length;
  const totalSteps = steps.length;
  const overallProgress = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

  const phaseLabel = {
    idle: 'Ready',
    planning: 'Planning...',
    reviewing: 'Reviewing plan...',
    executing: `Executing step ${currentStepIndex}/${totalSteps}`,
    completing: 'Compiling answer...',
    complete: 'Complete',
    error: 'Error',
  }[phase];

  return (
    <div
      className="card mb-3 ms-4 border-0"
      style={{
        maxWidth: '85%',
        background: '#0d1117',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {/* ── Header ─────────────────────────────────────── */}
      <div
        className="d-flex align-items-center gap-2 px-3 py-2"
        style={{
          background: isComplete ? '#0f5132' : '#1a1e24',
          borderBottom: '1px solid #30363d',
        }}
      >
        <i
          className={`bi ${isComplete ? 'bi-check-circle-fill' : 'bi-arrow-repeat'}`}
          style={{ color: isComplete ? '#3fb950' : '#58a6ff', fontSize: '1rem' }}
        />
        <span style={{ color: '#e5e7eb', fontWeight: 600, fontSize: '0.9rem', flex: 1 }}>
          Continuous Mode
          <span style={{ color: '#8b949e', fontWeight: 400, marginLeft: 8, fontSize: '0.78rem' }}>
            {phaseLabel}
          </span>
        </span>

        {/* Progress bar */}
        {isRunning && totalSteps > 0 && (
          <div style={{ width: 100, height: 6, background: '#21262d', borderRadius: 3, overflow: 'hidden' }}>
            <div
              style={{
                width: `${overallProgress}%`,
                height: '100%',
                background: '#58a6ff',
                borderRadius: 3,
                transition: 'width 0.3s ease',
              }}
            />
          </div>
        )}

        {totalSteps > 0 && (
          <span style={{ color: '#8b949e', fontSize: '0.72rem' }}>
            {completedSteps}/{totalSteps}
          </span>
        )}

        {/* Memory toggle */}
        <button
          className="btn btn-sm py-0 px-2"
          style={{
            background: showMemory ? '#1f6feb' : 'transparent',
            border: '1px solid #30363d',
            color: showMemory ? '#fff' : '#8b949e',
            fontSize: '0.72rem',
          }}
          onClick={() => setShowMemory(!showMemory)}
          title="Toggle memory view"
        >
          <i className="bi bi-journal-text me-1" />Memory
        </button>

        {/* Abort */}
        {isRunning && onAbort && (
          <button
            className="btn btn-sm btn-outline-danger py-0 px-2"
            style={{ fontSize: '0.72rem' }}
            onClick={onAbort}
          >
            <i className="bi bi-stop-fill me-1" />Stop
          </button>
        )}
      </div>

      {/* ── Memory panel ────────────────────────────────── */}
      {showMemory && memory && (
        <div
          style={{
            background: '#161b22',
            borderBottom: '1px solid #30363d',
            padding: '10px 14px',
            maxHeight: 250,
            overflow: 'auto',
          }}
        >
          <div className="d-flex align-items-center gap-2 mb-2">
            <i className="bi bi-journal-text" style={{ color: '#d29922' }} />
            <span style={{ color: '#d29922', fontWeight: 600, fontSize: '0.78rem' }}>MEMORY.md</span>
          </div>
          <pre
            style={{
              color: '#c9d1d9',
              fontSize: '0.72rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: 0,
              fontFamily: '"Cascadia Code", "Fira Code", monospace',
            }}
          >
            {memory}
          </pre>
        </div>
      )}

      {/* ── Plan summary ────────────────────────────────── */}
      {planSummary && (
        <div
          style={{
            background: '#161b22',
            borderBottom: '1px solid #30363d',
            padding: '8px 14px',
          }}
        >
          <div style={{ color: '#d2a8ff', fontSize: '0.76rem', fontWeight: 600 }}>
            <i className="bi bi-clipboard-check me-1" />Plan: {planSummary}
          </div>
        </div>
      )}

      {/* ── Steps list ──────────────────────────────────── */}
      <div style={{ padding: '8px 12px' }}>
        {/* Planning spinner (before steps arrive) */}
        {(phase === 'planning' || phase === 'reviewing') && steps.length === 0 && (
          <div className="d-flex align-items-center gap-2 py-2">
            <span className="spinner-border spinner-border-sm" style={{ width: 14, height: 14, borderWidth: 2, color: '#58a6ff' }} />
            <span style={{ color: '#8b949e', fontSize: '0.82rem' }}>
              {phase === 'planning' ? 'Creating execution plan...' : 'Reviewing plan...'}
            </span>
          </div>
        )}

        {steps.map((step) => (
          <StepCard
            key={step.index}
            step={step}
            isCurrent={step.index === currentStepIndex && isRunning}
            isExpanded={expandedStep === step.index}
            onToggle={() => setExpandedStep(expandedStep === step.index ? null : step.index)}
          />
        ))}

        {/* Completing spinner */}
        {phase === 'completing' && (
          <div className="d-flex align-items-center gap-2 py-2 mt-2" style={{ borderTop: '1px solid #21262d' }}>
            <span className="spinner-border spinner-border-sm" style={{ width: 14, height: 14, borderWidth: 2, color: '#3fb950' }} />
            <span style={{ color: '#8b949e', fontSize: '0.82rem' }}>Compiling final response...</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Single step card ────────────────────────────────────────────
function StepCard({ step, isCurrent, isExpanded, onToggle }: {
  step: ContinuousStep;
  isCurrent: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const statusColor = {
    pending: '#6b7280',
    deciding: '#d29922',
    executing: '#58a6ff',
    complete: '#3fb950',
    error: '#f85149',
  }[step.status];

  const statusIcon = {
    pending: 'bi-circle',
    deciding: 'bi-search',
    executing: 'bi-arrow-repeat',
    complete: 'bi-check-circle-fill',
    error: 'bi-x-circle-fill',
  }[step.status];

  const isActive = step.status === 'deciding' || step.status === 'executing';

  // Convert tool calls to terminal steps
  const terminalSteps: TerminalStep[] = (step.toolCalls || []).map((tc: any, i: number) => ({
    stepIndex: i,
    action: tc.name,
    toolName: tc.name,
    args: tc.arguments || {},
    status: tc.status || 'success',
    result: tc.result,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
  }));

  const hasDetails = step.toolCalls.length > 0 || step.result;
  const elapsed = step.startedAt && step.finishedAt
    ? `${((step.finishedAt - step.startedAt) / 1000).toFixed(1)}s`
    : null;

  return (
    <div
      style={{
        marginBottom: 6,
        borderRadius: 6,
        background: isCurrent ? '#161b2244' : 'transparent',
        border: isCurrent ? '1px solid #1f6feb33' : '1px solid transparent',
        padding: '6px 8px',
        cursor: hasDetails ? 'pointer' : 'default',
        transition: 'background 0.15s',
      }}
      onClick={hasDetails ? onToggle : undefined}
    >
      {/* Step header */}
      <div className="d-flex align-items-center gap-2">
        {isActive ? (
          <span className="spinner-border spinner-border-sm" style={{ width: 14, height: 14, borderWidth: 2, color: statusColor }} />
        ) : (
          <i className={`bi ${statusIcon}`} style={{ color: statusColor, fontSize: '0.85rem' }} />
        )}

        <span style={{
          color: step.status === 'pending' ? '#6b7280' : '#e5e7eb',
          fontWeight: 500,
          fontSize: '0.82rem',
          flex: 1,
          opacity: step.status === 'pending' ? 0.6 : 1,
        }}>
          {step.index}. {step.description}
        </span>

        {/* Walk mode badge */}
        {step.walkMode && (
          <span className="badge" style={{ background: '#a371f733', color: '#a371f7', fontSize: '0.62rem' }}>
            🔍 walk
          </span>
        )}

        {/* Attempt badge */}
        {step.attempt && step.attempt > 1 && (
          <span className="badge" style={{ background: '#d2992233', color: '#d29922', fontSize: '0.62rem' }}>
            attempt {step.attempt}
          </span>
        )}

        {/* Category badge */}
        {step.categories && step.categories.length > 0 && (
          <span className="badge" style={{ background: '#1f6feb33', color: '#58a6ff', fontSize: '0.66rem' }}>
            {step.categories[0]}
          </span>
        )}

        {/* Tool count */}
        {step.toolCalls.length > 0 && (
          <span style={{ color: '#8b949e', fontSize: '0.68rem' }}>
            <i className="bi bi-wrench me-1" />{step.toolCalls.length}
          </span>
        )}

        {elapsed && (
          <span style={{ color: '#6b7280', fontSize: '0.68rem' }}>{elapsed}</span>
        )}

        {hasDetails && (
          <i
            className={`bi bi-chevron-${isExpanded ? 'up' : 'down'}`}
            style={{ color: '#6b7280', fontSize: '0.7rem' }}
          />
        )}
      </div>

      {/* Retry reason */}
      {step.retryReason && (
        <div style={{ marginTop: 4, paddingLeft: 24, color: '#d29922', fontSize: '0.72rem', fontStyle: 'italic' }}>
          <i className="bi bi-arrow-repeat me-1" />Retried: {step.retryReason}
        </div>
      )}

      {/* Expanded details */}
      {isExpanded && (
        <div style={{ marginTop: 8, paddingLeft: 24 }}>
          {/* Tool calls via TerminalDisplay */}
          {terminalSteps.length > 0 && (
            <TerminalDisplay steps={terminalSteps} />
          )}

          {/* Step result */}
          {step.result && (
            <div
              style={{
                background: '#1c2128',
                borderRadius: 4,
                padding: '6px 10px',
                marginTop: 6,
                borderLeft: `3px solid ${step.status === 'error' ? '#f85149' : '#3fb950'}`,
              }}
            >
              <div style={{ color: '#8b949e', fontSize: '0.7rem', fontWeight: 600, marginBottom: 2 }}>
                <i className="bi bi-chat-left-text me-1" />RESULT
              </div>
              <div style={{ color: '#c9d1d9', fontSize: '0.76rem', lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>
                {step.result.length > 600 ? step.result.slice(0, 600) + '…' : step.result}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
