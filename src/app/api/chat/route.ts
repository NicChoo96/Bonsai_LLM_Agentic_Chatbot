import { NextRequest, NextResponse } from 'next/server';
import {
  registerProvider,
  filesystemProvider,
  chromeDevToolsProvider,
  webFetchProvider,
} from '@/lib/mcp';
import { buildToolSystemPrompt } from '@/lib/tool-processor';
import { runChatWithTools } from '@/lib/tool-processor';
import { readSandboxFile, ensureSandbox, listSandboxFiles } from '@/lib/sandbox';
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

    // ── List sandbox files so the model knows what exists ─────
    const sandboxFiles = await listSandboxFiles('');
    const fileList = sandboxFiles.map((f) => (f.isDirectory ? `${f.path}/` : f.path)).join(', ');

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
      'You MUST use tool calls whenever the user asks you to perform an action. Never refuse or skip a tool call.',
      '',
      `The sandbox workspace currently contains these files: [${fileList}]`,
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
