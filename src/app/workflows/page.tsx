'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { WorkflowCanvasModal } from '@/components/WorkflowCanvas';

function WorkflowPageInner() {
  const params = useSearchParams();
  const mode = params.get('mode') as 'plan' | 'continuous' | null;

  return (
    <WorkflowCanvasModal
      open={true}
      onClose={() => window.close()}
      initialMode={mode || undefined}
    />
  );
}

export default function WorkflowsPage() {
  return (
    <Suspense fallback={<div className="d-flex align-items-center justify-content-center" style={{ height: '100vh' }}><div className="spinner-border" /></div>}>
      <WorkflowPageInner />
    </Suspense>
  );
}
