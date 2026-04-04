'use client';

import React, { useState } from 'react';
import { TerminalDisplay, type TerminalStep } from './TerminalDisplay';

// ─── Types ───────────────────────────────────────────────────────
export interface ContinuousIteration {
  iteration: number;
  status: 'running' | 'progress' | 'complete' | 'error';
  thinking: string;
  actions: string;
  reply: string;
  toolCalls: any[];
  summary: string;
  progressPct: number;
  startedAt: number;
  finishedAt?: number;
}

interface ContinuousDisplayProps {
  iterations: ContinuousIteration[];
  memory: string;
  onAbort?: () => void;
}

// ─── Component ───────────────────────────────────────────────────
export function ContinuousDisplay({ iterations, memory, onAbort }: ContinuousDisplayProps) {
  const [showMemory, setShowMemory] = useState(false);

  if (iterations.length === 0) return null;

  const current = iterations[iterations.length - 1];
  const isRunning = current?.status === 'running';
  const isComplete = current?.status === 'complete';

  // Compute overall progress
  const overallProgress = isComplete ? 100 : (current?.progressPct || 0);

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
          background: isComplete ? '#0f5132' : isRunning ? '#1a1e24' : '#1a1e24',
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
            {iterations.length} iteration{iterations.length !== 1 ? 's' : ''}
          </span>
        </span>

        {/* Progress bar */}
        {!isComplete && (
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

        <span style={{ color: '#8b949e', fontSize: '0.72rem' }}>
          {overallProgress}%
        </span>

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

      {/* ── Iterations ──────────────────────────────────── */}
      <div style={{ padding: '8px 12px' }}>
        {iterations.map((iter, idx) => (
          <IterationCard key={idx} iteration={iter} isLast={idx === iterations.length - 1} />
        ))}
      </div>
    </div>
  );
}

// ─── Single iteration card ───────────────────────────────────────
function IterationCard({ iteration: iter, isLast }: { iteration: ContinuousIteration; isLast: boolean }) {
  const isRunning = iter.status === 'running';
  const isComplete = iter.status === 'complete';
  const isError = iter.status === 'error';

  const statusColor = isRunning ? '#58a6ff' : isComplete ? '#3fb950' : isError ? '#f85149' : '#d29922';
  const statusIcon = isRunning ? 'bi-arrow-repeat' : isComplete ? 'bi-check-circle' : isError ? 'bi-x-circle' : 'bi-arrow-right-circle';

  // Convert tool calls to terminal steps
  const terminalSteps: TerminalStep[] = (iter.toolCalls || []).map((tc: any, i: number) => ({
    stepIndex: i,
    action: tc.name,
    toolName: tc.name,
    args: tc.arguments || {},
    status: tc.status || 'success',
    result: tc.result,
    startedAt: iter.startedAt,
    finishedAt: iter.finishedAt,
  }));

  return (
    <div
      style={{
        marginBottom: 12,
        borderRadius: 6,
        background: isLast && isRunning ? '#161b2266' : 'transparent',
        border: isLast && isRunning ? '1px solid #1f6feb44' : 'none',
        padding: isLast && isRunning ? 10 : 0,
      }}
    >
      {/* Iteration header */}
      <div className="d-flex align-items-center gap-2 mb-2">
        <i className={`bi ${statusIcon}`} style={{ color: statusColor, fontSize: '0.85rem' }} />
        <span style={{ color: '#e5e7eb', fontWeight: 600, fontSize: '0.82rem' }}>
          Iteration {iter.iteration}
        </span>
        {isRunning && (
          <span className="spinner-border spinner-border-sm" style={{ width: 12, height: 12, borderWidth: 2, color: '#58a6ff' }} />
        )}
        {iter.progressPct > 0 && (
          <span style={{ color: '#8b949e', fontSize: '0.7rem' }}>{iter.progressPct}%</span>
        )}
        {iter.finishedAt && iter.startedAt && (
          <span style={{ color: '#6b7280', fontSize: '0.68rem', marginLeft: 'auto' }}>
            {((iter.finishedAt - iter.startedAt) / 1000).toFixed(1)}s
          </span>
        )}
      </div>

      {/* Thinking */}
      {iter.thinking && (
        <div
          style={{
            background: '#1c2128',
            borderRadius: 4,
            padding: '6px 10px',
            marginBottom: 8,
            borderLeft: '3px solid #58a6ff',
          }}
        >
          <div style={{ color: '#58a6ff', fontSize: '0.7rem', fontWeight: 600, marginBottom: 2 }}>
            <i className="bi bi-lightbulb me-1" />THINKING
          </div>
          <div style={{ color: '#c9d1d9', fontSize: '0.76rem', lineHeight: 1.4 }}>
            {iter.thinking.length > 300 ? iter.thinking.slice(0, 300) + '…' : iter.thinking}
          </div>
        </div>
      )}

      {/* Terminal steps — fully visible */}
      {terminalSteps.length > 0 && (
        <TerminalDisplay steps={terminalSteps} />
      )}

      {/* AI Reply — shown live as each iteration completes */}
      {iter.reply && !isRunning && !isError && (
        <div
          style={{
            background: '#1c2128',
            borderRadius: 4,
            padding: '6px 10px',
            marginTop: 4,
            borderLeft: '3px solid #8b949e',
          }}
        >
          <div style={{ color: '#8b949e', fontSize: '0.7rem', fontWeight: 600, marginBottom: 2 }}>
            <i className="bi bi-chat-left-text me-1" />RESPONSE
          </div>
          <div style={{ color: '#c9d1d9', fontSize: '0.76rem', lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>
            {iter.reply.length > 600 ? iter.reply.slice(0, 600) + '…' : iter.reply}
          </div>
        </div>
      )}

      {/* Summary / Reply */}
      {iter.summary && !isRunning && (
        <div
          style={{
            background: isComplete ? '#0f513222' : '#1c2128',
            borderRadius: 4,
            padding: '6px 10px',
            marginTop: 4,
            borderLeft: `3px solid ${isComplete ? '#3fb950' : '#d29922'}`,
          }}
        >
          <div style={{ color: isComplete ? '#3fb950' : '#d29922', fontSize: '0.7rem', fontWeight: 600, marginBottom: 2 }}>
            <i className={`bi ${isComplete ? 'bi-check2-all' : 'bi-card-text'} me-1`} />
            {isComplete ? 'COMPLETE' : 'SUMMARY'}
          </div>
          <div style={{ color: '#c9d1d9', fontSize: '0.76rem', lineHeight: 1.4 }}>
            {iter.summary}
          </div>
        </div>
      )}

      {/* Error banner */}
      {isError && iter.reply && (
        <div
          style={{
            background: '#f8514922',
            borderRadius: 4,
            padding: '6px 10px',
            marginTop: 4,
            borderLeft: '3px solid #f85149',
          }}
        >
          <div style={{ color: '#f85149', fontSize: '0.7rem', fontWeight: 600, marginBottom: 2 }}>
            <i className="bi bi-exclamation-triangle me-1" />ERROR — will retry
          </div>
          <div style={{ color: '#ffa198', fontSize: '0.74rem' }}>
            {iter.reply.slice(0, 200)}
          </div>
        </div>
      )}
    </div>
  );
}
