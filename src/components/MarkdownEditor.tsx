'use client';

import { useState } from 'react';

interface Props {
  initialPath: string;
  initialContent: string;
  onSave: (path: string, content: string) => void;
  onClose: () => void;
}

export function MarkdownEditor({ initialPath, initialContent, onSave, onClose }: Props) {
  const [path, setPath] = useState(initialPath);
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const trimmedPath = path.trim();
    if (!trimmedPath) return;

    // Auto-append .md if no extension
    const finalPath = trimmedPath.includes('.') ? trimmedPath : `${trimmedPath}.md`;

    setSaving(true);
    await onSave(finalPath, content);
    setSaving(false);
  };

  return (
    <div
      className="modal d-block"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-dialog modal-lg modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title">
              <i className="bi bi-filetype-md me-2"></i>
              {initialPath ? `Edit: ${initialPath}` : 'New Markdown File'}
            </h5>
            <button className="btn-close" onClick={onClose}></button>
          </div>
          <div className="modal-body">
            <div className="mb-3">
              <label className="form-label fw-bold">File Path (relative to sandbox)</label>
              <input
                type="text"
                className="form-control font-monospace"
                placeholder="e.g. notes/my-prompt.md"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                disabled={!!initialPath}
              />
            </div>
            <div>
              <label className="form-label fw-bold">Content</label>
              <textarea
                className="form-control font-monospace"
                rows={15}
                placeholder="Write your markdown content here…"
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving || !path.trim()}
            >
              {saving ? (
                <>
                  <span className="spinner-border spinner-border-sm me-1"></span>
                  Saving…
                </>
              ) : (
                <>
                  <i className="bi bi-save me-1"></i>Save
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
