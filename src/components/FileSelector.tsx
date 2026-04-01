'use client';

import { useState, useEffect } from 'react';

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

interface Props {
  selectedFiles: string[];
  onChange: (files: string[]) => void;
  refreshKey: number;
}

/** Flatten a file tree into a list of file paths (no directories) */
function flattenFiles(nodes: FileNode[]): { name: string; path: string }[] {
  const result: { name: string; path: string }[] = [];
  for (const node of nodes) {
    if (node.isDirectory && node.children) {
      result.push(...flattenFiles(node.children));
    } else if (!node.isDirectory) {
      result.push({ name: node.name, path: node.path });
    }
  }
  return result;
}

export function FileSelector({ selectedFiles, onChange, refreshKey }: Props) {
  const [files, setFiles] = useState<{ name: string; path: string }[]>([]);

  useEffect(() => {
    fetch('/api/files')
      .then((r) => r.json())
      .then((data) => setFiles(flattenFiles(data.files || [])))
      .catch(() => setFiles([]));
  }, [refreshKey]);

  const toggle = (path: string) => {
    if (selectedFiles.includes(path)) {
      onChange(selectedFiles.filter((f) => f !== path));
    } else {
      onChange([...selectedFiles, path]);
    }
  };

  const selectAll = () => onChange(files.map((f) => f.path));
  const selectNone = () => onChange([]);

  if (files.length === 0) {
    return (
      <div>
        <h6 className="text-muted mb-2">
          <i className="bi bi-paperclip me-1"></i>Bootstrap Files
        </h6>
        <p className="text-muted small">No files in sandbox yet.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="d-flex align-items-center justify-content-between mb-2">
        <h6 className="text-muted mb-0">
          <i className="bi bi-paperclip me-1"></i>Bootstrap Files
        </h6>
        <div className="btn-group btn-group-sm">
          <button className="btn btn-outline-secondary btn-sm" onClick={selectAll}>
            All
          </button>
          <button className="btn btn-outline-secondary btn-sm" onClick={selectNone}>
            None
          </button>
        </div>
      </div>

      <div className="list-group list-group-flush">
        {files.map((file) => (
          <label
            key={file.path}
            className="list-group-item list-group-item-action d-flex align-items-center gap-2 py-1 px-2"
            style={{ cursor: 'pointer', fontSize: '0.85rem' }}
          >
            <input
              type="checkbox"
              className="form-check-input mt-0"
              checked={selectedFiles.includes(file.path)}
              onChange={() => toggle(file.path)}
            />
            <i className={`bi ${file.name.endsWith('.md') ? 'bi-filetype-md' : 'bi-file-text'} text-secondary`}></i>
            <span className="text-truncate" title={file.path}>
              {file.path}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
