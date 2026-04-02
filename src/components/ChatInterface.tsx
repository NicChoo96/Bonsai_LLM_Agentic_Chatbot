'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { MessageBubble } from './MessageBubble';
import { FileExplorer } from './FileExplorer';
import { FileSelector } from './FileSelector';
import { MarkdownEditor } from './MarkdownEditor';
import { ToolCallDisplay } from './ToolCallDisplay';
import { PlanDisplay, INITIAL_PLAN_STATE, type PlanState } from './PlanDisplay';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: any[];
  planState?: PlanState;
}

export function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [showEditor, setShowEditor] = useState(false);
  const [editingFile, setEditingFile] = useState<{ path: string; content: string } | null>(null);
  const [sidebarTab, setSidebarTab] = useState<'files' | 'tools'>('files');
  const [availableTools, setAvailableTools] = useState<any[]>([]);
  const [availableSkills, setAvailableSkills] = useState<any[]>([]);
  const [fileTreeKey, setFileTreeKey] = useState(0);
  const [slashSuggestions, setSlashSuggestions] = useState<{ label: string; description: string; value: string }[]>([]);
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  const [activePlan, setActivePlan] = useState<PlanState>(INITIAL_PLAN_STATE);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const refreshFiles = useCallback(() => setFileTreeKey((k) => k + 1), []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activePlan]);

  // Load available MCP tools and skills on mount
  useEffect(() => {
    fetch('/api/mcp/execute')
      .then((r) => r.json())
      .then((data) => setAvailableTools(data.tools || []))
      .catch(() => {});
    fetch('/api/skills')
      .then((r) => r.json())
      .then((data) => setAvailableSkills(data.skills || []))
      .catch(() => {});
  }, []);

  // ── Build slash-command suggestions as user types ──────────
  useEffect(() => {
    const trimmed = input.trimStart();
    if (!trimmed.startsWith('/')) {
      setSlashSuggestions([]);
      setSlashSelectedIdx(0);
      return;
    }

    const query = trimmed.slice(1).toLowerCase(); // text after '/'
    const items: { label: string; description: string; value: string }[] = [];

    // Static slash commands
    if ('tools'.startsWith(query)) {
      items.push({ label: '/tools', description: 'List all available MCP tools', value: '/tools' });
    }
    if ('skills'.startsWith(query)) {
      items.push({ label: '/skills', description: 'List all sandbox skill files', value: '/skills' });
    }

    // Individual tool suggestions: /tool:<name>
    for (const t of availableTools) {
      const key = `tools ${t.name}`;
      if (key.startsWith(query) || t.name.toLowerCase().includes(query)) {
        items.push({
          label: `/tools ${t.name}`,
          description: t.description,
          value: `/tools ${t.name}`,
        });
      }
    }

    // Individual skill suggestions: /skills <name>
    for (const s of availableSkills) {
      const key = `skills ${s.name}`;
      if (key.toLowerCase().startsWith(query) || s.name.toLowerCase().includes(query)) {
        items.push({
          label: `/skills ${s.name}`,
          description: `${s.description} (${s.file})`,
          value: `/skills ${s.name}`,
        });
      }
    }

    setSlashSuggestions(items.slice(0, 10));
    setSlashSelectedIdx(0);
  }, [input, availableTools, availableSkills]);

  // ── Slash-command: /tools ──────────────────────────────────────
  const handleToolsCommand = async () => {
    setMessages((prev) => [...prev, { role: 'user', content: '/tools' }]);
    setInput('');
    setLoading(true);
    try {
      const res = await fetch('/api/mcp/execute');
      const data = await res.json();
      const tools = data.tools || [];
      if (tools.length === 0) {
        setMessages((prev) => [...prev, { role: 'assistant', content: 'No tools available.' }]);
      } else {
        const listing = tools
          .map((t: any) => `**${t.name}** — ${t.description}\n  Parameters: ${Object.entries(t.parameters?.properties || {}).map(([k, v]: [string, any]) => `\`${k}\` (${v.type})`).join(', ') || 'none'}`)
          .join('\n\n');
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `### Available Tools\n\n${listing}` },
        ]);
      }
    } catch {
      setMessages((prev) => [...prev, { role: 'assistant', content: 'Failed to fetch tools.' }]);
    } finally {
      setLoading(false);
    }
  };

  // ── Slash-command: /skills ─────────────────────────────────────
  const handleSkillsCommand = async () => {
    setMessages((prev) => [...prev, { role: 'user', content: '/skills' }]);
    setInput('');
    setLoading(true);
    try {
      const res = await fetch('/api/skills');
      const data = await res.json();
      const skills = data.skills || [];
      if (skills.length === 0) {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: 'No skill files found in the sandbox. Create a file with "skill" in its name to register a skill.' },
        ]);
      } else {
        const listing = skills
          .map((s: any) => `**${s.name}** (file: \`${s.file}\`)\n  ${s.description}`)
          .join('\n\n');
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `### Available Skills\n\n${listing}` },
        ]);
      }
    } catch {
      setMessages((prev) => [...prev, { role: 'assistant', content: 'Failed to fetch skills.' }]);
    } finally {
      setLoading(false);
    }
  };

  // ── Helper: call a plan phase ──────────────────────────────────
  const callPlanPhase = async (
    phase: string,
    payload: Record<string, unknown>,
  ): Promise<any> => {
    const res = await fetch('/api/chat/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  };

  // ── Main send handler (always uses 4-phase plan pipeline) ──────
  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    // ── Intercept pure slash commands (not plan-based) ──────────
    if (trimmed.toLowerCase() === '/tools') {
      return handleToolsCommand();
    }
    if (trimmed.toLowerCase() === '/skills') {
      return handleSkillsCommand();
    }

    const userMsg: Message = { role: 'user', content: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    // Reset plan state
    const planState: PlanState = { ...INITIAL_PLAN_STATE };
    setActivePlan({ ...planState });

    // Fetch current skills for planning
    let skillsData: { name: string; content: string }[] = [];
    try {
      const sr = await fetch('/api/skills');
      const sd = await sr.json();
      skillsData = (sd.skills || []).map((s: any) => ({ name: s.name, content: s.content }));
    } catch { /* continue without skills */ }

    // Shared payload fields
    const basePayload = {
      userPrompt: trimmed,
      selectedFiles,
      skills: skillsData,
    };

    try {
      // ═══════════ PHASE 1: UNDERSTAND ═══════════════════════
      planState.currentPhase = 'understand';
      setActivePlan({ ...planState });

      const p1 = await callPlanPhase('understand', { ...basePayload, phase: 'understand', messages: [] });
      planState.understanding = p1.understanding;
      planState.understandingRounds = p1.reviewRounds || [];
      planState.completedPhases = ['understand'];

      // ═══════════ PHASE 2: GATHER TOOLS & SKILLS ════════════
      planState.currentPhase = 'gather';
      setActivePlan({ ...planState });

      const p2 = await callPlanPhase('gather', { ...basePayload, phase: 'gather', messages: [] });
      planState.gathered = p2.gathered;
      planState.gatheredRounds = p2.reviewRounds || [];
      planState.completedPhases = ['understand', 'gather'];

      // ═══════════ PHASE 3: PLAN ═════════════════════════════
      planState.currentPhase = 'plan';
      setActivePlan({ ...planState });

      const p3 = await callPlanPhase('plan', { ...basePayload, phase: 'plan', messages: [] });
      planState.plan = p3.plan;
      planState.planRounds = p3.reviewRounds || [];
      planState.completedPhases = ['understand', 'gather', 'plan'];

      // ═══════════ PHASE 4: REVIEW (validate plan) ═══════════
      planState.currentPhase = 'review';
      setActivePlan({ ...planState });

      const p4 = await callPlanPhase('review', {
        ...basePayload,
        phase: 'review',
        messages: [],
        plan: p3.plan,
        understanding: p1.understanding,
        gathered: p2.gathered,
      });
      planState.review = p4.review;
      planState.reviewValidationRounds = p4.reviewRounds || [];
      planState.completedPhases = ['understand', 'gather', 'plan', 'review'];

      // If the review corrected the plan, use the corrected version
      const finalPlanForExecution = p4.correctedPlan || p3.plan;
      if (p4.correctedPlan) {
        planState.plan = p4.correctedPlan;
      }

      // ═══════════ PHASE 5: EXECUTE ══════════════════════════
      planState.currentPhase = 'execute';
      planState.executingStep = 0;
      setActivePlan({ ...planState });

      // Build the augmented message history for execution
      const augmentedContent = trimmed;
      const execMessages = [...messages, { role: 'user', content: augmentedContent }].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const p5 = await callPlanPhase('execute', {
        ...basePayload,
        phase: 'execute',
        messages: execMessages,
        plan: finalPlanForExecution,
      });

      // Mark all steps done
      planState.executingStep = (finalPlanForExecution?.steps?.length || 1);
      planState.completedPhases = ['understand', 'gather', 'plan', 'review', 'execute'];
      planState.currentPhase = null;

      const finalPlan = { ...planState };
      setActivePlan(finalPlan);

      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: p5.reply,
          toolCalls: p5.toolCalls,
          planState: finalPlan,
        },
      ]);

      if (p5.toolCalls?.length) refreshFiles();
    } catch (err: any) {
      planState.error = err.message || 'Plan execution failed';
      planState.currentPhase = null;
      setActivePlan({ ...planState });

      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error during planning: ${planState.error}` },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // ── Slash-suggestion keyboard navigation ─────────────────
    if (slashSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashSelectedIdx((i) => Math.min(i + 1, slashSuggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const selected = slashSuggestions[slashSelectedIdx];
        if (selected) {
          setInput(selected.value);
          setSlashSuggestions([]);
        }
        return;
      }
      if (e.key === 'Escape') {
        setSlashSuggestions([]);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNewChat = () => {
    setMessages([]);
    setSelectedFiles([]);
  };

  const handleNewFile = () => {
    setEditingFile({ path: '', content: '' });
    setShowEditor(true);
  };

  const handleFileOpen = async (path: string) => {
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(path)}`);
      const data = await res.json();
      if (data.content !== undefined) {
        setEditingFile({ path, content: data.content });
        setShowEditor(true);
      }
    } catch {}
  };

  const handleFileSave = async (path: string, content: string) => {
    await fetch('/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });
    setShowEditor(false);
    setEditingFile(null);
    refreshFiles();
  };

  const handleFileDelete = async (path: string) => {
    await fetch(`/api/files/${encodeURIComponent(path)}`, { method: 'DELETE' });
    refreshFiles();
  };

  return (
    <div className="container-fluid vh-100 d-flex flex-column p-0">
      {/* ── Navbar ─────────────────────────────────────────────── */}
      <nav className="navbar navbar-dark bg-dark px-3 flex-shrink-0">
        <span className="navbar-brand mb-0 h1">
          <i className="bi bi-robot me-2"></i>AI Sandbox Chat
        </span>
        <div className="d-flex gap-2">
          <button className="btn btn-outline-light btn-sm" onClick={handleNewFile}>
            <i className="bi bi-file-earmark-plus me-1"></i>New MD
          </button>
          <button className="btn btn-outline-warning btn-sm" onClick={handleNewChat}>
            <i className="bi bi-arrow-clockwise me-1"></i>New Chat
          </button>
        </div>
      </nav>

      {/* ── Main Layout ───────────────────────────────────────── */}
      <div className="d-flex flex-grow-1 overflow-hidden">
        {/* ── Sidebar ─────────────────────────────────────────── */}
        <div className="bg-light border-end d-flex flex-column flex-shrink-0" style={{ width: 280 }}>
          <ul className="nav nav-tabs px-2 pt-2">
            <li className="nav-item">
              <button
                className={`nav-link ${sidebarTab === 'files' ? 'active' : ''}`}
                onClick={() => setSidebarTab('files')}
              >
                <i className="bi bi-folder me-1"></i>Files
              </button>
            </li>
            <li className="nav-item">
              <button
                className={`nav-link ${sidebarTab === 'tools' ? 'active' : ''}`}
                onClick={() => setSidebarTab('tools')}
              >
                <i className="bi bi-tools me-1"></i>Tools
              </button>
            </li>
          </ul>

          <div className="flex-grow-1 overflow-auto p-2">
            {sidebarTab === 'files' && (
              <>
                <FileSelector
                  selectedFiles={selectedFiles}
                  onChange={setSelectedFiles}
                  refreshKey={fileTreeKey}
                />
                <hr />
                <FileExplorer
                  refreshKey={fileTreeKey}
                  onFileOpen={handleFileOpen}
                  onFileDelete={handleFileDelete}
                />
              </>
            )}
            {sidebarTab === 'tools' && (
              <div className="small">
                <h6 className="text-muted">Available MCP Tools</h6>
                {availableTools.map((t: any) => (
                  <div key={t.name} className="card mb-2">
                    <div className="card-body p-2">
                      <strong className="text-primary">{t.name}</strong>
                      <p className="mb-0 text-muted" style={{ fontSize: '0.8rem' }}>
                        {t.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {selectedFiles.length > 0 && (
            <div className="p-2 border-top bg-white">
              <small className="text-muted">
                <i className="bi bi-paperclip me-1"></i>
                {selectedFiles.length} file(s) attached to prompt
              </small>
            </div>
          )}
        </div>

        {/* ── Chat Area ───────────────────────────────────────── */}
        <div className="d-flex flex-column flex-grow-1" style={{ minWidth: 0 }}>
          <div className="flex-grow-1 overflow-auto p-3">
            {messages.length === 0 && (
              <div className="text-center text-muted mt-5">
                <i className="bi bi-chat-dots" style={{ fontSize: '3rem' }}></i>
                <p className="mt-2">
                  Start a new chat. Select files from the sidebar to bootstrap context.
                </p>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i}>
                <MessageBubble role={msg.role} content={msg.content} />
                {msg.planState && <PlanDisplay planState={msg.planState} />}
                {msg.toolCalls?.map((tc, j) => (
                  <ToolCallDisplay key={j} toolCall={tc} />
                ))}
              </div>
            ))}

            {loading && (
              <>
                <PlanDisplay planState={activePlan} />
                {!activePlan.currentPhase && (
                  <div className="d-flex align-items-center gap-2 text-muted ms-2 mb-2">
                    <div className="spinner-border spinner-border-sm" />
                    <span>Thinking…</span>
                  </div>
                )}
              </>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* ── Input Bar ─────────────────────────────────────── */}
          <div className="border-top p-3 bg-white" style={{ position: 'relative' }}>
            {/* ── Slash-command suggestion dropdown ──────────── */}
            {slashSuggestions.length > 0 && (
              <div
                style={{
                  position: 'absolute',
                  bottom: '100%',
                  left: 12,
                  right: 12,
                  maxHeight: 220,
                  overflowY: 'auto',
                  background: '#fff',
                  border: '1px solid #dee2e6',
                  borderRadius: '0.375rem',
                  boxShadow: '0 -4px 12px rgba(0,0,0,0.12)',
                  zIndex: 10,
                }}
              >
                {slashSuggestions.map((s, idx) => (
                  <div
                    key={s.value}
                    style={{
                      padding: '6px 12px',
                      cursor: 'pointer',
                      background: idx === slashSelectedIdx ? '#e9ecef' : 'transparent',
                    }}
                    onMouseEnter={() => setSlashSelectedIdx(idx)}
                    onMouseDown={(e) => {
                      e.preventDefault(); // keep textarea focus
                      setInput(s.value);
                      setSlashSuggestions([]);
                      inputRef.current?.focus();
                    }}
                  >
                    <strong style={{ color: '#0d6efd', fontSize: '0.9rem' }}>{s.label}</strong>
                    <div style={{ fontSize: '0.78rem', color: '#6c757d' }}>{s.description}</div>
                  </div>
                ))}
              </div>
            )}

            <div className="input-group">
              <textarea
                ref={inputRef}
                className="form-control"
                rows={2}
                placeholder="Type / for commands… /tools or /skills (Enter to send)"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={loading}
              />
              <button
                className="btn btn-primary"
                onClick={handleSend}
                disabled={loading || !input.trim()}
              >
                <i className="bi bi-send"></i>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Markdown Editor Modal ─────────────────────────────── */}
      {showEditor && editingFile && (
        <MarkdownEditor
          initialPath={editingFile.path}
          initialContent={editingFile.content}
          onSave={handleFileSave}
          onClose={() => {
            setShowEditor(false);
            setEditingFile(null);
          }}
        />
      )}
    </div>
  );
}
