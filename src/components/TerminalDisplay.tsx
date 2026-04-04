'use client';

import React, { useEffect, useRef } from 'react';

// ─── Types ───────────────────────────────────────────────────────
export interface TerminalStep {
  stepIndex: number;
  action: string;
  toolName: string;
  args: Record<string, unknown>;
  status: 'pending' | 'running' | 'success' | 'error';
  result?: string;
  startedAt?: number;
  finishedAt?: number;
}

interface TerminalDisplayProps {
  steps: TerminalStep[];
}

// ─── ANSI-style colour helpers ───────────────────────────────────
const C = {
  prompt: '#22c55e',   // green
  cmd: '#60a5fa',      // blue
  arg: '#fbbf24',      // amber
  err: '#ef4444',      // red
  ok: '#34d399',       // emerald
  dim: '#6b7280',      // grey
  white: '#e5e7eb',
  cyan: '#22d3ee',
  muted: '#9ca3af',
};

function elapsed(step: TerminalStep): string {
  if (!step.startedAt) return '';
  const end = step.finishedAt ?? Date.now();
  const ms = end - step.startedAt;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => {
      const val = typeof v === 'string'
        ? (v.length > 120 ? `"${v.slice(0, 120)}…"` : `"${v}"`)
        : JSON.stringify(v);
      return `  --${k} ${val}`;
    })
    .join('\n');
}

function formatResult(result: string, status: string): string {
  const lines = result.split('\n');
  const MAX_LINES = 60;
  if (lines.length > MAX_LINES) {
    return lines.slice(0, MAX_LINES).join('\n') + `\n... (${lines.length - MAX_LINES} more lines)`;
  }
  return result;
}

// ─── Single step renderer ────────────────────────────────────────
function StepTerminal({ step }: { step: TerminalStep }) {
  const isRunning = step.status === 'running';
  const isError = step.status === 'error';
  const isSuccess = step.status === 'success';
  const isPending = step.status === 'pending';

  const statusIcon = isRunning ? '⟳' : isError ? '✗' : isSuccess ? '✓' : '○';
  const statusColor = isRunning ? C.cyan : isError ? C.err : isSuccess ? C.ok : C.dim;

  return (
    <div
      style={{
        background: '#0d1117',
        border: `1px solid ${isRunning ? '#1f6feb' : isError ? '#f8514966' : '#30363d'}`,
        borderRadius: 6,
        marginBottom: 12,
        fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", "Consolas", monospace',
        fontSize: '0.8rem',
        overflow: 'hidden',
      }}
    >
      {/* ── Terminal title bar ──────────────────────────────── */}
      <div
        style={{
          background: '#161b22',
          borderBottom: '1px solid #30363d',
          padding: '5px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {/* Traffic lights */}
        <span style={{ display: 'flex', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: isError ? '#f85149' : '#6b7280' }} />
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: isRunning ? '#d29922' : '#6b7280' }} />
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: isSuccess ? '#3fb950' : '#6b7280' }} />
        </span>
        <span style={{ color: C.muted, fontSize: '0.72rem', flex: 1 }}>
          Step {step.stepIndex + 1} — {step.action}
        </span>
        <span style={{ color: statusColor, fontSize: '0.72rem', fontWeight: 600 }}>
          {statusIcon} {step.status.toUpperCase()}
        </span>
        {step.startedAt && (
          <span style={{ color: C.dim, fontSize: '0.68rem' }}>{elapsed(step)}</span>
        )}
      </div>

      {/* ── Terminal body ──────────────────────────────────── */}
      <div style={{ padding: '10px 14px', lineHeight: 1.5 }}>
        {/* Command line */}
        <div style={{ marginBottom: 4 }}>
          <span style={{ color: C.prompt }}>sandbox</span>
          <span style={{ color: C.dim }}>:</span>
          <span style={{ color: C.cyan }}>~</span>
          <span style={{ color: C.dim }}> $ </span>
          <span style={{ color: C.cmd, fontWeight: 600 }}>{step.toolName}</span>
        </div>

        {/* Arguments */}
        {Object.keys(step.args).length > 0 && (
          <pre style={{ color: C.arg, margin: '0 0 6px 18px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {formatArgs(step.args)}
          </pre>
        )}

        {/* Spinner for running */}
        {isRunning && !step.result && (
          <div style={{ color: C.cyan, marginTop: 8 }}>
            <span className="spinner-border spinner-border-sm me-2" style={{ width: 12, height: 12, borderWidth: 2 }} />
            Executing…
          </div>
        )}

        {/* Pending */}
        {isPending && (
          <div style={{ color: C.dim, marginTop: 4, fontStyle: 'italic' }}>
            Waiting…
          </div>
        )}

        {/* Result output */}
        {step.result && (
          <>
            <div style={{ borderTop: '1px solid #21262d', margin: '8px 0', paddingTop: 8 }}>
              <span style={{ color: C.dim, fontSize: '0.7rem' }}>
                {isError ? '── stderr ' : '── stdout '}
                {'─'.repeat(30)}
              </span>
            </div>
            <pre
              style={{
                color: isError ? C.err : C.white,
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 500,
                overflow: 'auto',
              }}
            >
              {formatResult(step.result, step.status)}
            </pre>
          </>
        )}

        {/* Exit code */}
        {(isSuccess || isError) && step.result && (
          <div style={{ marginTop: 8, borderTop: '1px solid #21262d', paddingTop: 6 }}>
            <span style={{ color: C.prompt }}>sandbox</span>
            <span style={{ color: C.dim }}>:</span>
            <span style={{ color: C.cyan }}>~</span>
            <span style={{ color: C.dim }}> $ </span>
            <span style={{ color: C.dim }}>echo $? → </span>
            <span style={{ color: isError ? C.err : C.ok, fontWeight: 700 }}>
              {isError ? '1' : '0'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────
export function TerminalDisplay({ steps }: TerminalDisplayProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [steps]);

  if (steps.length === 0) return null;

  const completed = steps.filter(s => s.status === 'success' || s.status === 'error').length;
  const errors = steps.filter(s => s.status === 'error').length;

  return (
    <div className="mb-3">
      {/* Header */}
      <div className="d-flex align-items-center gap-2 mb-2 ms-2">
        <i className="bi bi-terminal-fill" style={{ color: C.ok, fontSize: '1rem' }} />
        <span style={{ fontWeight: 600, fontSize: '0.88rem', color: '#e5e7eb' }}>
          Execution Terminal
        </span>
        <span className="badge" style={{ background: '#21262d', color: C.muted, fontSize: '0.7rem' }}>
          {completed}/{steps.length} steps
          {errors > 0 && <span style={{ color: C.err }}> ({errors} failed)</span>}
        </span>
      </div>

      {/* All steps — fully visible, no collapsing */}
      {steps.map((step, i) => (
        <StepTerminal key={i} step={step} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
