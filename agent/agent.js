/**
 * The agent loop: repeatedly ask Ollama, run any requested tools, feed the
 * results back, and keep going until the model produces a final answer.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { chatStream } = require('./ollama');
const { execute, getProjectRoot, TOOL_DEFINITIONS, BROWSER_TOOLS } = require('./tools');

const DANGEROUS_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'run_command']);
const MAX_ITERATIONS = 15;
const MAX_HISTORY = 80;

const PLAN_PROMPT =
  "Before using any tools, think step by step about the user's request: what you need to inspect, what you plan to change, and why. Describe your plan briefly, then stop. Do not call any tools yet.";

function buildSystemPrompt() {
  const root = getProjectRoot();
  const projectLine = root
    ? `- Project root: ${root}\n- You may read and write files ONLY inside this directory.`
    : '- No project is selected yet. Ask the user to set a project root before using file or shell tools.';
  return [
    'You are a senior software engineer agent embedded in a coding project, similar to Claude Code.',
    'You help the user by inspecting code, explaining it, making edits, and running commands.',
    '',
    'Environment:',
    `- Operating system: ${os.platform()} (${os.release()})`,
    projectLine,
    '',
    'Available tools:',
    '- read_file(path, start_line?, end_line?) — read a file with line numbers.',
    '- write_file(path, content) — create or overwrite a file.',
    '- edit_file(path, old_string, new_string, replace_all?) — make a targeted edit.',
    '- delete_file(path) — delete a file (requires approval).',
    '- list_directory(path?) — list files and folders in a directory.',
    '- search_files(query, path?) — search file names and contents.',
    '- run_command(command, path?, timeout?) — run a shell command (Windows cmd).',
    '- git_status() — show changed files.',
    '- git_diff() — show the uncommitted diff.',
    '- git_log(n?) — show recent commits.',
    '- git_branch() — list branches.',
    '- web_search(query) — search the web (DuckDuckGo) and return top results with snippets.',
    '- fetch_url(url) — fetch a web page and read its text (use after web_search to read a result).',
    '',
    "Browser tools (operate on the user's active Chrome tab):",
    "- get_page(max_chars?, max_scrolls?) — read the tab's URL, title, and full page text (auto-scrolls).",
    '- get_dom(selector?, max_items?) — list clickable/fillable elements on the page.',
    '- click(selector? or text?) — click an element on the page.',
    '- type(selector? or text?, value) — type into a field on the page.',
    '- scroll(direction?, amount?, selector?) — scroll the page or an element into view.',
    '- screenshot — capture the active tab as an image to verify the result.',
    '- navigate(url) — open a URL in the active tab.',
    '- search(query) — search Google and open the results.',
    '',
    'When the user asks about the current page or the browser, use get_page or get_dom first.',
    "When the user refers to a page, profile, or website, read the active tab with get_page first. If it is not the right page, use search to find it on Google.",
    'After clicking, typing, or scrolling, take a screenshot to verify what happened.',
    '',
    'Rules:',
    '1. Inspect the relevant files before changing them.',
    '2. Make minimal, focused edits; do not rewrite whole files unless asked.',
    '3. Prefer non-interactive commands that terminate on their own.',
    '4. After a tool call, read the result and adapt instead of repeating the same failing call.',
    '5. In your final answer, briefly state what you changed and why, plus any next steps.',
    '6. Use Markdown for code snippets and file paths in your answers.',
    "7. Stay focused on the user's current request. Do not explore the project or run extra commands unless the request requires it.",
    '8. Never repeat the same command or tool call. If something fails or returns nothing useful, stop and explain.',
    '9. If you do not know the answer or need current information, follow the research method: web_search, fetch_url, cross-check, then answer with citations. Do not make up facts.',
    '10. Investigate before asking: when the user asks about "my profile", "this page", or any real-world thing, use get_page or search first. Only ask the user for clarification if the tools do not help.',
    '',
    'Research method (for factual or "latest" questions):',
    '1. Run several different web_search queries to gather diverse sources.',
    '2. Prefer authoritative/primary sources (official docs, Wikipedia, GitHub).',
    '3. Use fetch_url to read the top 3-5 sources in full.',
    '4. Cross-check facts across sources and note disagreements.',
    '5. Prefer the most recent primary source when they conflict.',
    '6. Answer with citations (title + URL) and a confidence note. Never claim 100% certainty.',
  ].join('\n') + loadProjectRules(root);
}

/** Load optional project instructions from .myagent/rules.md. */
function loadProjectRules(root) {
  if (!root) return '';
  try {
    const p = path.join(root, '.myagent', 'rules.md');
    if (fs.existsSync(p)) {
      return '\n\nProject rules (.myagent/rules.md):\n' + fs.readFileSync(p, 'utf8').slice(0, 4000);
    }
  } catch {
    // ignore unreadable rules file
  }
  return '';
}

function ensureSystemMessage(messages) {
  const system = { role: 'system', content: buildSystemPrompt() };
  const list = Array.isArray(messages) ? messages.slice() : [];
  if (list.length && list[0].role === 'system') {
    list[0] = system;
  } else {
    list.unshift(system);
  }
  if (list.length > MAX_HISTORY) {
    const trimmed = list.filter((m) => m.role === 'system');
    trimmed.push(...list.slice(-(MAX_HISTORY - trimmed.length)));
    return trimmed;
  }
  return list;
}

function summarizeResult(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result.slice(0, 200);
  if (Array.isArray(result)) return `${result.length} item(s)`;
  const parts = [];
  if (result.path) parts.push(result.path);
  if (result.lines) parts.push(`lines ${result.lines.start}-${result.lines.end} of ${result.lines.total}`);
  if (result.bytesWritten != null) parts.push(`${result.bytesWritten} bytes written`);
  if (result.matches != null) parts.push(`${result.matches} match(es)`);
  if (result.exitCode != null) {
    const out = (result.stdout || '').length + (result.stderr || '').length;
    parts.push(`exit ${result.exitCode}, ${out} chars output`);
  }
  if (result.results && Array.isArray(result.results)) parts.push(`${result.results.length} web result(s)`);
  if (result.error) parts.push(`error: ${result.error}`);
  return parts.join(' · ') || JSON.stringify(result).slice(0, 200);
}

/** A truncated, human-readable dump of a tool result for display in the UI. */
function resultDetail(result) {
  if (result == null) return '';
  let s;
  if (typeof result === 'string') s = result;
  else {
    try {
      s = JSON.stringify(result, null, 2);
    } catch {
      s = String(result);
    }
  }
  return s.slice(0, 4000);
}

/** Trim a tool result before storing it in history (bounds context growth). */
function historyResult(result) {
  let s;
  if (typeof result === 'string') s = result;
  else {
    try {
      s = JSON.stringify(result);
    } catch {
      s = String(result);
    }
  }
  const MAX = 8000;
  return s.length > MAX ? s.slice(0, MAX) + `\n...(truncated ${s.length - MAX} chars)` : s;
}

/**
 * Convert a raw JSON object into the native Ollama tool-call shape:
 * { function: { name, arguments } } where arguments is a JSON string.
 * Accepts several common formats models emit by hand.
 */
function convertToolCallObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const fnObj = obj.function || obj;
  const name = fnObj.name || obj.tool || obj.tool_name;
  if (!name) return null;
  let args = fnObj.arguments ?? obj.args ?? obj.parameters ?? obj.input;
  if (args == null) args = {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = { _raw: args };
    }
  }
  if (typeof args !== 'object' || Array.isArray(args)) args = { value: args };
  return { function: { name: String(name), arguments: args } };
}

/**
 * Fallback for models that write their tool call as JSON text in the message
 * content instead of using the native `tool_calls` field. Returns a normalized
 * tool-call list plus any leftover text, or null when no tool call is found.
 */
function parseToolCallsFromContent(content) {
  if (!content) return null;

  // Whole message is a JSON object/array.
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const data = JSON.parse(trimmed);
      const list = Array.isArray(data) ? data : [data];
      const toolCalls = list.map(convertToolCallObject).filter(Boolean);
      if (toolCalls.length) return { toolCalls, remaining: '' };
    } catch {
      // not JSON — fall through
    }
  }

  // One or more fenced ```json blocks.
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let match;
  while ((match = fenceRe.exec(content))) {
    try {
      const data = JSON.parse(match[1].trim());
      const list = Array.isArray(data) ? data : [data];
      const toolCalls = list.map(convertToolCallObject).filter(Boolean);
      if (toolCalls.length) {
        const remaining = content.replace(fenceRe, '').trim();
        return { toolCalls, remaining };
      }
    } catch {
      // keep scanning for other blocks
    }
  }

  return null;
}

/**
 * Normalize tool calls into a canonical shape where `function.arguments` is an
 * object. Ollama's Qwen template rejects string arguments, and the native
 * tool_calls field returns them as a JSON string — so we convert before
 * writing the assistant message back into history.
 */
function normalizeToolCalls(toolCalls) {
  return (Array.isArray(toolCalls) ? toolCalls : []).map((tc) => {
    const fn = (tc && tc.function) || {};
    const name = fn.name || tc.name;
    let args = fn.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = { _raw: args };
      }
    }
    if (args == null || typeof args !== 'object' || Array.isArray(args)) args = {};
    return { function: { name: String(name || 'unknown_tool'), arguments: args } };
  });
}

async function runAgent({
  model,
  messages,
  tools = TOOL_DEFINITIONS,
  autoApprove = false,
  think = false,
  planFirst = false,
  requestApproval,
  requestBrowser,
  signal,
  onEvent = () => {},
}) {
  const history = ensureSystemMessage(messages);
  const recentCalls = [];

  // For models without a native thinking stream (e.g. qwen2.5-coder), run a
  // short "think out loud" pass so the user can still see the model's plan.
  if (planFirst) {
    onEvent({ type: 'status', message: 'Planning…' });
    try {
      await chatStream({
        model,
        messages: [...history, { role: 'user', content: PLAN_PROMPT }],
        think,
        signal,
        onDelta: (d) => {
          if (d.type === 'thinking') onEvent({ type: 'thinking', content: d.content });
          else if (d.type === 'assistant') onEvent({ type: 'thinking', content: d.content });
        },
      });
      // The plan is shown to the user for transparency only; it is not fed
      // back into the loop (that would make some models skip the actual work).
    } catch {
      if (signal && signal.aborted) {
        return { content: 'Stopped by the user.', history, stopped: true };
      }
      // planning is best-effort; continue even if it fails
    }
  }

  for (let step = 1; step <= MAX_ITERATIONS; step++) {
    if (signal && signal.aborted) {
      return { content: 'Stopped by the user.', history, stopped: true };
    }
    onEvent({ type: 'status', message: step === 1 ? 'Thinking…' : `Step ${step}: continuing…` });

    let res;
    try {
      res = await chatStream({
        model,
        messages: history,
        tools,
        think,
        signal,
        onDelta: (d) => {
          if (d.type === 'thinking') onEvent({ type: 'thinking', content: d.content });
          else if (d.type === 'assistant') onEvent({ type: 'assistant', content: d.content });
        },
      });
    } catch (e) {
      if (signal && signal.aborted) {
        return { content: 'Stopped by the user.', history, stopped: true };
      }
      throw e;
    }
    const msg = res.message || {};
    let content = msg.content || '';
    let toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

    // Some local models emit the tool call as JSON text instead of using the
    // native tool_calls field — detect and convert it so the loop still works.
    if (!toolCalls.length) {
      const fallback = parseToolCallsFromContent(content);
      if (fallback) {
        toolCalls = fallback.toolCalls;
        content = fallback.remaining;
      }
    }
    toolCalls = normalizeToolCalls(toolCalls);

    if (content && !res.streamedContent) {
      onEvent({ type: 'assistant', content });
    }
    history.push({
      role: 'assistant',
      content,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    });

    if (!toolCalls.length) {
      return { content, history };
    }

    for (const tc of toolCalls) {
      const fn = tc.function || {};
      const name = fn.name;
      const args = fn.arguments || {};
      onEvent({ type: 'tool', name, arguments: args });

      // Guard against the model looping on the same action.
      const callKey = name + ':' + JSON.stringify(args);
      recentCalls.push(callKey);
      if (recentCalls.length > 5) recentCalls.shift();
      if (recentCalls.filter((k) => k === callKey).length >= 3) {
        onEvent({ type: 'tool_result', name, ok: false, error: 'Repeated action detected — skipped.' });
        history.push({
          role: 'tool',
          content: JSON.stringify({
            error: 'You are repeating the same action. Do NOT retry it. Answer the user directly or ask for clarification.',
          }),
        });
        continue;
      }

      if (DANGEROUS_TOOLS.has(name) && !autoApprove && typeof requestApproval === 'function') {
        const approved = await requestApproval(name, args);
        if (!approved) {
          onEvent({ type: 'tool_denied', name });
          history.push({
            role: 'tool',
            content: JSON.stringify({
              error: `The user denied the ${name} call. Do not retry it automatically. Explain that it was denied and ask how they would like to proceed.`,
            }),
          });
          continue;
        }
      }

      let result;
      try {
        if (BROWSER_TOOLS.has(name)) {
          if (typeof requestBrowser !== 'function') {
            throw new Error(`Browser tool "${name}" needs the Chrome extension popup to be open.`);
          }
          result = await requestBrowser(name, args);
          onEvent({ type: 'tool_result', name, ok: true, summary: summarizeResult(result), detail: resultDetail(result) });
        } else {
          result = await execute(name, args);
          onEvent({ type: 'tool_result', name, ok: true, summary: summarizeResult(result), detail: resultDetail(result) });
        }
      } catch (e) {
        result = { error: String((e && e.message) || e) };
        onEvent({ type: 'tool_result', name, ok: false, error: result.error });
      }
      history.push({ role: 'tool', content: historyResult(result) });
    }
  }

  const final =
    'I reached the maximum number of steps without finishing. Please ask me to continue or narrow the task.';
  onEvent({ type: 'status', message: 'Stopped: maximum steps reached.' });
  return { content: final, history };
}

module.exports = { runAgent, buildSystemPrompt };
