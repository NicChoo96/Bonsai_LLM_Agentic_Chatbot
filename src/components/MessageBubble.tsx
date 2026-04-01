'use client';

import ReactMarkdown from 'react-markdown';

interface Props {
  role: 'user' | 'assistant';
  content: string;
}

export function MessageBubble({ role, content }: Props) {
  const isUser = role === 'user';

  // Strip tool_call XML blocks from displayed content
  const displayContent = content
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .trim();

  if (!displayContent) return null;

  return (
    <div className={`d-flex mb-3 ${isUser ? 'justify-content-end' : 'justify-content-start'}`}>
      <div
        className={`card ${isUser ? 'bg-primary text-white' : 'bg-white border'}`}
        style={{ maxWidth: '75%' }}
      >
        <div className="card-body py-2 px-3">
          <div className="d-flex align-items-center mb-1">
            <i className={`bi ${isUser ? 'bi-person' : 'bi-robot'} me-2`}></i>
            <small className="fw-bold">{isUser ? 'You' : 'Assistant'}</small>
          </div>
          <div className={`message-content ${isUser ? '' : 'markdown-body'}`}>
            {isUser ? (
              <p className="mb-0" style={{ whiteSpace: 'pre-wrap' }}>{displayContent}</p>
            ) : (
              <ReactMarkdown>{displayContent}</ReactMarkdown>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
