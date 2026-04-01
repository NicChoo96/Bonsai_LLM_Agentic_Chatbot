# AI Sandbox Chat

A lightweight, self-hosted AI chat agent with a sandboxed file workspace and MCP (Model Context Protocol) tool-calling capabilities. Powered by a local **Bonsai-8B** GGUF model running on llama.cpp (Prism fork), served over an OpenAI-compatible API.

---

## Architecture Overview

```
┌───────────────────────────────────────────────────────────────────┐
│                        User's Browser                            │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ Chat UI      │  │ File Sidebar │  │ MCP Tools Sidebar        │ │
│  │ (Bootstrap)  │  │ (Explorer +  │  │ (Lists all registered    │ │
│  │              │  │  Selector)   │  │  tool definitions)       │ │
│  └──────┬───────┘  └──────┬───────┘  └──────────────────────────┘ │
│         │                 │                                       │
│         ▼                 ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │              Next.js Frontend (React 18 + Vite)             │  │
│  │              http://localhost:3000                           │  │
│  └─────────────────────────┬───────────────────────────────────┘  │
└─────────────────────────────┼─────────────────────────────────────┘
                              │ HTTP (API Routes)
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Next.js API Layer (Server-Side)                  │
│                                                                     │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────────────────┐ │
│  │ /api/chat    │  │ /api/files    │  │ /api/mcp/execute         │ │
│  │              │  │ /api/files/*  │  │                          │ │
│  │ Orchestrates │  │ CRUD sandbox  │  │ Direct tool invocation   │ │
│  │ chat + tools │  │ files         │  │                          │ │
│  └──────┬───────┘  └───────┬───────┘  └────────────┬─────────────┘ │
│         │                  │                        │               │
│         ▼                  ▼                        ▼               │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Tool Processor                            │   │
│  │  • Injects tool definitions into system prompt               │   │
│  │  • Parses <tool_call> blocks from AI responses               │   │
│  │  • Executes tools via MCP Registry                           │   │
│  │  • Loops up to 8 iterations (tool result → AI → tool → ...)  │   │
│  └──────┬──────────────────────────────────────────────────────┘   │
│         │                                                           │
│         ▼                                                           │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    MCP Provider Registry                     │   │
│  │                                                               │   │
│  │  ┌─────────────┐  ┌────────────────┐  ┌──────────────────┐  │   │
│  │  │ Filesystem   │  │ Chrome DevTools │  │ Web Fetch        │  │   │
│  │  │ Provider     │  │ Provider        │  │ Provider         │  │   │
│  │  │              │  │                 │  │                  │  │   │
│  │  │ • read_file  │  │ • navigate      │  │ • http_get       │  │   │
│  │  │ • write_file │  │ • evaluate      │  │ • http_post      │  │   │
│  │  │ • list_files │  │ • screenshot    │  │ • fetch_page_text│  │   │
│  │  │ • delete_file│  │ • get_dom       │  │                  │  │   │
│  │  │ • create_dir │  │ • console_logs  │  │                  │  │   │
│  │  │              │  │ • network_log   │  │                  │  │   │
│  │  └─────────────┘  └────────────────┘  └──────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│         │                                                           │
│         ▼                                                           │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                 Sandbox (./sandbox/)                          │   │
│  │  Path-safe file operations confined to this directory        │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ POST /v1/chat/completions
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                 llama.cpp Server (Prism Fork)                       │
│                 http://localhost:8080                                │
│                                                                     │
│  Model: Bonsai-8B.gguf (Q1, ~1.13 GB)                              │
│  Format: Hermes 2 Pro chat template                                 │
│  GPU: NVIDIA RTX 3070 (CUDA)                                       │
│                                                                     │
│  Performance (typical):                                             │
│  • Prompt eval: ~2,100 tokens/sec (0.47 ms/token)                  │
│  • Generation:  ~86 tokens/sec (11.57 ms/token)                    │
│  • Context: 33,792 tokens                                          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## How the Flow Works

### 1. LLM Server (llama.cpp)

The backbone is a local **llama.cpp** server (Prism fork) running the **Bonsai-8B.gguf** model (Q1 quantization, ~1.13 GB). It exposes an OpenAI-compatible API at `http://localhost:8080`.

```bash
# Example: start the llama.cpp server
./llama-server -m Bonsai-8B.gguf --port 8080 -ngl 99 -c 33792
```

The original `app.py` demonstrates the simplest interaction:

```python
import requests
response = requests.post(
    "http://localhost:8080/v1/chat/completions",
    json={
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Hello! What can you do?"}
        ]
    }
)
print(response.json()['choices'][0]['message']['content'])
```

The Next.js app mirrors this exact request format via `src/lib/ai-client.ts`.

### 2. Chat Request Flow

When a user sends a message, here's what happens end-to-end:

```
User types message
       │
       ▼
[Frontend] POST /api/chat
  • Attaches selected file contents (bootstrap context)
  • Sends full message history
       │
       ▼
[API Route] /api/chat/route.ts
  1. Lists sandbox files → injects into system prompt
  2. Reads selected files → concatenates into system prompt
  3. Builds tool definitions → injects into system prompt
  4. Calls runChatWithTools() loop
       │
       ▼
[Tool Processor] runChatWithTools()
  for up to 8 iterations:
    │
    ├─► POST /v1/chat/completions → llama.cpp (localhost:8080)
    │
    ├─► Parse response for <tool_call> blocks
    │
    ├─► If no tool calls → return final reply
    │
    ├─► If tool calls found:
    │     ├─► Execute each tool via MCP Registry
    │     ├─► Append assistant message + tool results to history
    │     └─► Loop again (AI sees results and can act further)
    │
    └─► Return final reply + all tool call records
       │
       ▼
[Frontend] Renders message + collapsible tool call cards
```

### 3. System Prompt Construction

Every chat request builds a system prompt with three layers:

1. **Base instructions** — "You are a helpful AI assistant..."
2. **Sandbox context** — current file list so the model knows what exists
3. **Tool definitions** — all registered MCP tools with their schemas
4. **Bootstrap files** — contents of user-selected files concatenated in

This ensures the model has full context about the workspace and available tools on every new chat.

### 4. Tool Calling (MCP Pattern)

The AI model is a simple chat model — it doesn't natively support tool calling. We implement it via:

1. **Injection**: Tool schemas are injected into the system prompt with a specific XML format
2. **Generation**: The model responds with `<tool_call>{"tool": "...", "arguments": {...}}</tool_call>` blocks
3. **Parsing**: `parseToolCalls()` extracts these blocks from the response text
4. **Execution**: Each tool call is dispatched to the matching MCP provider
5. **Looping**: Results are fed back as messages and the model continues

```
System prompt includes:
  <tool_call>
  {"tool": "tool_name", "arguments": {"path": "value"}}
  </tool_call>

Model generates:
  I'll read that file for you.
  <tool_call>
  {"tool": "sandbox_read_file", "arguments": {"path": "skills.txt"}}
  </tool_call>

Tool processor:
  → Parses the block
  → Calls filesystemProvider.execute("sandbox_read_file", {path: "skills.txt"})
  → Returns result to model as a follow-up message
  → Model generates final human-readable response
```

### 5. MCP Providers

Tools are organized as **providers** — each provider groups related tools:

| Provider | Tools | Status |
|----------|-------|--------|
| **Filesystem** | `sandbox_read_file`, `sandbox_write_file`, `sandbox_list_files`, `sandbox_delete_file`, `sandbox_create_dir` | Fully working |
| **Web Fetch** | `http_get`, `http_post`, `fetch_page_text` | Fully working |
| **Chrome DevTools** | `devtools_navigate`, `devtools_evaluate`, `devtools_screenshot`, `devtools_get_dom`, `devtools_console_logs`, `devtools_network_log` | Navigate works; CDP tools require Chrome `--remote-debugging-port=9222` |

New providers can be added by implementing the `McpProvider` interface and calling `registerProvider()`.

### 6. Sandbox Workspace

All file operations are confined to the `./sandbox/` directory:

- **Path safety**: Every path is resolved and validated to prevent directory traversal
- **Bootstrap**: Users select files from the sidebar; their contents are concatenated into the prompt
- **CRUD via UI**: Create `.md` files with the editor, open/delete from the file tree
- **CRUD via AI**: The model can read/write/list/delete files through tool calls

### 7. Frontend

Built with **Next.js 14** (App Router) + **Bootstrap 5** + **Bootstrap Icons**:

- **Chat panel** — message bubbles with Markdown rendering, collapsible tool-call cards
- **File sidebar** — file tree explorer + checkbox file selector for prompt bootstrapping
- **Tools sidebar** — lists all registered MCP tools
- **Markdown editor** — modal for creating/editing `.md` files in the sandbox

---

## Project Structure

```
├── app.py                          # Original Python proof-of-concept
├── package.json                    # Dependencies & scripts
├── next.config.mjs                 # Next.js configuration
├── tsconfig.json                   # TypeScript configuration
├── sandbox/                        # Sandboxed file workspace
│   └── README.md
│
└── src/
    ├── app/
    │   ├── layout.tsx              # Root layout (Bootstrap CSS)
    │   ├── page.tsx                # Entry point → ChatInterface
    │   ├── globals.css             # Custom styles
    │   └── api/
    │       ├── chat/route.ts       # POST: chat orchestration + tool loop
    │       ├── files/route.ts      # GET: list files / POST: create file
    │       ├── files/[...path]/route.ts  # GET/PUT/DELETE specific files
    │       └── mcp/execute/route.ts      # GET: list tools / POST: invoke tool
    │
    ├── components/
    │   ├── ChatInterface.tsx       # Main orchestrator component
    │   ├── MessageBubble.tsx       # Chat messages with Markdown
    │   ├── FileExplorer.tsx        # Sandbox file tree
    │   ├── FileSelector.tsx        # Checkbox file picker
    │   ├── MarkdownEditor.tsx      # Create/edit modal
    │   └── ToolCallDisplay.tsx     # Collapsible tool-call result cards
    │
    ├── lib/
    │   ├── ai-client.ts            # HTTP client → localhost:8080
    │   ├── tool-processor.ts       # System prompt builder + parse/execute loop
    │   ├── sandbox.ts              # Path-safe sandboxed file operations
    │   └── mcp/
    │       ├── types.ts            # MCP type definitions
    │       ├── registry.ts         # Global provider registry
    │       ├── filesystem.ts       # Sandbox CRUD tools
    │       ├── chrome-devtools.ts  # Chrome DevTools Protocol tools
    │       ├── web-fetch.ts        # HTTP / web fetch tools
    │       └── index.ts            # Barrel export
    │
    └── types/
        └── index.ts                # Shared TypeScript interfaces
```

---

## Getting Started

### Prerequisites

- **Node.js** 18+
- **llama.cpp** (Prism fork) with CUDA support
- **Bonsai-8B.gguf** model file
- **NVIDIA GPU** (RTX 3070 or equivalent; ~8 GB VRAM)

### 1. Start the LLM Server

```bash
./llama-server -m Bonsai-8B.gguf --port 8080 -ngl 99 -c 33792
```

Verify it's running:
```bash
curl http://localhost:8080/v1/models
```

### 2. Start the Frontend

```bash
npm install
npm run dev
```

Open **http://localhost:3000** in your browser.

### 3. Usage

1. **Chat** — type a message and press Enter
2. **Bootstrap context** — check files in the sidebar to attach them to your prompt
3. **Create files** — click "New MD" to create markdown files in the sandbox
4. **Tool calling** — ask the AI to read files, fetch URLs, or browse the web
5. **New Chat** — click "New Chat" to reset the session

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_BASE_URL` | `http://localhost:8080` | LLM server endpoint |

---

## Model Performance

Running **Bonsai-8B.gguf** (Q1, 1.13 GB) on an RTX 3070:

| Metric | Value |
|--------|-------|
| Prompt eval | ~2,139 tokens/sec (0.47 ms/token) |
| Generation | ~86 tokens/sec (11.57 ms/token) |
| Context window | 33,792 tokens |
| VRAM usage | ~2 GB |
| Chat format | Hermes 2 Pro |

The Q1 quantization trades some quality for extreme speed and minimal memory, making it ideal for a responsive local agent that needs fast tool-call turnaround.
