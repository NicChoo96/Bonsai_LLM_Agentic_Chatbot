'use client';

import { useState } from 'react';

interface Props {
  toolCall: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    result?: string;
    status: 'pending' | 'running' | 'success' | 'error';
  };
}

export function ToolCallDisplay({ toolCall }: Props) {
  const [expanded, setExpanded] = useState(false);

  const statusBadge = {
    pending: 'bg-secondary',
    running: 'bg-info',
    success: 'bg-success',
    error: 'bg-danger',
  }[toolCall.status];

  return (
    <div className="card mb-2 ms-4 border-start border-3 border-info" style={{ maxWidth: '70%' }}>
      <div
        className="card-header py-1 px-3 d-flex align-items-center gap-2"
        role="button"
        onClick={() => setExpanded(!expanded)}
      >
        <i className={`bi bi-chevron-${expanded ? 'down' : 'right'} text-muted`}></i>
        <i className="bi bi-gear text-info"></i>
        <code className="small">{toolCall.name}</code>
        <span className={`badge ${statusBadge} ms-auto`}>{toolCall.status}</span>
      </div>

      {expanded && (
        <div className="card-body py-2 px-3">
          <div className="mb-2">
            <small className="text-muted fw-bold">Arguments:</small>
            <pre className="bg-light p-2 rounded small mb-0" style={{ maxHeight: 120, overflow: 'auto' }}>
              {JSON.stringify(toolCall.arguments, null, 2)}
            </pre>
          </div>
          {toolCall.result && (
            <div>
              <small className="text-muted fw-bold">Result:</small>
              <pre
                className={`p-2 rounded small mb-0 ${toolCall.status === 'error' ? 'bg-danger bg-opacity-10' : 'bg-light'}`}
                style={{ maxHeight: 200, overflow: 'auto' }}
              >
                {toolCall.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
