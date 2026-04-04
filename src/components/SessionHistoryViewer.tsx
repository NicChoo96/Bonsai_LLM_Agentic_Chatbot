'use client';

import React, { useState, useMemo } from 'react';

// ─── Types matching the saved JSON structure ─────────────────────

interface SavedExchange {
  role: 'system' | 'user' | 'assistant' | 'tool-result';
  label: string;
  content: string;
  phase: string;
  round?: number;
}

interface SavedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
  status: string;
}

interface SavedMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: SavedToolCall[];
  planState?: any;
}

interface SavedGroup {
  userPrompt: string;
  timestamp: number;
  exchanges: SavedExchange[];
  planState?: any;
}

interface SavedSession {
  version: number;
  savedAt: string;
  promptCount: number;
  messageCount: number;
  messages: SavedMessage[];
  exchangeGroups: SavedGroup[];
}

interface Props {
  filePath: string;
  data: SavedSession;
  onClose: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────

function formatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
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
    case 'input':      return '#dc3545';
    default:           return '#6c757d';
  }
}

function roleIcon(role: string): string {
  switch (role) {
    case 'system':      return 'bi-gear-fill';
    case 'user':        return 'bi-person-fill';
    case 'assistant':   return 'bi-robot';
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

// ─── Sub-views ──────────────────────────────────────────────────

type ViewTab = 'overview' | 'exchanges' | 'messages' | 'plan';

// ── Overview tab ─────────────────────────────────────────────────
function OverviewView({ data }: { data: SavedSession }) {
  const totalExchanges = data.exchangeGroups.reduce((s, g) => s + g.exchanges.length, 0);
  const phases = new Set<string>();
  for (const g of data.exchangeGroups) {
    for (const ex of g.exchanges) phases.add(ex.phase);
  }
  const totalToolCalls = data.messages.reduce((s, m) => s + (m.toolCalls?.length || 0), 0);

  return (
    <div className="p-3">
      <h5 className="mb-3"><i className="bi bi-bar-chart me-2 text-primary"></i>Session Overview</h5>
      <div className="row g-3 mb-4">
        <div className="col-6 col-md-3">
          <div className="card text-center h-100">
            <div className="card-body p-2">
              <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#0d6efd' }}>{data.promptCount}</div>
              <small className="text-muted">Prompts</small>
            </div>
          </div>
        </div>
        <div className="col-6 col-md-3">
          <div className="card text-center h-100">
            <div className="card-body p-2">
              <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#198754' }}>{data.messageCount}</div>
              <small className="text-muted">Messages</small>
            </div>
          </div>
        </div>
        <div className="col-6 col-md-3">
          <div className="card text-center h-100">
            <div className="card-body p-2">
              <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#6f42c1' }}>{totalExchanges}</div>
              <small className="text-muted">AI Exchanges</small>
            </div>
          </div>
        </div>
        <div className="col-6 col-md-3">
          <div className="card text-center h-100">
            <div className="card-body p-2">
              <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#fd7e14' }}>{totalToolCalls}</div>
              <small className="text-muted">Tool Calls</small>
            </div>
          </div>
        </div>
      </div>

      <div className="card mb-3">
        <div className="card-header py-2"><strong>Session Info</strong></div>
        <ul className="list-group list-group-flush" style={{ fontSize: '0.88rem' }}>
          <li className="list-group-item d-flex justify-content-between">
            <span className="text-muted">Saved at</span>
            <span>{new Date(data.savedAt).toLocaleString()}</span>
          </li>
          <li className="list-group-item d-flex justify-content-between">
            <span className="text-muted">Format version</span>
            <span>{data.version}</span>
          </li>
          <li className="list-group-item d-flex justify-content-between">
            <span className="text-muted">Phases used</span>
            <span>{[...phases].join(', ') || 'none'}</span>
          </li>
        </ul>
      </div>

      <h6 className="text-muted mb-2">Prompt Summary</h6>
      {data.exchangeGroups.map((g, i) => (
        <div key={i} className="card mb-2">
          <div className="card-body p-2 d-flex align-items-start gap-2">
            <span className="badge bg-dark" style={{ fontSize: '0.72rem' }}>#{i + 1}</span>
            <div className="flex-grow-1">
              <div style={{ fontSize: '0.85rem' }}>{g.userPrompt}</div>
              <small className="text-muted">{g.exchanges.length} exchanges</small>
              {g.planState?.plan?.summary && (
                <div className="text-muted mt-1" style={{ fontSize: '0.78rem' }}>
                  <i className="bi bi-list-check me-1"></i>{g.planState.plan.summary}
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Exchange Card ────────────────────────────────────────────────
function ExchangeCard({ ex }: { ex: SavedExchange }) {
  const [expanded, setExpanded] = useState(false);
  const formatted = useMemo(() => formatJson(ex.content), [ex.content]);
  const isLong = formatted.length > 300;

  return (
    <div className="mb-2 rounded" style={{ border: `1px solid ${roleColor(ex.role)}33`, background: roleBg(ex.role), fontSize: '0.78rem' }}>
      <div
        className="d-flex align-items-center gap-2 px-2 py-1"
        style={{ borderBottom: `1px solid ${roleColor(ex.role)}22`, cursor: isLong ? 'pointer' : 'default' }}
        onClick={() => isLong && setExpanded(!expanded)}
      >
        <i className={`bi ${roleIcon(ex.role)}`} style={{ color: roleColor(ex.role) }}></i>
        <span className="fw-semibold" style={{ color: roleColor(ex.role), textTransform: 'capitalize' }}>
          {ex.role === 'tool-result' ? 'Tool Result' : ex.role}
        </span>
        <span className="text-muted" style={{ fontSize: '0.72rem' }}>{ex.label}</span>
        <span className="badge ms-auto" style={{ background: phaseColor(ex.phase), fontSize: '0.66rem' }}>
          {ex.phase}{ex.round != null ? ` R${ex.round}` : ''}
        </span>
        {isLong && <i className={`bi ${expanded ? 'bi-chevron-up' : 'bi-chevron-down'} text-muted`} style={{ fontSize: '0.7rem' }}></i>}
      </div>
      <pre className="mb-0 px-2 py-1" style={{
        fontSize: '0.72rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        maxHeight: expanded || !isLong ? 600 : 120, overflow: 'auto',
        transition: 'max-height 0.25s ease', background: 'transparent', margin: 0,
      }}>
        {formatted}
      </pre>
    </div>
  );
}

// ── Exchanges tab ────────────────────────────────────────────────
function ExchangesView({ data }: { data: SavedSession }) {
  const [selectedGroup, setSelectedGroup] = useState<number>(0);
  const [phaseFilter, setPhaseFilter] = useState<string>('all');
  const phases = ['all', 'input', 'understand', 'gather', 'plan', 'execute'];

  const group = data.exchangeGroups[selectedGroup];
  const filtered = !group ? [] :
    phaseFilter === 'all' ? group.exchanges : group.exchanges.filter((e) => e.phase === phaseFilter);

  return (
    <div className="d-flex flex-column h-100">
      {/* Group selector */}
      <div className="border-bottom px-3 py-2 flex-shrink-0" style={{ background: '#f8f9fa' }}>
        <div className="d-flex align-items-center gap-2 flex-wrap">
          <small className="text-muted fw-semibold">Prompt:</small>
          {data.exchangeGroups.map((g, i) => (
            <button
              key={i}
              className={`btn btn-sm py-0 px-2 ${selectedGroup === i ? 'btn-dark' : 'btn-outline-secondary'}`}
              style={{ fontSize: '0.74rem' }}
              onClick={() => setSelectedGroup(i)}
            >
              #{i + 1}
            </button>
          ))}
        </div>
        {group && (
          <div className="mt-1 text-truncate" style={{ fontSize: '0.82rem', color: '#333' }} title={group.userPrompt}>
            <i className="bi bi-chat-left-text me-1 text-muted"></i>{group.userPrompt}
          </div>
        )}
      </div>

      {/* Phase filter */}
      <div className="d-flex gap-1 px-3 py-2 border-bottom flex-shrink-0">
        {phases.map((p) => (
          <button
            key={p}
            className={`btn btn-sm py-0 px-2 ${phaseFilter === p ? 'btn-primary' : 'btn-outline-secondary'}`}
            style={{ fontSize: '0.72rem', textTransform: 'capitalize' }}
            onClick={() => setPhaseFilter(p)}
          >
            {p}
          </button>
        ))}
        <span className="ms-auto badge bg-secondary align-self-center" style={{ fontSize: '0.68rem' }}>
          {filtered.length} exchange{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Exchange list */}
      <div className="flex-grow-1 overflow-auto px-3 py-2">
        {filtered.length === 0 && (
          <div className="text-center text-muted mt-4">
            <i className="bi bi-funnel" style={{ fontSize: '2rem' }}></i>
            <p className="mt-2" style={{ fontSize: '0.85rem' }}>No exchanges match this filter.</p>
          </div>
        )}
        {filtered.map((ex, j) => (
          <ExchangeCard key={j} ex={ex} />
        ))}
      </div>
    </div>
  );
}

// ── Messages tab (high-level chat view) ──────────────────────────
function MessagesView({ data }: { data: SavedSession }) {
  return (
    <div className="p-3">
      <h5 className="mb-3"><i className="bi bi-chat-dots me-2 text-primary"></i>Chat Messages</h5>
      {data.messages.map((msg, i) => (
        <div key={i} className="mb-3">
          <div className="d-flex align-items-start gap-2">
            <span
              className="badge rounded-pill mt-1"
              style={{
                background: msg.role === 'user' ? '#e67e22' : '#198754',
                fontSize: '0.72rem', minWidth: 60, textAlign: 'center',
              }}
            >
              {msg.role}
            </span>
            <div className="flex-grow-1" style={{ minWidth: 0 }}>
              <div
                className="rounded p-2"
                style={{
                  background: msg.role === 'user' ? '#fff8e1' : '#e8f5e9',
                  border: `1px solid ${msg.role === 'user' ? '#ffe08255' : '#a5d6a755'}`,
                  fontSize: '0.85rem',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 400,
                  overflow: 'auto',
                }}
              >
                {msg.content}
              </div>
              {/* Tool calls summary */}
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <div className="mt-1 ms-1">
                  {msg.toolCalls.map((tc, j) => (
                    <div key={j} className="d-flex align-items-center gap-1 mb-1" style={{ fontSize: '0.78rem' }}>
                      <i className="bi bi-wrench text-primary"></i>
                      <span className="fw-semibold text-primary">{tc.name}</span>
                      <span className={`badge ${tc.status === 'success' ? 'bg-success' : tc.status === 'error' ? 'bg-danger' : 'bg-secondary'}`}
                        style={{ fontSize: '0.66rem' }}>
                        {tc.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {/* Plan summary badge */}
              {msg.planState?.plan?.summary && (
                <small className="text-muted d-block mt-1 ms-1" style={{ fontSize: '0.76rem' }}>
                  <i className="bi bi-list-check me-1"></i>{msg.planState.plan.summary}
                </small>
              )}
            </div>
          </div>
        </div>
      ))}
      {data.messages.length === 0 && (
        <div className="text-center text-muted mt-4">No messages in this session.</div>
      )}
    </div>
  );
}

// ── Plan Details tab ─────────────────────────────────────────────
function PlanDetailsView({ data }: { data: SavedSession }) {
  // Collect all groups that have plan states
  const planned = data.exchangeGroups.filter((g) => g.planState?.plan);

  return (
    <div className="p-3">
      <h5 className="mb-3"><i className="bi bi-diagram-3 me-2 text-primary"></i>Execution Plans</h5>
      {planned.length === 0 && (
        <div className="text-center text-muted mt-4">No execution plans in this session.</div>
      )}
      {planned.map((g, gi) => {
        const ps = g.planState;
        return (
          <div key={gi} className="card mb-3">
            <div className="card-header d-flex align-items-center gap-2 py-2">
              <span className="badge bg-dark" style={{ fontSize: '0.72rem' }}>#{gi + 1}</span>
              <span className="text-truncate flex-grow-1" style={{ fontSize: '0.85rem' }}>{g.userPrompt}</span>
            </div>
            <div className="card-body p-0">
              {/* Understanding */}
              {ps.understanding && (
                <div className="p-3 border-bottom">
                  <h6 className="mb-1" style={{ fontSize: '0.85rem', color: '#6f42c1' }}>
                    <i className="bi bi-chat-left-text me-1"></i>Understanding
                  </h6>
                  <p className="mb-1" style={{ fontSize: '0.82rem' }}>{ps.understanding.summary}</p>
                  {ps.understanding.requirements?.length > 0 && (
                    <ul className="mb-0 ps-3" style={{ fontSize: '0.8rem' }}>
                      {ps.understanding.requirements.map((r: string, i: number) => <li key={i}>{r}</li>)}
                    </ul>
                  )}
                </div>
              )}

              {/* Gathered */}
              {ps.gathered && (
                <div className="p-3 border-bottom">
                  <h6 className="mb-1" style={{ fontSize: '0.85rem', color: '#0d6efd' }}>
                    <i className="bi bi-collection me-1"></i>Gathered Resources
                  </h6>
                  <div className="d-flex flex-wrap gap-1">
                    {ps.gathered.selected_tools?.map((t: string) => (
                      <span key={t} className="badge bg-info text-dark" style={{ fontSize: '0.74rem' }}>{t}</span>
                    ))}
                    {ps.gathered.selected_skills?.map((s: string) => (
                      <span key={s} className="badge bg-warning text-dark" style={{ fontSize: '0.74rem' }}>{s}</span>
                    ))}
                  </div>
                  <small className="text-muted d-block mt-1">{ps.gathered.reasoning}</small>
                </div>
              )}

              {/* Plan steps */}
              {ps.plan?.steps && (
                <div className="p-3 border-bottom">
                  <h6 className="mb-1" style={{ fontSize: '0.85rem', color: '#198754' }}>
                    <i className="bi bi-list-check me-1"></i>Plan: {ps.plan.summary}
                  </h6>
                  <div className="list-group list-group-flush">
                    {ps.plan.steps.map((s: any, si: number) => (
                      <div key={si} className="list-group-item d-flex gap-2 px-2 py-1" style={{ fontSize: '0.82rem', border: 'none', borderBottom: '1px solid #eee' }}>
                        <span className="badge rounded-pill bg-secondary" style={{ fontSize: '0.68rem', minWidth: 22 }}>{s.step}</span>
                        <div>
                          <span>{s.action}</span>
                          {s.tool !== 'none' && (
                            <span className="badge ms-1" style={{ fontSize: '0.7rem', border: '1px solid #0d6efd', color: '#0d6efd', background: 'transparent' }}>
                              {s.tool}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Review */}
              {ps.review && (
                <div className="p-3">
                  <h6 className="mb-1" style={{ fontSize: '0.85rem' }}>
                    <i className="bi bi-shield-check me-1"></i>Review
                    <span className={`badge ms-2 ${ps.review.verdict === 'pass' ? 'bg-success' : ps.review.verdict === 'needs_correction' ? 'bg-warning text-dark' : 'bg-danger'}`}
                      style={{ fontSize: '0.72rem' }}>
                      {ps.review.verdict}
                    </span>
                    {ps.review.confidence != null && (
                      <span className="badge bg-secondary ms-1" style={{ fontSize: '0.68rem' }}>{ps.review.confidence}%</span>
                    )}
                  </h6>
                  {ps.review.reasoning && (
                    <small className="text-muted">{ps.review.reasoning}</small>
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

// ─── Main Component ──────────────────────────────────────────────
export function SessionHistoryViewer({ filePath, data, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<ViewTab>('overview');

  const fileName = filePath.split('/').pop() || filePath;

  const tabs: { id: ViewTab; label: string; icon: string }[] = [
    { id: 'overview',  label: 'Overview',   icon: 'bi-bar-chart' },
    { id: 'exchanges', label: 'Exchanges',  icon: 'bi-chat-square-text' },
    { id: 'messages',  label: 'Messages',   icon: 'bi-chat-dots' },
    { id: 'plan',      label: 'Plans',      icon: 'bi-diagram-3' },
  ];

  return (
    <div className="d-flex flex-column h-100">
      {/* Header bar */}
      <div className="d-flex align-items-center gap-2 px-3 py-2 border-bottom flex-shrink-0" style={{ background: '#f0f4ff' }}>
        <i className="bi bi-clock-history text-primary" style={{ fontSize: '1.1rem' }}></i>
        <strong className="flex-grow-1 text-truncate" style={{ fontSize: '0.9rem' }} title={filePath}>
          {fileName}
        </strong>
        <button className="btn btn-sm btn-outline-secondary py-0 px-2" onClick={onClose} title="Close history viewer">
          <i className="bi bi-x-lg"></i>
        </button>
      </div>

      {/* Sub-tabs */}
      <div className="d-flex border-bottom flex-shrink-0" style={{ background: '#fafafa' }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            className="btn btn-sm rounded-0 border-0 flex-fill py-2"
            style={{
              fontSize: '0.82rem',
              color: activeTab === t.id ? '#0d6efd' : '#6c757d',
              borderBottom: activeTab === t.id ? '2px solid #0d6efd' : '2px solid transparent',
              background: activeTab === t.id ? '#e7f1ff' : 'transparent',
              transition: 'all 0.15s ease',
            }}
            onClick={() => setActiveTab(t.id)}
          >
            <i className={`bi ${t.icon} me-1`}></i>{t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-grow-1 overflow-auto">
        {activeTab === 'overview' && <OverviewView data={data} />}
        {activeTab === 'exchanges' && <ExchangesView data={data} />}
        {activeTab === 'messages' && <MessagesView data={data} />}
        {activeTab === 'plan' && <PlanDetailsView data={data} />}
      </div>
    </div>
  );
}
