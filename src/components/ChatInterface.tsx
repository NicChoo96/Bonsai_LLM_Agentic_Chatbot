'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { MessageBubble } from './MessageBubble';
import { FileExplorer } from './FileExplorer';
import { FileSelector } from './FileSelector';
import { MarkdownEditor } from './MarkdownEditor';
import { ToolCallDisplay } from './ToolCallDisplay';
import { PlanDisplay, INITIAL_PLAN_STATE, type PlanState } from './PlanDisplay';
import { ChatSessionPanel, buildExchangeGroups, type Exchange, type ExchangeGroup } from './ChatSessionPanel';
import { SessionHistoryViewer } from './SessionHistoryViewer';
import { SubAgentDisplay, buildHandoff, MAX_SUB_AGENT_RETRIES, type SubAgentRun } from './SubAgentDisplay';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: any[];
  planState?: PlanState;
  subAgentRuns?: SubAgentRun[];
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
  const [showSessions, setShowSessions] = useState(false);
  const [mainTab, setMainTab] = useState<'chat' | 'history'>('chat');
  const [historyFile, setHistoryFile] = useState<{ path: string; data: any } | null>(null);
  const [subAgentRuns, setSubAgentRuns] = useState<SubAgentRun[]>([]);
  const [liveExchanges, setLiveExchanges] = useState<Exchange[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

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
    signal?: AbortSignal,
  ): Promise<any> => {
    const res = await fetch('/api/chat/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  };

  // ── Helper: push live exchanges from a phase result ────────────
  const pushLiveExchanges = (phase: string, reviewRounds?: { round: number; prompt: string; analysis: string; review_notes?: string }[], extra?: { role: Exchange['role']; label: string; content: string }[]) => {
    setLiveExchanges(prev => {
      const newExchanges: Exchange[] = [...prev];
      if (reviewRounds?.length) {
        for (const r of reviewRounds) {
          newExchanges.push({
            role: 'user',
            label: r.round === 1 ? `${phase} prompt` : `${phase} review R${r.round}`,
            content: r.prompt,
            phase,
            round: r.round,
          });
          newExchanges.push({
            role: 'assistant',
            label: r.round === 1 ? `${phase} response` : `${phase} review R${r.round} response`,
            content: r.analysis,
            phase,
            round: r.round,
          });
        }
      }
      if (extra) {
        for (const e of extra) {
          newExchanges.push({ ...e, phase });
        }
      }
      return newExchanges;
    });
  };

  // ── Abort handler ───────────────────────────────────────────────
  const handleAbort = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  // ── Sub-agent pipeline runner ────────────────────────────────────
  const runSubAgent = async (
    handoff: string,
    attempt: number,
    signal: AbortSignal,
    skillsData: { name: string; content: string }[],
  ): Promise<SubAgentRun> => {
    const run: SubAgentRun = {
      attempt,
      status: 'running',
      handoff,
      planState: { ...INITIAL_PLAN_STATE },
      reply: null,
      toolCalls: [],
      error: null,
    };

    // Payload for sub-agent — uses handoff as the prompt, NO prior messages
    const basePayload = {
      userPrompt: handoff,
      selectedFiles,
      skills: skillsData,
    };

    try {
      // Phase 1: Understand
      run.planState.currentPhase = 'understand';
      setSubAgentRuns(prev => {
        const updated = [...prev];
        updated[attempt - 1] = { ...run };
        return updated;
      });

      const p1 = await callPlanPhase('understand', { ...basePayload, phase: 'understand', messages: [] }, signal);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      run.planState.understanding = p1.understanding;
      run.planState.understandingRounds = p1.reviewRounds || [];
      run.planState.completedPhases = ['understand'];

      // Phase 2: Gather
      run.planState.currentPhase = 'gather';
      setSubAgentRuns(prev => {
        const updated = [...prev];
        updated[attempt - 1] = { ...run, planState: { ...run.planState } };
        return updated;
      });

      const p2 = await callPlanPhase('gather', { ...basePayload, phase: 'gather', messages: [], understanding: p1.understanding }, signal);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      run.planState.gathered = p2.gathered;
      run.planState.gatheredRounds = p2.reviewRounds || [];
      run.planState.completedPhases = ['understand', 'gather'];

      const needsTools = (p2.gathered?.selected_tools?.length > 0);

      if (needsTools) {
        // Phase 3: Plan
        run.planState.currentPhase = 'plan';
        setSubAgentRuns(prev => {
          const updated = [...prev];
          updated[attempt - 1] = { ...run, planState: { ...run.planState } };
          return updated;
        });

        const p3 = await callPlanPhase('plan', { ...basePayload, phase: 'plan', messages: [] }, signal);
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        run.planState.plan = p3.plan;
        run.planState.planRounds = p3.reviewRounds || [];
        run.planState.review = p3.review || null;
        run.planState.completedPhases = ['understand', 'gather', 'plan'];

        const finalPlan = p3.review?.corrected_plan || p3.plan;
        if (p3.review?.corrected_plan) run.planState.plan = p3.review.corrected_plan;

        // Phase 4: Execute
        run.planState.currentPhase = 'execute';
        run.planState.executingStep = 0;
        setSubAgentRuns(prev => {
          const updated = [...prev];
          updated[attempt - 1] = { ...run, planState: { ...run.planState } };
          return updated;
        });

        // Sub-agent only gets the handoff as context — no main chat history
        const execMessages = [{ role: 'user', content: handoff }];
        const p4 = await callPlanPhase('execute', {
          ...basePayload,
          phase: 'execute',
          messages: execMessages,
          plan: finalPlan,
        }, signal);

        run.planState.executingStep = (finalPlan?.steps?.length || 1);
        run.planState.completedPhases = ['understand', 'gather', 'plan', 'execute'];
        run.planState.currentPhase = null;
        run.reply = p4.reply;
        run.toolCalls = p4.toolCalls || [];
      } else {
        // No tools — direct response
        run.planState.completedPhases = ['understand', 'gather', 'plan', 'execute'];
        run.planState.currentPhase = 'execute';
        setSubAgentRuns(prev => {
          const updated = [...prev];
          updated[attempt - 1] = { ...run, planState: { ...run.planState } };
          return updated;
        });

        const execMessages = [{ role: 'user', content: handoff }];
        const p4 = await callPlanPhase('execute', {
          ...basePayload,
          phase: 'execute',
          messages: execMessages,
          plan: null,
          skipTools: true,
        }, signal);

        run.planState.completedPhases = ['understand', 'gather', 'plan', 'execute'];
        run.planState.currentPhase = null;
        run.reply = p4.reply;
        run.toolCalls = p4.toolCalls || [];
      }

      // Check if sub-agent also had errors
      const hasErrors = run.toolCalls.some((tc: any) => tc.status === 'error');
      const allFailed = run.toolCalls.length > 0 && run.toolCalls.every((tc: any) => tc.status === 'error');
      run.status = allFailed ? 'error' : 'success';
      if (allFailed) {
        run.error = 'All tool calls failed in sub-agent execution';
      }
    } catch (err: any) {
      if (err?.name === 'AbortError' || signal.aborted) {
        run.status = 'error';
        run.error = 'Aborted';
      } else {
        run.status = 'error';
        run.error = err.message || 'Sub-agent execution failed';
      }
    }

    // Final update
    setSubAgentRuns(prev => {
      const updated = [...prev];
      updated[attempt - 1] = { ...run, planState: { ...run.planState } };
      return updated;
    });

    return run;
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
    setSubAgentRuns([]);
    setLiveExchanges([{ role: 'user' as const, label: 'User prompt', content: trimmed, phase: 'input' }]);

    // Create abort controller for this pipeline run
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const signal = abortController.signal;

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

      const p1 = await callPlanPhase('understand', { ...basePayload, phase: 'understand', messages: [] }, signal);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      planState.understanding = p1.understanding;
      planState.understandingRounds = p1.reviewRounds || [];
      planState.completedPhases = ['understand'];
      pushLiveExchanges('understand', p1.reviewRounds);

      // ═══════════ PHASE 2: GATHER TOOLS & SKILLS ════════════
      planState.currentPhase = 'gather';
      setActivePlan({ ...planState });

      const p2 = await callPlanPhase('gather', { ...basePayload, phase: 'gather', messages: [], understanding: p1.understanding }, signal);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      planState.gathered = p2.gathered;
      planState.gatheredRounds = p2.reviewRounds || [];
      planState.completedPhases = ['understand', 'gather'];
      pushLiveExchanges('gather', p2.reviewRounds);

      // ── Check if tools are actually needed ─────────────────
      const needsTools = (p2.gathered?.selected_tools?.length > 0);

      if (needsTools) {
      // ═══════════ PHASE 3: PLAN + REVIEW (combined) ════════════
      planState.currentPhase = 'plan';
      setActivePlan({ ...planState });

      const p3 = await callPlanPhase('plan', { ...basePayload, phase: 'plan', messages: [] }, signal);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      planState.plan = p3.plan;
      planState.planRounds = p3.reviewRounds || [];
      planState.review = p3.review || null;
      planState.completedPhases = ['understand', 'gather', 'plan'];
      pushLiveExchanges('plan', p3.reviewRounds);

      // If the review corrected the plan, use the corrected version
      const finalPlanForExecution = p3.review?.corrected_plan || p3.plan;
      if (p3.review?.corrected_plan) {
        planState.plan = p3.review.corrected_plan;
      }

      // ═══════════ PHASE 4: EXECUTE ══════════════════════════
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
      }, signal);

      // Push execute exchanges live
      const execExtra: { role: Exchange['role']; label: string; content: string }[] = [];
      for (const tc of (p5.toolCalls || [])) {
        execExtra.push({ role: 'assistant' as const, label: `Tool call: ${tc.name}`, content: JSON.stringify({ tool: tc.name, arguments: tc.arguments }, null, 2) });
        if (tc.result) execExtra.push({ role: 'tool-result' as const, label: `${tc.name} → ${tc.status}`, content: tc.result });
      }
      if (p5.reply) execExtra.push({ role: 'assistant' as const, label: 'Final response', content: p5.reply });
      pushLiveExchanges('execute', undefined, execExtra);

      // Mark all steps done
      planState.executingStep = (finalPlanForExecution?.steps?.length || 1);
      planState.completedPhases = ['understand', 'gather', 'plan', 'execute'];
      planState.currentPhase = null;

      // ── Check for execution errors → spawn sub-agents ──────
      const failedCalls = (p5.toolCalls || []).filter((tc: any) => tc.status === 'error');
      const allFailed = p5.toolCalls?.length > 0 && failedCalls.length === p5.toolCalls.length;
      const successCalls = (p5.toolCalls || []).filter((tc: any) => tc.status === 'success');

      let collectedSubAgentRuns: SubAgentRun[] = [];

      if (allFailed && !signal.aborted) {
        // Reset sub-agent runs for this prompt
        setSubAgentRuns([]);
        collectedSubAgentRuns = [];

        // Build handoff from failed execution
        const failedSteps = failedCalls.map((tc: any) => ({
          action: tc.name,
          tool: tc.name,
          error: (tc.result || 'Unknown error').slice(0, 200),
        }));
        const partialResults = successCalls.map((tc: any) =>
          `${tc.name}: ${(tc.result || '').slice(0, 100)}`
        );

        let lastHandoff = buildHandoff(
          trimmed,
          finalPlanForExecution?.summary || planState.plan?.summary || null,
          failedSteps,
          partialResults,
        );

        for (let attempt = 1; attempt <= MAX_SUB_AGENT_RETRIES; attempt++) {
          if (signal.aborted) break;

          // Pre-allocate run slot
          const placeholder: SubAgentRun = {
            attempt,
            status: 'running',
            handoff: lastHandoff,
            planState: { ...INITIAL_PLAN_STATE },
            reply: null,
            toolCalls: [],
            error: null,
          };
          collectedSubAgentRuns.push(placeholder);
          setSubAgentRuns([...collectedSubAgentRuns]);

          const result = await runSubAgent(lastHandoff, attempt, signal, skillsData);
          collectedSubAgentRuns[attempt - 1] = result;
          setSubAgentRuns([...collectedSubAgentRuns]);

          // If sub-agent succeeded, we're done
          if (result.status === 'success') break;

          // If sub-agent also failed and we have retries left, build new handoff
          if (attempt < MAX_SUB_AGENT_RETRIES && result.status === 'error') {
            const subFailedCalls = result.toolCalls.filter((tc: any) => tc.status === 'error');
            const subSuccessCalls = result.toolCalls.filter((tc: any) => tc.status === 'success');
            lastHandoff = buildHandoff(
              trimmed,
              result.planState.plan?.summary || null,
              subFailedCalls.map((tc: any) => ({
                action: tc.name,
                tool: tc.name,
                error: (tc.result || 'Unknown error').slice(0, 200),
              })),
              [
                ...partialResults,
                ...subSuccessCalls.map((tc: any) => `${tc.name}: ${(tc.result || '').slice(0, 100)}`),
              ],
            );
          }
        }
      }

      const finalPlan = { ...planState };
      setActivePlan(finalPlan);

      // Use the last successful sub-agent reply if available
      const lastSuccessfulRun = collectedSubAgentRuns.find(r => r.status === 'success');
      const finalReply = lastSuccessfulRun?.reply || p5.reply;
      const finalToolCalls = lastSuccessfulRun?.toolCalls?.length ? lastSuccessfulRun.toolCalls : p5.toolCalls;

      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: finalReply,
          toolCalls: finalToolCalls,
          planState: finalPlan,
          subAgentRuns: collectedSubAgentRuns.length > 0 ? collectedSubAgentRuns : undefined,
        },
      ]);

      if (finalToolCalls?.length) refreshFiles();

      } else {
        // ═══════════ NO TOOLS NEEDED — DIRECT RESPONSE ═══════
        planState.completedPhases = ['understand', 'gather', 'plan', 'execute'];
        planState.currentPhase = 'execute';
        setActivePlan({ ...planState });

        const execMessages = [...messages, { role: 'user', content: trimmed }].map((m) => ({
          role: m.role,
          content: m.content,
        }));

        const p5 = await callPlanPhase('execute', {
          ...basePayload,
          phase: 'execute',
          messages: execMessages,
          plan: null,
          skipTools: true,
        }, signal);

        // Push direct response exchange live
        if (p5.reply) {
          pushLiveExchanges('execute', undefined, [{ role: 'assistant' as const, label: 'Direct response', content: p5.reply }]);
        }

        planState.completedPhases = ['understand', 'gather', 'plan', 'execute'];
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
      }
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError' || signal.aborted;
      if (isAbort) {
        planState.aborted = true;
        planState.currentPhase = null;
        setActivePlan({ ...planState });
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: 'Pipeline aborted.', planState: { ...planState } },
        ]);
      } else {
        planState.error = err.message || 'Plan execution failed';
        planState.currentPhase = null;
        setActivePlan({ ...planState });
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `Error during planning: ${planState.error}` },
        ]);
      }
    } finally {
      abortControllerRef.current = null;
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
    setSubAgentRuns([]);
  };

  const handleNewFile = () => {
    setEditingFile({ path: '', content: '' });
    setShowEditor(true);
  };

  const handleSaveSession = async () => {
    const groups = buildExchangeGroups(messages);
    const session = {
      version: 1,
      savedAt: new Date().toISOString(),
      promptCount: messages.filter((m) => m.role === 'user').length,
      messageCount: messages.length,
      messages,
      exchangeGroups: groups,
    };
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `session-${ts}.session.json`;
    try {
      await fetch('/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fileName, content: JSON.stringify(session, null, 2) }),
      });
      refreshFiles();
    } catch {}
  };

  const handleFileOpen = async (path: string) => {
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(path)}`);
      const data = await res.json();
      if (data.content !== undefined) {
        // Detect session history files
        if (path.endsWith('.session.json')) {
          try {
            const parsed = JSON.parse(data.content);
            setHistoryFile({ path, data: parsed });
            setMainTab('history');
            return;
          } catch {}
        }
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
          <button
            className={`btn btn-sm ${showSessions ? 'btn-info' : 'btn-outline-info'}`}
            onClick={() => setShowSessions((v) => !v)}
            title="View AI chat sessions"
          >
            <i className="bi bi-chat-square-text me-1"></i>Sessions
          </button>
          <button
            className="btn btn-outline-success btn-sm"
            onClick={handleSaveSession}
            disabled={messages.length === 0}
            title="Save session history to JSON file"
          >
            <i className="bi bi-save me-1"></i>Save Session
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
          {/* ── Main content tab bar ──────────────────────────── */}
          <div className="d-flex border-bottom flex-shrink-0" style={{ background: '#f8f9fa' }}>
            <button
              className="btn btn-sm rounded-0 border-0 py-2 px-3"
              style={{
                fontSize: '0.84rem',
                color: mainTab === 'chat' ? '#0d6efd' : '#6c757d',
                borderBottom: mainTab === 'chat' ? '2px solid #0d6efd' : '2px solid transparent',
                background: mainTab === 'chat' ? '#fff' : 'transparent',
                transition: 'all 0.15s ease',
              }}
              onClick={() => setMainTab('chat')}
            >
              <i className="bi bi-chat-dots me-1"></i>Chat
            </button>
            {historyFile && (
              <button
                className="btn btn-sm rounded-0 border-0 py-2 px-3 d-flex align-items-center gap-1"
                style={{
                  fontSize: '0.84rem',
                  color: mainTab === 'history' ? '#0d6efd' : '#6c757d',
                  borderBottom: mainTab === 'history' ? '2px solid #0d6efd' : '2px solid transparent',
                  background: mainTab === 'history' ? '#fff' : 'transparent',
                  transition: 'all 0.15s ease',
                }}
                onClick={() => setMainTab('history')}
              >
                <i className="bi bi-clock-history me-1"></i>
                <span className="text-truncate" style={{ maxWidth: 180 }}>
                  {historyFile.path.split('/').pop()}
                </span>
                <i
                  className="bi bi-x ms-1"
                  style={{ fontSize: '0.72rem' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setHistoryFile(null);
                    setMainTab('chat');
                  }}
                ></i>
              </button>
            )}
          </div>

          {/* ── Chat tab content ──────────────────────────────── */}
          {mainTab === 'chat' && (
            <>
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
                {msg.subAgentRuns && msg.subAgentRuns.length > 0 && (
                  <SubAgentDisplay runs={msg.subAgentRuns} />
                )}
              </div>
            ))}

            {loading && (
              <>
                <PlanDisplay planState={activePlan} onAbort={handleAbort} />
                {subAgentRuns.length > 0 && (
                  <SubAgentDisplay runs={subAgentRuns} onAbort={handleAbort} />
                )}
                {!activePlan.currentPhase && subAgentRuns.length === 0 && (
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
            </>
          )}

          {/* ── History tab content ───────────────────────────── */}
          {mainTab === 'history' && historyFile && (
            <SessionHistoryViewer
              filePath={historyFile.path}
              data={historyFile.data}
              onClose={() => {
                setHistoryFile(null);
                setMainTab('chat');
              }}
            />
          )}
        </div>
      </div>

      {/* ── Chat Session Panel (slide-in from right) ───────────── */}
      <ChatSessionPanel
        groups={[
          ...buildExchangeGroups(messages),
          ...(loading && liveExchanges.length > 0
            ? [{
                userPrompt: liveExchanges.find(e => e.phase === 'input')?.content || '…',
                timestamp: Date.now(),
                exchanges: liveExchanges,
              } as ExchangeGroup]
            : []),
        ]}
        open={showSessions}
        onClose={() => setShowSessions(false)}
      />

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
