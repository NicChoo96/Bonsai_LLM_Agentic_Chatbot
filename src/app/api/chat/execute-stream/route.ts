import { NextRequest } from 'next/server';
import {
  registerProvider,
  filesystemProvider,
  chromeDevToolsProvider,
  webFetchProvider,
  systemProvider,
  documentProvider,
  getAllTools,
} from '@/lib/mcp';
import { buildToolSystemPrompt, runChatWithTools } from '@/lib/tool-processor';
import { readSandboxFile, ensureSandbox, listSandboxFiles } from '@/lib/sandbox';
import { sendChatCompletion, type CompletionMessage } from '@/lib/ai-client';
import type { ToolCall } from '@/types';

// Register all MCP providers
registerProvider(filesystemProvider);
registerProvider(chromeDevToolsProvider);
registerProvider(webFetchProvider);
registerProvider(systemProvider);
registerProvider(documentProvider);

// ─── Streaming execute endpoint ──────────────────────────────────
// Sends each tool call result as an SSE event so the client can
// render terminal steps live, instead of waiting for the whole batch.

export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    userPrompt,
    messages: userMessages,
    selectedFiles,
    skills,
    plan,
    skipTools,
  } = body as {
    userPrompt: string;
    messages: { role: string; content: string }[];
    selectedFiles: string[];
    skills: { name: string; content: string }[];
    plan: any;
    skipTools?: boolean;
  };

  await ensureSandbox();

  // ── Shared context ───────────────────────────────────────
  const sandboxFiles = await listSandboxFiles('');
  const fileList = sandboxFiles.map((f) => (f.isDirectory ? `${f.path}/` : f.path)).join(', ');

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

  // ── Set up SSE stream ──────────────────────────────────────
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function sendEvent(event: string, data: any) {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      }

      try {
        // ── Direct response mode (no tools needed) ───────────
        if (skipTools || !plan?.steps?.length) {
          const skillContext = (skills || []).length > 0
            ? `\n\nYou may reference these skills if relevant:\n${skills.map((s) => `[Skill: ${s.name}]\n${s.content.slice(0, 200)}`).join('\n---\n')}`
            : '';

          const systemContent = [
            'You are a helpful AI assistant. Respond directly and thoroughly to the user\'s request.',
            'No tools are needed for this task — provide a comprehensive text response.',
            '',
            `Sandbox files available: [${fileList}]`,
            skillContext,
            bootstrapContext
              ? `\nThe user has selected the following files as context:\n\n${bootstrapContext}`
              : '',
          ].filter(Boolean).join('\n');

          const completionMessages: CompletionMessage[] = [
            { role: 'system', content: systemContent },
            ...(userMessages || []).map((m) => ({ role: m.role, content: m.content })),
          ];

          const response = await sendChatCompletion(completionMessages);
          const reply = response.choices[0]?.message?.content ?? '';

          sendEvent('done', { reply, toolCalls: [] });
          controller.close();
          return;
        }

        // ── Tool-based execution ─────────────────────────────
        const planToolNames = new Set<string>();
        const planSkillNames = new Set<string>();
        const allToolNameSet = new Set(getAllTools().map(t => t.name));
        if (plan?.steps?.length) {
          for (const s of plan.steps as any[]) {
            if (s.tool && s.tool !== 'none') {
              if (allToolNameSet.has(s.tool)) {
                planToolNames.add(s.tool);
              }
            }
            if (s.skill) {
              planSkillNames.add(s.skill);
            }
          }
        }
        ['sandbox_list_files', 'sandbox_read_file', 'search_files'].forEach((t) => planToolNames.add(t));
        const toolPrompt = buildToolSystemPrompt(planToolNames);

        // Build skill context
        const planSkills = (skills || []).filter(s => planSkillNames.has(s.name));
        const otherSkills = (skills || []).filter(s => !planSkillNames.has(s.name));
        let skillContext = '';
        if (planSkills.length > 0) {
          skillContext += `\n\n═══ ACTIVE SKILLS (follow these instructions) ═══\n${planSkills.map((s) => `[Skill: ${s.name}]\n${s.content}`).join('\n---\n')}\n═══════════════════════════════════════════════════`;
        }
        if (otherSkills.length > 0) {
          skillContext += `\n\nOther available skills:\n${otherSkills.map((s) => `[Skill: ${s.name}]\n${s.content}`).join('\n---\n')}`;
        }

        const planContext = plan?.steps?.length
          ? `\n\nYou MUST follow this execution plan step by step:\n${plan.steps.map((s: any) => {
              let desc = `${s.step}. ${s.action}`;
              if (s.tool && s.tool !== 'none') desc += ` [use tool: ${s.tool}]`;
              if (s.skill) desc += ` [follow skill: ${s.skill}]`;
              return desc;
            }).join('\n')}`
          : '';

        const systemContent = [
          'You are a helpful AI assistant with access to a sandboxed workspace and developer tools.',
          'Use tool calls when you need to perform concrete actions (read/write files, fetch web pages, run commands, etc.).',
          'If the task can be answered directly without any tool usage, just respond normally — a plain text answer is perfectly fine.',
          'Do NOT force tool usage when it is not needed. Only call tools when they genuinely help accomplish the task.',
          '',
          `The sandbox workspace currently contains these files: [${fileList}]`,
          '',
          toolPrompt,
          planContext,
          skillContext,
          '',
          bootstrapContext
            ? `The user has selected the following files as context:\n\n${bootstrapContext}`
            : '',
        ].filter(Boolean).join('\n');

        const completionMessages: CompletionMessage[] = [
          { role: 'system', content: systemContent },
          ...(userMessages || []).map((m) => ({ role: m.role, content: m.content })),
        ];

        let stepIndex = 0;

        const { reply, toolCalls } = await runChatWithTools(
          completionMessages,
          // Stream each tool call as it completes
          (tc: ToolCall) => {
            sendEvent('tool_call', {
              stepIndex: stepIndex++,
              toolCall: tc,
            });
          },
        );

        sendEvent('done', { reply, toolCalls });
        controller.close();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        sendEvent('error', { error: message });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
