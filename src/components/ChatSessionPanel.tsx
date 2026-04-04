'use client';

import React, { useState, useMemo } from 'react';
import type { PlanState, ReviewRound } from './PlanDisplay';

// ─── Types ───────────────────────────────────────────────────────

/** A single message exchange between app and AI */
export interface Exchange {
  role: 'system' | 'user' | 'assistant' | 'tool-result';
  label: string;
  content: string;
  phase: string;
  round?: number;
}

/** Group of exchanges under one user prompt */
export interface ExchangeGroup {
  userPrompt: string;
  timestamp: number;
  exchanges: Exchange[];
  planState?: PlanState;
}

interface ChatSessionPanelProps {
  groups: ExchangeGroup[];
  open: boolean;
  onClose: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Pretty-print JSON if valid, else return raw */
function formatContent(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

function phaseColor(phase: string): string {
  switch (phase) {
    case 'understand': return '#6f42c1';
    case 'gather':     return '#0d6efd';
    case 'plan':       return '#198754';
    case 'execute':    return '#fd7e14';
    default:           return '#6c757d';
  }
}

function roleIcon(role: string): string {
  switch (role) {
    case 'system':      return 'bi-gear-fill';
    case 'user':        return 'bi-arrow-right-circle-fill';
    case 'assistant':   return 'bi-arrow-left-circle-fill';
    case 'tool-result': return 'bi-wrench';
    default:            return 'bi-chat';
  }
}

function roleColor(role: string): string {
  switch (role) {
    case 'system':      return '#6c757d';
    case 'user':        return '#e67e22';
    case 'assistant':   return '#198754';
    case 'tool-result': return '#0d6efd';
    default:            return '#333';
  }
}

function roleBg(role: string): string {
  switch (role) {
    case 'system':      return '#f8f9fa';
    case 'user':        return '#fff8e1';
    case 'assistant':   return '#e8f5e9';
    case 'tool-result': return '#e7f1ff';
    default:            return '#fff';
  }
}

// ─── Single Exchange display ─────────────────────────────────────
function ExchangeCard({ ex }: { ex: Exchange }) {
  const [expanded, setExpanded] = useState(false);
  const formatted = useMemo(() => formatContent(ex.content), [ex.content]);
  const isLong = formatted.length > 300;

  return (
    <div
      className="mb-2 rounded"
      style={{
        border: `1px solid ${roleColor(ex.role)}33`,
        background: roleBg(ex.role),
        fontSize: '0.78rem',
      }}
    >
      {/* Header */}
      <div
        className="d-flex align-items-center gap-2 px-2 py-1"
        style={{
          borderBottom: `1px solid ${roleColor(ex.role)}22`,
          cursor: isLong ? 'pointer' : 'default',
        }}
        onClick={() => isLong && setExpanded(!expanded)}
      >
        <i className={`bi ${roleIcon(ex.role)}`} style={{ color: roleColor(ex.role) }}></i>
        <span className="fw-semibold" style={{ color: roleColor(ex.role), textTransform: 'capitalize' }}>
          {ex.role === 'tool-result' ? 'Tool Result' : ex.role}
        </span>
        <span className="text-muted" style={{ fontSize: '0.72rem' }}>{ex.label}</span>
        <span
          className="badge ms-auto"
          style={{ background: phaseColor(ex.phase), fontSize: '0.66rem' }}
        >
          {ex.phase}{ex.round != null ? ` R${ex.round}` : ''}
        </span>
        {isLong && (
          <i className={`bi ${expanded ? 'bi-chevron-up' : 'bi-chevron-down'} text-muted`} style={{ fontSize: '0.7rem' }}></i>
        )}
      </div>
      {/* Body */}
      <pre
        className="mb-0 px-2 py-1"
        style={{
          fontSize: '0.72rem',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: expanded || !isLong ? 600 : 120,
          overflow: 'auto',
          transition: 'max-height 0.25s ease',
          background: 'transparent',
          margin: 0,
        }}
      >
        {formatted}
      </pre>
    </div>
  );
}

// ─── Group component ─────────────────────────────────────────────
function GroupCard({ group, index }: { group: ExchangeGroup; index: number }) {
  const [collapsed, setCollapsed] = useState(false);
  const promptPreview = group.userPrompt.length > 80
    ? group.userPrompt.slice(0, 80) + '…'
    : group.userPrompt;

  return (
    <div className="mb-3">
      {/* Group header */}
      <div
        className="d-flex align-items-center gap-2 px-3 py-2 rounded-top"
        style={{
          background: '#343a40',
          color: '#fff',
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setCollapsed(!collapsed)}
      >
        <i className={`bi ${collapsed ? 'bi-chevron-right' : 'bi-chevron-down'}`} style={{ fontSize: '0.8rem' }}></i>
        <span className="badge bg-light text-dark" style={{ fontSize: '0.7rem' }}>#{index + 1}</span>
        <span className="flex-grow-1 text-truncate" style={{ fontSize: '0.82rem' }} title={group.userPrompt}>
          {promptPreview}
        </span>
        <span className="badge bg-secondary" style={{ fontSize: '0.68rem' }}>
          {group.exchanges.length} msg{group.exchanges.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Exchanges */}
      {!collapsed && (
        <div
          className="px-2 py-2 rounded-bottom"
          style={{ background: '#fafafa', border: '1px solid #dee2e6', borderTop: 'none' }}
        >
          {group.exchanges.map((ex, j) => (
            <ExchangeCard key={j} ex={ex} />
          ))}
          {group.exchanges.length === 0 && (
            <div className="text-muted text-center py-3" style={{ fontSize: '0.8rem' }}>
              No exchanges recorded
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main panel ──────────────────────────────────────────────────
export function ChatSessionPanel({ groups, open, onClose }: ChatSessionPanelProps) {
  const [filter, setFilter] = useState<string>('all');

  const phases = ['all', 'understand', 'gather', 'plan', 'execute'];

  const filteredGroups = useMemo(() => {
    if (filter === 'all') return groups;
    return groups.map((g) => ({
      ...g,
      exchanges: g.exchanges.filter((ex) => ex.phase === filter),
    })).filter((g) => g.exchanges.length > 0);
  }, [groups, filter]);

  const totalExchanges = groups.reduce((sum, g) => sum + g.exchanges.length, 0);

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.3)',
            zIndex: 1040,
            transition: 'opacity 0.3s ease',
          }}
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 520,
          maxWidth: '90vw',
          background: '#fff',
          zIndex: 1050,
          boxShadow: '-4px 0 24px rgba(0,0,0,0.15)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div
          className="d-flex align-items-center gap-2 px-3 py-2 border-bottom flex-shrink-0"
          style={{ background: '#f8f9fa' }}
        >
          <i className="bi bi-chat-square-text text-primary" style={{ fontSize: '1.1rem' }}></i>
          <strong className="flex-grow-1" style={{ fontSize: '0.95rem' }}>AI Chat Sessions</strong>
          <span className="badge bg-secondary" style={{ fontSize: '0.72rem' }}>
            {totalExchanges} exchange{totalExchanges !== 1 ? 's' : ''}
          </span>
          <button
            className="btn btn-sm btn-outline-secondary py-0 px-2"
            onClick={onClose}
            title="Close panel"
          >
            <i className="bi bi-x-lg"></i>
          </button>
        </div>

        {/* Phase filter tabs */}
        <div className="d-flex gap-1 px-3 py-2 border-bottom flex-shrink-0" style={{ background: '#fff' }}>
          {phases.map((p) => (
            <button
              key={p}
              className={`btn btn-sm py-0 px-2 ${filter === p ? 'btn-primary' : 'btn-outline-secondary'}`}
              style={{ fontSize: '0.74rem', textTransform: 'capitalize' }}
              onClick={() => setFilter(p)}
            >
              {p}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-grow-1 overflow-auto px-3 py-2">
          {filteredGroups.length === 0 && (
            <div className="text-center text-muted mt-5">
              <i className="bi bi-chat-square" style={{ fontSize: '2.5rem' }}></i>
              <p className="mt-2" style={{ fontSize: '0.88rem' }}>
                {groups.length === 0
                  ? 'No chat sessions yet. Send a message to see AI exchanges here.'
                  : 'No exchanges match this filter.'}
              </p>
            </div>
          )}
          {filteredGroups.map((group, i) => (
            <GroupCard key={i} group={group} index={i} />
          ))}
        </div>

        {/* Footer */}
        <div className="border-top px-3 py-2 flex-shrink-0 d-flex align-items-center" style={{ background: '#f8f9fa' }}>
          <small className="text-muted">
            <i className="bi bi-info-circle me-1"></i>
            Showing raw prompt/response exchanges between app and AI model
          </small>
        </div>
      </div>
    </>
  );
}

// ─── Helper: extract exchange groups from message history ─────────
export function buildExchangeGroups(messages: { role: string; content: string; planState?: PlanState; toolCalls?: any[] }[]): ExchangeGroup[] {
  const groups: ExchangeGroup[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      // Start a new group for each user message
      groups.push({
        userPrompt: msg.content,
        timestamp: Date.now(),
        exchanges: [],
        planState: undefined,
      });
    }

    const currentGroup = groups[groups.length - 1];
    if (!currentGroup) continue;

    if (msg.role === 'user') {
      currentGroup.exchanges.push({
        role: 'user',
        label: 'User prompt',
        content: msg.content,
        phase: 'input',
      });
    }

    // If there's a planState, extract all the round exchanges
    if (msg.planState) {
      currentGroup.planState = msg.planState;
      const ps = msg.planState;

      // Understanding rounds
      if (ps.understandingRounds?.length) {
        for (const r of ps.understandingRounds) {
          currentGroup.exchanges.push({
            role: r.round === 1 ? 'user' : 'user',
            label: r.round === 1 ? 'Initial analysis prompt' : `Review prompt (round ${r.round})`,
            content: r.prompt,
            phase: 'understand',
            round: r.round,
          });
          currentGroup.exchanges.push({
            role: 'assistant',
            label: r.round === 1 ? 'Initial analysis' : `Reviewed analysis (round ${r.round})`,
            content: r.analysis,
            phase: 'understand',
            round: r.round,
          });
        }
      }

      // Gather rounds
      if (ps.gatheredRounds?.length) {
        for (const r of ps.gatheredRounds) {
          currentGroup.exchanges.push({
            role: r.round === 1 ? 'user' : 'user',
            label: r.round === 1 ? 'Tool selection prompt' : `Review prompt (round ${r.round})`,
            content: r.prompt,
            phase: 'gather',
            round: r.round,
          });
          currentGroup.exchanges.push({
            role: 'assistant',
            label: r.round === 1 ? 'Tool selection' : `Reviewed selection (round ${r.round})`,
            content: r.analysis,
            phase: 'gather',
            round: r.round,
          });
        }
      }

      // Plan rounds (includes review since merged)
      if (ps.planRounds?.length) {
        for (const r of ps.planRounds) {
          currentGroup.exchanges.push({
            role: 'user',
            label: r.round === 1 ? 'Planning prompt' : 'Plan review prompt',
            content: r.prompt,
            phase: 'plan',
            round: r.round,
          });
          currentGroup.exchanges.push({
            role: 'assistant',
            label: r.round === 1 ? 'Initial plan' : 'Reviewed & validated plan',
            content: r.analysis,
            phase: 'plan',
            round: r.round,
          });
        }
      }

      // Execution tool calls
      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          currentGroup.exchanges.push({
            role: 'assistant',
            label: `Tool call: ${tc.name}`,
            content: JSON.stringify({ tool: tc.name, arguments: tc.arguments }, null, 2),
            phase: 'execute',
          });
          if (tc.result) {
            currentGroup.exchanges.push({
              role: 'tool-result',
              label: `${tc.name} → ${tc.status}`,
              content: tc.result,
              phase: 'execute',
            });
          }
        }
      }

      // Final assistant reply
      if (msg.content) {
        currentGroup.exchanges.push({
          role: 'assistant',
          label: 'Final response',
          content: msg.content,
          phase: 'execute',
        });
      }
    } else if (msg.role === 'assistant' && !msg.planState) {
      // Simple assistant reply (slash commands etc)
      currentGroup.exchanges.push({
        role: 'assistant',
        label: 'Response',
        content: msg.content,
        phase: 'execute',
      });
    }
  }

  return groups;
}
