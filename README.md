# Local Code Agent

A Claude Code-like coding agent that runs **entirely on your machine**, powered by a local
[Ollama](https://ollama.com) model. The Chrome extension is just the UI; a tiny Node.js
server is the agent's "hands".

```
Chrome Extension (UI)
        │  HTTP + Server-Sent Events
        ▼
Local Agent Server  :8787        (agent/server.js)
        │
        ├──► Ollama  :11434      (qwen2.5-coder:14b, gemma4:latest, …)
        │
        └──► Project files / shell (read_file, write_file, search_files, run_command)
```

## What it does

The agent loop turns a plain chat model into a coding agent:

```
User → Ollama ("I need to read login.js")
     → read_file()
     → file content
     → Ollama ("I need to edit login.js")
     → write_file()   ← asks for your approval first
     → Ollama → final answer
```

**Tools:** `read_file`, `write_file`, `search_files`, `run_command`, `web_search`, `fetch_url` (project/web) +
`get_page`, `get_dom`, `click`, `type`, `scroll`, `navigate`, `search`, `screenshot` (browser).

**Safety built in:**
- The agent can only touch files **inside the project root you choose** — every path is
  resolved and checked before it touches disk.
- `write_file` and `run_command` pause and ask for **Approve / Deny** in the popup.
- The server binds to `127.0.0.1` only.

## Requirements

- [Node.js](https://nodejs.org) 18+ (no npm packages needed — zero dependencies)
- [Ollama](https://ollama.com) running locally with a tools-capable model
  (e.g. `ollama pull qwen2.5-coder:14b`)

## Run the agent server

```powershell
cd agent
node server.js
```

It listens on `http://127.0.0.1:8787`. Optional env vars:

| Variable       | Default                | Meaning                          |
| -------------- | ---------------------- | -------------------------------- |
| `PORT`         | `8787`                 | Server port                      |
| `HOST`         | `127.0.0.1`            | Bind address                     |
| `OLLAMA_URL`   | `http://127.0.0.1:11434` | Ollama API base URL            |
| `OLLAMA_MODEL` | `qwen2.5-coder:14b`    | Default model                    |

## Load the Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension/` folder
4. Pin the extension, then click its icon — the agent opens in a **side panel on the
   right** (like Claude's extension). Set your **Project root** (e.g. `C:\Projects\MyApp`)

Pick a model from the dropdown, then just ask it to fix a bug.

> **Browser access:** the extension needs the broad "read and change data on all
> websites" permission to read/click/type on any page (like Claude's browser
> control). After reloading, accept that permission, or browser tools will fail
> with "manifest must request permission to access the host".

## Server API

| Endpoint      | Method | Body                                   | Returns                       |
| ------------- | ------ | -------------------------------------- | ----------------------------- |
| `/health`     | GET    | —                                      | Ollama + project status       |
| `/models`     | GET    | —                                      | Installed Ollama models       |
| `/project`    | GET    | —                                      | Current project root          |
| `/project`    | POST   | `{ "root": "C:\\path" }`               | Set project root              |
| `/chat`       | POST   | `{ sessionId?, message, model?, autoApprove? }` | Server-Sent Events stream |
| `/approve`    | POST   | `{ "id": "…", "allowed": true }`       | Resolve a pending approval    |
| `/browser/result` | POST | `{ "id": "…", "result" or "error" }` | Return a browser-tool result  |

`/chat` streams these SSE events: `start`, `status`, `assistant`, `tool`,
`tool_result`, `tool_denied`, `approve_request`, `browser_request`, `done`, `error`.

Quick test without the extension:

```powershell
$body = @{ message = "List the files in the project root and tell me what the project is."; model = "qwen2.5-coder:14b"; autoApprove = $true } | ConvertTo-Json
Invoke-WebRequest -Uri http://127.0.0.1:8787/chat -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 300
```

## Free MCP server (web research)

`mcp/server.js` is a standalone **Model Context Protocol** server — 100% free, no
API keys, no charges. It exposes three tools over stdio:

- `web_search(query)` — DuckDuckGo top results
- `fetch_page(url)` — readable text of any web page
- `wikipedia(query)` — Wikipedia summary of the top article

Use it in any MCP client. For **Claude Desktop**, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "free-research": {
      "command": "node",
      "args": ["C:\\Development\\Ollama-Chrome-Extension\\mcp\\server.js"]
    }
  }
}
```

The Chrome extension agent already uses the same free tools directly
(`web_search` + `fetch_url`), so no MCP setup is needed for it.

## Project layout

```
agent/
  server.js     HTTP server, sessions, approvals, SSE
  ollama.js     thin Ollama HTTP client
  tools.js      read_file / write_file / search_files / run_command (+ tool schemas)
  agent.js      the agent loop + system prompt
extension/
  manifest.json MV3 manifest (side panel)
  sidepanel.html right-side panel UI
  popup.css     dark Claude-style theme
  popup.js      SSE streaming client, approvals, browser tools, persistence
  background.js opens the side panel on toolbar click
```

## Roadmap status

- [x] Phase 1 — Ollama + local Node server
- [x] Phase 2 — agent loop
- [x] Phase 3 — `read_file`, `write_file`, `search_files`, `run_command`
- [x] Phase 4 — Chrome extension UI (project + model selection, streaming chat)
- [ ] Phase 5 — browser tools: `get_page`, `get_dom`, `click`, `type`, `screenshot` done; `get_console` not yet
- [ ] Phase 6 — git support (safe wrappers around status/diff/commit)
- [x] Phase 7 — approvals before dangerous operations

## Troubleshooting

- **"ollama unreachable"** — start Ollama (`ollama serve`) and check `http://127.0.0.1:11434`.
- **Model doesn't call tools** — use a tools-capable model (`qwen2.5-coder:14b`).
- **"Access denied"** — the path resolved outside the project root; set the right project.
