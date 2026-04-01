import type { Metadata } from 'next';
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.min.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Sandbox Chat',
  description: 'Chat with AI, manage sandboxed files, and use MCP tools',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-bs-theme="light">
      <body>{children}</body>
    </html>
  );
}
