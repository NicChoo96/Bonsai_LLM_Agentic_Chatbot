'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { MessageBubble } from './MessageBubble';
import { FileExplorer } from './FileExplorer';
import { FileSelector } from './FileSelector';
import { MarkdownEditor } from './MarkdownEditor';
import { ToolCallDisplay } from './ToolCallDisplay';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: any[];
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
  const [fileTreeKey, setFileTreeKey] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const refreshFiles = useCallback(() => setFileTreeKey((k) => k + 1), []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Load available MCP tools on mount
  useEffect(() => {
    fetch('/api/mcp/execute')
      .then((r) => r.json())
      .then((data) => setAvailableTools(data.tools || []))
      .catch(() => {});
  }, []);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const userMsg: Message = { role: 'user', content: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
          })),
          selectedFiles,
        }),
      });

      const data = await res.json();

      if (data.error) {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `Error: ${data.error}` },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: data.reply,
            toolCalls: data.toolCalls,
          },
        ]);
        // Refresh file tree in case tools created files
        if (data.toolCalls?.length) refreshFiles();
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'Failed to reach the AI server.' },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
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
                {msg.toolCalls?.map((tc, j) => (
                  <ToolCallDisplay key={j} toolCall={tc} />
                ))}
              </div>
            ))}

            {loading && (
              <div className="d-flex align-items-center gap-2 text-muted ms-2 mb-2">
                <div className="spinner-border spinner-border-sm" />
                <span>Thinking…</span>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* ── Input Bar ─────────────────────────────────────── */}
          <div className="border-top p-3 bg-white">
            <div className="input-group">
              <textarea
                className="form-control"
                rows={2}
                placeholder="Type your message… (Enter to send, Shift+Enter for newline)"
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
