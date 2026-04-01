'use client';

import { useState, useEffect } from 'react';

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

interface Props {
  refreshKey: number;
  onFileOpen: (path: string) => void;
  onFileDelete: (path: string) => void;
}

export function FileExplorer({ refreshKey, onFileOpen, onFileDelete }: Props) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch('/api/files')
      .then((r) => r.json())
      .then((data) => setTree(data.files || []))
      .catch(() => setTree([]))
      .finally(() => setLoading(false));
  }, [refreshKey]);

  if (loading) {
    return (
      <div className="text-muted small">
        <div className="spinner-border spinner-border-sm me-2" />
        Loading files…
      </div>
    );
  }

  if (tree.length === 0) {
    return <p className="text-muted small">Sandbox is empty. Create a file to get started.</p>;
  }

  return (
    <div>
      <h6 className="text-muted mb-2">
        <i className="bi bi-folder2-open me-1"></i>Sandbox Files
      </h6>
      <TreeView nodes={tree} onFileOpen={onFileOpen} onFileDelete={onFileDelete} />
    </div>
  );
}

function TreeView({
  nodes,
  depth = 0,
  onFileOpen,
  onFileDelete,
}: {
  nodes: FileNode[];
  depth?: number;
  onFileOpen: (path: string) => void;
  onFileDelete: (path: string) => void;
}) {
  return (
    <ul className="list-unstyled" style={{ paddingLeft: depth ? 16 : 0 }}>
      {nodes.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={depth}
          onFileOpen={onFileOpen}
          onFileDelete={onFileDelete}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  node,
  depth,
  onFileOpen,
  onFileDelete,
}: {
  node: FileNode;
  depth: number;
  onFileOpen: (path: string) => void;
  onFileDelete: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <li className="mb-1">
      <div className="d-flex align-items-center gap-1 py-1 px-1 rounded hover-bg">
        {node.isDirectory ? (
          <>
            <button
              className="btn btn-sm p-0 border-0"
              onClick={() => setExpanded(!expanded)}
            >
              <i className={`bi bi-chevron-${expanded ? 'down' : 'right'} text-muted`}></i>
            </button>
            <i className="bi bi-folder-fill text-warning"></i>
            <span className="small flex-grow-1">{node.name}</span>
          </>
        ) : (
          <>
            <span style={{ width: 16 }}></span>
            <i className={`bi ${node.name.endsWith('.md') ? 'bi-filetype-md' : 'bi-file-text'} text-secondary`}></i>
            <span
              className="small flex-grow-1 text-truncate"
              role="button"
              onClick={() => onFileOpen(node.path)}
              title={node.path}
            >
              {node.name}
            </span>
            <button
              className="btn btn-sm p-0 border-0 text-danger opacity-50"
              onClick={() => onFileDelete(node.path)}
              title="Delete"
            >
              <i className="bi bi-trash3" style={{ fontSize: '0.75rem' }}></i>
            </button>
          </>
        )}
      </div>
      {node.isDirectory && expanded && node.children && (
        <TreeView
          nodes={node.children}
          depth={depth + 1}
          onFileOpen={onFileOpen}
          onFileDelete={onFileDelete}
        />
      )}
    </li>
  );
}
