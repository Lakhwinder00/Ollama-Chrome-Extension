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

**Tools:** `read_file`, `write_file`, `edit_file`, `delete_file`, `list_directory`, `search_files`,
`run_command`, `git_status`, `git_diff`, `git_log`, `git_branch`, `git_checkout`, `git_commit`,
`web_search`, `fetch_url` (project/web) +
`get_page`, `get_dom`, `click`, `type`, `key`, `scroll`, `navigate`, `search`, `screenshot` (browser).

**Safety built in:**
- The agent can only touch files **inside the project root you choose** — every path is
  resolved and checked before it touches disk.
- Dangerous **file/shell/git** operations (`write_file`, `edit_file`, `delete_file`, `run_command`,
  `git_commit`, `git_checkout`) pause and ask for approval first.
- **Browser actions need no approval** by default: the agent may read the page, take screenshots,
  click any button, type, and update/insert/remove elements on the active tab freely. Settings →
  Automation → *Autonomy* can switch this to "confirm each change" or "describe only".
- Approvals (for file/shell/git) have **scopes**: *Once*, *Session*, or *Always* (persisted in
  `~/.myagent/permissions.json`).
- Every page change is shown live in the tab: a "Agent …" toast plus a colored highlight on the
  exact element, so you can watch each click, typing, edit, insert, and delete happen.
- The server binds to `127.0.0.1` only, and **only the Chrome extension and non-browser clients
  (CLI, desktop app) may talk to it** — a web page cannot drive the local agent (see
  [Server security](#server-security)).

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

> **Active-tab context:** the side panel has a "Read active tab into context"
> toggle (on by default). When enabled, it captures the active tab's URL, title,
> and text and attaches it to each message so the agent can plan and act on the
> page step by step, like Claude. *Send to the model* picks how much is read:
> **Selected text** (what you highlighted), **Visible page** (only what is on
> screen right now) or **Full page** (scrolled through and collected).

> **Edit requests act, they don't research:** asking to "update / fix / save /
> delete" something on the page makes the model review the active tab and change
> it (`get_dom` → `click`/`type`/`edit_element` → screenshot) instead of running a
> web search and writing an analysis. Browser actions run without approval —
> switch *Automation → Autonomy* to "confirm each change" or "describe only" —
> and each change is highlighted live in your tab so you can watch it happen.

## Server API

| Endpoint      | Method | Body                                   | Returns                       |
| ------------- | ------ | -------------------------------------- | ----------------------------- |
| `/health`     | GET    | —                                      | Ollama + project status       |
| `/models`     | GET    | —                                      | Installed models + details    |
| `/model_info` | GET    | `?name=<model>&provider=<id>`         | Context size, tools, thinking  |
| `/providers`  | GET    | —                                      | Available providers            |
| `/project`    | GET    | —                                      | Current project root          |
| `/project`    | POST   | `{ "root": "C:\\path" }`               | Set project root              |
| `/chat`       | POST   | `{ sessionId?, message, userRequest?, model?, autoApprove? }` | Server-Sent Events stream |
| `/approve`    | POST   | `{ "id": "…", "allowed": true, "scope": "once|session|always" }` | Resolve a pending approval |
| `/browser/result` | POST | `{ "id": "…", "result" or "error" }` | Return a browser-tool result  |
| `/stop`       | POST   | `{ "sessionId": "…" }`                 | Cancel a running turn         |
| `/session`    | DELETE | `{ "sessionId": "…" }`                 | Forget the session            |

`/chat` streams these SSE events: `start`, `status`, `assistant`, `tool`,
`tool_result`, `tool_denied`, `approve_request`, `browser_request`, `done`, `error`.

The extension sends two fields for the request:

- `message` — what the model sees: the live-page frame (URL, title) plus the user's request.
- `userRequest` — the user's own words, without any page text. The server routes the request
  (page work vs. research) on this, so a page that happens to contain the word "latest" cannot
  turn an edit into a research task.

Quick test without the extension:

```powershell
$body = @{ message = "List the files in the project root and tell me what the project is."; model = "qwen2.5-coder:14b"; autoApprove = $true } | ConvertTo-Json
Invoke-WebRequest -Uri http://127.0.0.1:8787/chat -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 300
```

## Server security

The server can write files and run shell commands, so it refuses to be driven by a web page:

- **Origin allow-list** — only the Chrome extension (`chrome-extension://…`) and clients that send
  no `Origin` header (the CLI, the desktop app, `curl`) are served. A normal website, a sandboxed
  iframe (`Origin: null`) or a `file://` page gets `403`.
- **Host check** — while the server is bound to loopback, the `Host` header must be `127.0.0.1`,
  `localhost` or `[::1]`. This blocks DNS rebinding (an attacker name that resolves to 127.0.0.1).
- **Loopback bind** — `HOST` defaults to `127.0.0.1`. Binding it to `0.0.0.0` prints a warning.

Provider API keys and the OpenCode password are stored in `~/.myagent/providers.json`
(mode `0600` on POSIX) so they survive a server restart.

## Free MCP server (web research)

`mcp/server.js` is a standalone **Model Context Protocol** server — 100% free, no
API keys, no charges. It exposes three tools over stdio:

- `web_search(query)` — Google top related results
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

## CLI

A terminal interface reusing the exact same Agent Core (no duplicated logic):

```powershell
node cli/myagent.js                              # interactive (cwd = project root)
node cli/myagent.js "Fix the login bug"          # one-shot
node cli/myagent.js -p C:\proj -m qwen2.5-coder:14b -y "Refactor X"
```

Options: `-p/--project`, `-m/--model`, `-y/--yes` (auto-approve). Interactive commands:
`/models`, `/clear`, `/exit`. Dangerous actions prompt
`Allow … [y=once / s=session / a=always / N=deny]`.

## Desktop app (WPF)

A Windows desktop client (like Claude Desktop) that talks to the same Agent Server
over `http://127.0.0.1:8787`. Build and run with:

```powershell
dotnet run --project desktop/MyAgent.Desktop.csproj
```

Features: model picker, project root, streaming chat with thinking/tool activity,
approve/deny with scope buttons (Once/Session/Always) for dangerous operations, and a
stop button. Requires the .NET 10 SDK.

## Model provider abstraction

The Agent Core never talks to Ollama directly — it depends on the `IModelProvider`
contract in `agent/provider.js`. `OllamaProvider` is the only implementation today
(Ollama is the primary provider), so adding `OpenAIProvider`, `AnthropicProvider`,
etc. later requires **no changes to the Agent Core, tools, or clients**.

## Tests

The Agent Core and tools have a test suite (Node's built-in runner, zero dependencies):

```powershell
cd agent
npm test
# or directly: node --test "../tests/*.test.js"
```

Covers path-traversal safety, read/write/edit/delete/list/search, git tools
(including `git_commit`/`git_checkout`), tool-call normalization, the provider
contract, the always-allow permission store, the server's origin/host policy,
the credential store, and the extension's request-intent helpers.

## Project layout

```
agent/
  server.js     HTTP server, sessions, approvals, SSE, stop
  ollama.js     thin Ollama HTTP client (streaming)
  provider.js   IModelProvider contract + OllamaProvider
  permissions.js persistent "always allow" store (~/.myagent/permissions.json)
  secrets.js    persistent provider API keys (~/.myagent/providers.json)
  http-security.js origin/host policy for the HTTP server
  tools.js      file/git/shell/web tools + schemas
  agent.js      the agent loop + system prompt + rules
  web.js        free web search / fetch helpers
cli/
  myagent.js    CLI interface (reuses the Agent Core)
desktop/
  MyAgent.Desktop.csproj  WPF desktop app (client of the Agent Server)
  MainWindow.xaml/.cs     streaming chat UI, approvals
mcp/
  server.js     free MCP server (web_search/fetch_page/wikipedia)
tests/
  tools.test.js     file/git tools + path safety
  agent.test.js     tool-call normalization + prompt
  provider.test.js  IModelProvider contract
  permissions.test.js always-allow store
  secrets.test.js   provider credential store
  http-security.test.js origin/host policy
  intent.test.js    extension request-intent helpers
extension/
  manifest.json MV3 manifest (side panel)
  sidepanel.html right-side panel UI
  popup.css     dark Claude-style theme
  popup.js      SSE streaming client, approvals, browser tools, persistence
  intent.js     request intent helpers (edit? research? ambiguous?)
  markdown.js   Markdown renderer + syntax highlighting
  background.js opens the side panel on toolbar click
```

## Roadmap status

- [x] Phase 1 — Ollama + local Node server
- [x] Phase 2 — agent loop
- [x] Phase 3 — `read_file`, `write_file`, `search_files`, `run_command`
- [x] Phase 4 — Chrome extension UI (project + model selection, streaming chat)
- [x] Phase 5 — browser tools: `get_page`, `get_dom`, `click`, `type`, `scroll`, `screenshot`, `navigate`, `search`
- [x] Phase 6 — git support (`git_status`, `git_diff`, `git_log`, `git_branch`, `git_checkout`, `git_commit`)
- [x] Phase 7 — approvals before dangerous operations (once / session / always)
- [x] Phase 8 — tests for the Agent Core and tools

## Troubleshooting

- **"ollama unreachable"** — start Ollama (`ollama serve`) and check `http://127.0.0.1:11434`.
- **Panel looks frozen** — it is not: a pulsing `working…` shows a running tool, and a
  "… still working, waiting for the model (Ns)" line appears every ~12s while the model is
  silent. Web searches/fetches time out after 15–20s instead of hanging, and research reads
  announce "Reading source 1/3…" as it goes.
- **"No new progress after 5 repeated steps"** — there is no step limit: a run only ends when
  the model answers or you stop it. If the model gets stuck repeating the same blocked action,
  it is first asked twice for a plain-text final answer (JSON-only replies are retried),
  and if that fails the question is **researched from scratch** (search + reads) and answered,
  with the list of tool calls, outcomes, and any page/file changes appended. Reply **continue**
  to resume from there. The old "Stopped: maximum steps reached." message no longer exists —
  if you still see it, restart `agent/server.js` (old code in memory) and press **Clear History**.
- **Model doesn't call tools** — use a tools-capable model (`qwen2.5-coder:14b`).
- **"Access denied"** — the path resolved outside the project root; set the right project.
