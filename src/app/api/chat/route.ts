import { NextRequest, NextResponse } from 'next/server';
import {
  registerProvider,
  filesystemProvider,
  chromeDevToolsProvider,
  webFetchProvider,
} from '@/lib/mcp';
import { buildToolSystemPrompt } from '@/lib/tool-processor';
import { runChatWithTools } from '@/lib/tool-processor';
import { readSandboxFile, ensureSandbox } from '@/lib/sandbox';
import type { CompletionMessage } from '@/lib/ai-client';

// Register all MCP providers on first import
registerProvider(filesystemProvider);
registerProvider(chromeDevToolsProvider);
registerProvider(webFetchProvider);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { messages: userMessages, selectedFiles } = body as {
      messages: { role: string; content: string }[];
      selectedFiles: string[];
    };

    await ensureSandbox();

    // ── Bootstrap: concatenate selected file contents ─────────
    let bootstrapContext = '';
    if (selectedFiles?.length) {
      const fileContents: string[] = [];
      for (const filePath of selectedFiles) {
        try {
          const content = await readSandboxFile(filePath);
          fileContents.push(`--- File: ${filePath} ---\n${content}`);
        } catch {
          fileContents.push(`--- File: ${filePath} --- (could not read)`);
        }
      }
      bootstrapContext = fileContents.join('\n\n');
    }

    // ── Build the system prompt ──────────────────────────────
    const toolPrompt = buildToolSystemPrompt();
    const systemContent = [
      'You are a helpful AI assistant with access to a sandboxed workspace and developer tools.',
      '',
      toolPrompt,
      '',
      bootstrapContext
        ? `The user has selected the following files as context:\n\n${bootstrapContext}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    // ── Assemble messages for the AI model ───────────────────
    const completionMessages: CompletionMessage[] = [
      { role: 'system', content: systemContent },
      ...userMessages.map((m) => ({ role: m.role, content: m.content })),
    ];

    // ── Run the chat loop (may iterate if AI uses tools) ─────
    const { reply, toolCalls } = await runChatWithTools(completionMessages);

    return NextResponse.json({ reply, toolCalls });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
