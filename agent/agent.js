/**
 * The agent loop: repeatedly ask Ollama, run any requested tools, feed the
 * results back, and keep going until the model produces a final answer.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { OllamaProvider } = require('./provider');
const { sanitizeSearchQuery } = require('./web');
const { execute, getProjectRoot, TOOL_DEFINITIONS, BROWSER_TOOLS } = require('./tools');

const DANGEROUS_TOOLS = new Set([
  'write_file',
  'edit_file',
  'delete_file',
  'run_command',
  'git_commit',
  'git_checkout',
  // Browser tools (click/type/edit_element/add_element/delete_element/navigate)
  // need NO approval: the model may read the page, take screenshots, click any
  // button, and update content freely — every change is highlighted live in the
  // user's tab and disappears on refresh.
]);
const MAX_HISTORY = 80;
/** No step limit: a run only ends when the model answers or the user stops it.
 *  This many straight steps with no new tool output (only blocked repeats)
 *  means the model is stuck, so the run is wrapped up with a final answer. */
const MAX_STAGNANT_STEPS = 5;

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
    '- git_checkout(branch) — switch to a branch (requires approval).',
    '- git_commit(message, files?, all?) — stage and commit changes (requires approval). Show git_diff first.',
    '- web_search(query) — search the web and return the top related links. query must be a few short keywords, never the whole message or page text.',
    '- fetch_url(url) — fetch a web page and read its text (use after web_search to read a result).',
    '',
    "Browser tools (operate on the user's active Chrome tab — always allowed, no approval needed):",
    "- get_page(max_chars?, max_scrolls?) — read the tab's URL, title, and full page text (auto-scrolls).",
    '- get_dom(selector?, max_items?) — snapshot the page as a numbered element list (index, tag, text, selector). Re-run it whenever an index looks stale.',
    '- click(index? or selector? or text?, button?) — click any element on the page (links, buttons, tabs, menus). button: "left" (default), "double", or "right" (context menu). index (from get_dom) is the most reliable.',
    '- type(index? or selector? or text?, value, press_enter?) — type into a field on the page, character by character as a user would. press_enter: true presses Enter afterwards (submit/search).',
    '- key(keys, index?/selector?/text?) — press keyboard keys/shortcuts with full keyboard control: "Enter", "Escape", "Tab", "ArrowDown", "Ctrl+A", "Ctrl+Shift+P", "Ctrl+S". Without a target it presses on the focused element/page; space-separated keys run in sequence.',
    '- edit_element(index? or selector? or match?, text?/html?/value?/attribute?, attribute_value?) — update an existing element on the page.',
    '- add_element(html? or text?, selector?, index?, position?) — add new content to the page.',
    '- delete_element(index? or selector? or match?) — remove an element from the page.',
    '- scroll(direction?, amount?, selector?) — scroll the page or an element into view.',
    '- screenshot — capture the active tab. With a vision-capable model the image is sent back to you so you can see the page like the user does.',
    '- navigate(url) — open a URL in the active tab.',
    '- search(query) — search Google and open the results.',
    '',
    "When the user asks about the current page or the browser, use get_page or get_dom first.",
    "When the user refers to a page, profile, or website, read the active tab with get_page first. If it is not the right page, use search to find it on Google.",
    'Decide yourself whether a search is needed: the extension never searches on its own. Call search only when the answer, page, or profile genuinely requires it (unknown or current information, or the right page is not open). If you can answer from the active tab or your knowledge, do not search.',
    'Every browser action runs live in the user-visible active tab, and the user watches it happen step by step. Prefer a short, precise search query over a long prompt, and never search speculatively.',
    'You have full permission to operate the active tab — full mouse and keyboard control: take screenshots, read and understand the page, click (left, double, or right), type into any field, press any key or shortcut (Enter, Escape, Tab, Ctrl+A…), and update or remove any content — no approval is needed for browser actions. Changes are highlighted live in the user\'s tab as they happen.',
    'You may change the page itself when you judge it needs changing (fix or update text, add missing content, remove noise or popups): call edit_element/add_element/delete_element (and click/type) directly. Do not ask the user to approve each step in chat — just do it. Changes only affect the current tab and disappear on refresh, so be bold but purposeful — change what the task requires, then screenshot to verify.',
    'EDIT REQUESTS ARE NOT RESEARCH: when the user asks to update, edit, fix, save, fill, add, or remove something ("update my profile", "correct my headline", "save the form"), you MUST act on the active tab (get_dom → click/type/edit_element → screenshot) and report what changed. Never answer an edit request with web_search, a link list, or a written analysis, and never hand the steps back to the user.',
    'You CAN edit live pages the user already has open — profiles, settings, forms, dashboards. For example, updating a profile means: click the Edit button, click each field, type the new text, click Save — all with your tools.',
    'NEVER hand manual instructions back to the user ("click Edit yourself", "you need to update...", numbered how-to steps) while the relevant page is (or can be) open in the active tab. Do the steps yourself instead. Only fall back to written instructions if a tool genuinely failed and you show the error.',
    'After clicking, typing, scrolling, or editing, take a screenshot to verify what happened — screenshot anytime you need to see the page.',
    '',
    'Browser task method (act on the active tab / a website, step by step like Claude):',
    '1. Understand the page first. If the message contains an "[Active browser tab ...]" block, use it; otherwise call get_page or get_dom.',
    '2. Before acting, write a short numbered plan: "Step 1: ...", "Step 2: ...", each naming the exact tool and target (index from get_dom, selector, text, or url).',
    '3. Execute the plan one step at a time using the browser tools (click, type, key, navigate, scroll, search, edit_element, add_element, delete_element).',
    '4. After each click/type/navigate/edit, take a screenshot to verify (you will see it if your model supports vision) or re-read with get_dom. If an element index went stale, re-run get_dom. Never repeat the same failing action.',
    '5. When the goal is done, stop and briefly summarize the steps performed and the result.',
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
    '11. Act, do not instruct: never reply with manual steps the user could follow in the browser — perform them yourself with click/type/edit_element/add_element, then report what you changed.',
    '',
    'Research method (for factual or "latest" questions):',
    '1. Run several different web_search queries to gather diverse sources.',
    '2. Prefer authoritative/primary sources (official docs, Wikipedia, GitHub).',
    '3. Use fetch_url to read the top 3-5 sources in full.',
    '4. Cross-check facts across sources and note disagreements.',
    '5. Prefer the most recent primary source when they conflict.',
    '6. Answer with citations (title + URL) and a confidence note. Never claim 100% certainty.',
    '7. Never search in a loop: keep researching as long as each new query adds new sources or facts; when results stop changing, stop and answer from what you gathered, noting anything missing.',
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
    // Ollama rejects histories with no user turn (500 "no user query found in
    // messages") — trimming must never drop every user message.
    if (!trimmed.some((m) => m.role === 'user')) {
      const ask = lastUserText(list) || 'Please continue from the results above and answer the original request.';
      const firstNonSystem = trimmed.findIndex((m) => m.role !== 'system');
      trimmed.splice(firstNonSystem === -1 ? trimmed.length : firstNonSystem, 0, { role: 'user', content: ask });
    }
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

function shouldRunWebResearch(content) {
  const text = String(content ?? '').trim();
  if (!text) return true;
  const normalized = text.replace(/\s+/g, ' ').toLowerCase();
  if (normalized.length < 25) {
    return /(i don['’]t know|not sure|unable to answer|cannot determine|can['’]t answer|not enough information|unknown|unsure)/i.test(text);
  }
  return /(i don['’]t know|not sure|unable to answer|cannot determine|can['’]t answer|not enough information|unknown|unsure|i do not know|i am not sure|i can['’]t tell)/i.test(text);
}

const PAGE_ACTION_RE =
  /\b(updat\w*|edit\w*|chang\w*|fix\w*|correct\w*|replac\w*|rewrit\w*|fill\w*|add\w*|remov\w*|delet\w*|sav\w*|submit\w*|publish\w*|post\w*|writ\w*|appl\w*|renam\w*|complet\w*|improv\w*)\b/i;

/** The raw text of the last user message (context wrappers included). */
function lastUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()) return m.content;
  }
  return '';
}

/**
 * The user's own words, with the extension's context wrappers stripped:
 * the research prompt ("The user asks: …") and the active-tab block.
 */
function userIntentText(messages) {
  let text = lastUserText(messages);
  const asked = /The user asks?:\s*["“]([^"”]{1,600})["”]/i.exec(text);
  if (asked) return asked[1].trim();
  const marker = '[/Active browser tab]';
  const idx = text.indexOf(marker);
  if (idx !== -1) text = text.slice(idx + marker.length);
  return text.trim().slice(0, 600);
}

/**
 * True when the user asked to CHANGE the page ("update my profile", "fix the
 * headline", "delete the banner") instead of asking a factual question. Those
 * must be answered by acting on the active tab — never by web research.
 */
function isPageActionRequest(messages) {
  const intent = userIntentText(messages);
  if (!intent) return false;
  // Questions are research, not edits ("How can I improve my profile?").
  const looksLikeQuestion =
    intent.includes('?') ||
    /^\s*(what|who|when|where|why|how|which|is|are|was|were|does|did|do|can|could|will|would|should|explain|describe|summar\w*|tell me)\b/i.test(
      intent
    );
  if (looksLikeQuestion) return false;
  return PAGE_ACTION_RE.test(intent);
}

const MAX_BROWSER_NUDGES = 2;
const ACT_DIRECTLY_PROMPT =
  'Use your browser tools and do it yourself on the active tab right now — do not give me manual instructions. Read the page (get_page or get_dom), perform each step with click / type / edit_element / add_element, verify with screenshot, and only then summarize what you changed. If a tool genuinely fails, show the error and continue with the next step.';

/** Detects a reply that hands manual browser steps back to the user instead of acting. */
function looksLikeManualInstructions(content) {
  const text = String(content || '').trim();
  if (text.length < 80) return false;
  const tellsUser =
    /(you(?:'ll| will| can| should| need to| must| have to)|yourself|manually|on your own|follow these steps)/i.test(text);
  const hasSteps = /^\s*(?:\d+[.)]|[-*]\s)/m.test(text);
  const browserish =
    /(click|type|edit|updat|add|remov|scroll|open|navigat|search|profile|page|section|button|field|form|headline|about|skill)/i.test(text);
  return tellsUser && hasSteps && browserish;
}

/** Splits a base64 screenshot out of a tool result so it never bloats history. */
function splitImage(result) {
  if (result && typeof result === 'object' && typeof result.image === 'string' && result.image.startsWith('data:')) {
    const rest = Object.assign({}, result);
    const image = rest.image;
    delete rest.image;
    return { rest, image };
  }
  return { rest: result, image: null };
}

/** data-URL -> raw base64 (what Ollama's message.images expects). */
function imageToBase64(dataUrl) {
  const s = String(dataUrl || '');
  const i = s.indexOf('base64,');
  return i === -1 ? s : s.slice(i + 7);
}

/**
 * Live "still working" heartbeat: large prompts (page context + search
 * results) can make the model stay silent for a long time, and the UI looked
 * frozen. Emits a status line every ~12s of model silence until stopped.
 */
function startHeartbeat(onEvent, label) {
  let last = Date.now();
  const timer = setInterval(() => {
    const idle = Math.round((Date.now() - last) / 1000);
    if (idle >= 12) {
      onEvent({ type: 'status', message: `${label} — still working, waiting for the model (${idle}s)…` });
    }
  }, 6000);
  return {
    touch: () => {
      last = Date.now();
    },
    stop: () => clearInterval(timer),
  };
}

/**
 * Last-resort answer: after the model has stopped making progress (or needs a
 * final answer), ask it — without tools — to answer from what it gathered.
 * Local models often answer with an empty string or a JSON blob, so the
 * prompt is retried with a stricter plain-text instruction before giving up.
 */
const SYNTHESIS_PROMPTS = [
  'You have gathered enough information. Give the final answer NOW using only the tool results already in this conversation. Do NOT call any tools. Start with the direct answer, cite the sources (title + URL) from the search results, and end with a short confidence note.',
  'Write the final answer now as PLAIN TEXT ONLY: no JSON, no code fences, no tool calls, no bracketed objects. If you output a single "{" or "[" the user sees nothing. Give 3-6 short bullet lines starting with "- ", answering the request from the tool results already in this conversation.',
];

/** Reject empty, JSON-only, or fenced-only replies so a retry can happen. */
function usableFinalText(raw) {
  let text = String(raw || '').trim();
  if (!text) return null;
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
  if (!text) return null;
  if (/^[\[{]/.test(text)) {
    // JSON-only reply — useless to the user; let the stricter retry handle it.
    return null;
  }
  if (text.length < 10) return null;
  return text;
}

async function synthesizeFinalAnswer({ history, provider, model, signal, onEvent = () => {} }) {
  onEvent({ type: 'status', message: 'Enough information gathered — writing the final answer…' });

  for (let attempt = 0; attempt < SYNTHESIS_PROMPTS.length; attempt++) {
    let streamed = '';
    let res;
    const hb = startHeartbeat(onEvent, 'Writing the final answer');
    try {
      res = await provider.chatStream({
        model,
        messages: [
          ...history,
          { role: 'user', content: SYNTHESIS_PROMPTS[attempt] },
        ],
        think: false,
        signal,
        onDelta: (d) => {
          hb.touch();
          if (d.type === 'thinking') onEvent({ type: 'thinking', content: d.content });
          else if (d.type === 'assistant') {
            streamed += d.content;
            onEvent({ type: 'assistant', content: d.content });
          }
        },
      });
    } catch (e) {
      if (signal && signal.aborted) return null;
      // network/model error — try the next prompt before giving up
      continue;
    } finally {
      hb.stop();
    }
    const text = usableFinalText(streamed || (res && res.message && res.message.content));
    if (!text) continue; // empty or JSON-only: retry with the stricter prompt
    if (!streamed) onEvent({ type: 'assistant', content: text });
    return text;
  }
  return null;
}

/** One-line outcome of a tool result, safe to show in a progress list. */
function briefToolResult(content) {
  let s = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object') {
      if (obj.error) s = String(obj.error);
      else if (Array.isArray(obj.results)) s = `${obj.results.length} search result(s)`;
      else s = JSON.stringify(obj);
    }
  } catch {
    // plain string already
  }
  s = String(s).replace(/\s+/g, ' ').trim();
  if (s.length > 140) s = s.slice(0, 137) + '…';
  return s || 'ok';
}

/**
 * Deterministic wrap-up used when the model never produces a final answer:
 * lists every tool call of the run with its outcome, so the user always gets
 * a real result instead of a dead end.
 */
function progressSummary(history, lead) {
  const steps = [];
  for (const m of history) {
    if (!m || m.role === 'system') continue;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = (tc && tc.function) || {};
        steps.push({ name: String(fn.name || 'tool'), outcome: '' });
      }
    } else if (m.role === 'tool' && steps.length) {
      for (let i = steps.length - 1; i >= 0; i--) {
        if (!steps[i].outcome) {
          steps[i].outcome = briefToolResult(m.content);
          break;
        }
      }
    }
  }

  const request = userIntentText(history).slice(0, 160);
  const shown = steps.slice(-10);
  const lines = shown.map((s) => `- ${s.name}: ${s.outcome || 'done'}`);
  const changed = steps.filter((s) =>
    /^(edit_element|add_element|delete_element|click|type|write_file|edit_file|run_command)$/.test(s.name)
  );

  const out = [
    lead ||
      (request
        ? `I stopped making new progress before finishing "${request}". Here is what I did:`
        : 'I stopped making new progress before finishing. Here is what I did:'),
    '',
    ...(lines.length ? lines : ['- No tools were executed.']),
    '',
    changed.length
      ? `${changed.length} change(s) were applied — check the page/files above.`
      : 'No changes were saved yet.',
    '',
    `Say "continue" to resume from these results (I will pick up where I stopped), or ask with a narrower request.`,
  ];
  return out.join('\n');
}

async function runWebResearchFallback(messages, onEvent = () => {}) {
  const userMessages = (Array.isArray(messages) ? messages : []).filter((m) => m.role === 'user' && typeof m.content === 'string');
  const rawQuery = (userMessages.at(-1)?.content || '').trim() || 'latest facts and official sources';
  // The user message may carry the whole page as context — never search with it.
  const query = sanitizeSearchQuery(rawQuery);
  onEvent({ type: 'status', message: 'No answer from the model; checking web sources…' });
  onEvent({ type: 'tool', name: 'web_search', arguments: { query } });

  let search;
  try {
    search = await execute('web_search', { query });
  } catch (err) {
    const message =
      'I could not answer from local context, and the web search failed: ' +
      String((err && err.message) || err);
    onEvent({ type: 'tool_result', name: 'web_search', ok: false, error: message });
    onEvent({ type: 'assistant', content: message });
    return { content: message, sources: [] };
  }
  onEvent({ type: 'tool_result', name: 'web_search', ok: true, summary: `search: ${search.query}`, detail: JSON.stringify(search.results.slice(0, 3), null, 2) });

  if (!Array.isArray(search.results) || !search.results.length) {
    const message = 'I could not answer reliably from local context, and the web search returned no results.';
    onEvent({ type: 'assistant', content: message });
    return { content: message, sources: [] };
  }

  const sources = Array.isArray(search && search.results) ? search.results.slice(0, 3) : [];
  const snippets = [];
  for (let i = 0; i < sources.length; i++) {
    const result = sources[i];
    if (!result || !result.url) continue;
    onEvent({
      type: 'status',
      message: `Reading source ${i + 1}/${sources.length}: ${(result.title || result.url).slice(0, 70)}…`,
    });
    try {
      const page = await execute('fetch_url', { url: result.url });
      // fetch_url returns { url, content } — never String() the object itself.
      const raw = page && typeof page === 'object' ? page.content : page;
      const text = String(raw ?? '').slice(0, 1200).trim();
      snippets.push({
        title: result.title || result.url,
        url: result.url,
        text: text || String(result.snippet || '').trim() || 'No readable text on this page.',
      });
    } catch (err) {
      snippets.push({
        title: result.title || result.url,
        url: result.url,
        text: String(result.snippet || '').trim() ||
          `Could not read page: ${String((err && err.message) || err)}`,
      });
    }
  }

  const citeText = snippets.length
    ? snippets.map((s) => `- ${s.title}: ${s.url}\n  ${s.text}`).join('\n\n')
    : 'No web source could be read successfully.';

  const answer = `I could not answer reliably from local context, so I checked the web.\n\n${citeText}`;
  // Clients (desktop, extension, CLI) only render what they receive as events —
  // without this the web answer was returned to the caller but never shown.
  onEvent({ type: 'assistant', content: answer });
  return { content: answer, sources };
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
    const name = fn.name || (tc && tc.name);
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
  vision = false,
  requestApproval,
  requestBrowser,
  signal,
  onEvent = () => {},
  provider = new OllamaProvider(),
  preApproved = [],
}) {
  const history = ensureSystemMessage(messages);
  const recentCalls = [];
  let browserNudges = 0;
  let stagnantSteps = 0;
  // Tool names already approved for this run (session scope or always-allow).
  const sessionAllowed = new Set(Array.isArray(preApproved) ? preApproved : []);

  // For models without a native thinking stream (e.g. qwen2.5-coder), run a
  // short "think out loud" pass so the user can still see the model's plan.
  if (planFirst) {
    onEvent({ type: 'status', message: 'Planning…' });
    const planHb = startHeartbeat(onEvent, 'Planning');
    try {
      await provider.chatStream({
        model,
        messages: [...history, { role: 'user', content: PLAN_PROMPT }],
        think,
        signal,
        onDelta: (d) => {
          planHb.touch();
          if (d.type === 'thinking') onEvent({ type: 'thinking', content: d.content });
          else if (d.type === 'assistant') onEvent({ type: 'thinking', content: d.content });
        },
      });
    } catch {
      if (signal && signal.aborted) {
        planHb.stop();
        return { content: 'Stopped by the user.', history, stopped: true };
      }
      // planning is best-effort; continue even if it fails
    } finally {
      planHb.stop();
    }
  }

  // No step limit — the run ends when the model answers, the user stops it,
  // or MAX_STAGNANT_STEPS consecutive steps produce no new tool output.
  for (let step = 1; ; step++) {
    if (signal && signal.aborted) {
      return { content: 'Stopped by the user.', history, stopped: true };
    }
    onEvent({ type: 'status', message: step === 1 ? 'Thinking…' : `Step ${step}: continuing…` });

    let res;
    const hb = startHeartbeat(onEvent, step === 1 ? 'Thinking' : `Step ${step}`);
    try {
      res = await provider.chatStream({
        model,
        messages: history,
        tools,
        think,
        signal,
        onDelta: (d) => {
          hb.touch();
          if (d.type === 'thinking') onEvent({ type: 'thinking', content: d.content });
          else if (d.type === 'assistant') onEvent({ type: 'assistant', content: d.content });
        },
      });
    } catch (e) {
      if (signal && signal.aborted) {
        return { content: 'Stopped by the user.', history, stopped: true };
      }
      throw e;
    } finally {
      hb.stop();
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
      const wantsPageEdit = isPageActionRequest(history);
      if (
        browserNudges < MAX_BROWSER_NUDGES &&
        typeof requestBrowser === 'function' &&
        looksLikeManualInstructions(content)
      ) {
        browserNudges++;
        onEvent({ type: 'status', message: 'Asking the model to do it directly in the browser…' });
        history.push({ role: 'user', content: ACT_DIRECTLY_PROMPT });
        continue;
      }
      // An "update the page" request must never fall into web research.
      if (wantsPageEdit && shouldRunWebResearch(content)) {
        if (browserNudges < MAX_BROWSER_NUDGES && typeof requestBrowser === 'function') {
          browserNudges++;
          onEvent({ type: 'status', message: 'Asking the model to review the page and update it directly…' });
          history.push({ role: 'user', content: ACT_DIRECTLY_PROMPT });
          continue;
        }
        if (!content.trim()) {
          content =
            'I need the Chrome extension side panel open to review and update the active tab. Open the extension on that page and ask me again — then I can make the changes directly instead of researching them.';
          const last = history[history.length - 1];
          if (last && last.role === 'assistant') last.content = content;
        }
        return { content, history };
      }
      if (shouldRunWebResearch(content)) {
        const fallback = await runWebResearchFallback(history, onEvent);
        history.push({ role: 'assistant', content: fallback.content });
        return { content: fallback.content, history };
      }
      return { content, history };
    }

    // A step is "progress" when at least one call got past the repeat guard.
    let sawNewOutput = false;
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
      sawNewOutput = true;

      if (DANGEROUS_TOOLS.has(name) && !autoApprove && !sessionAllowed.has(name) && typeof requestApproval === 'function') {
        const decision = await requestApproval(name, args);
        const approved = decision && typeof decision === 'object' ? !!decision.allowed : !!decision;
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
        const scope = decision && typeof decision === 'object' ? decision.scope : 'once';
        if (scope === 'session' || scope === 'always') sessionAllowed.add(name);
      }

      let result;
      let image = null;
      try {
        if (BROWSER_TOOLS.has(name)) {
          if (typeof requestBrowser !== 'function') {
            throw new Error(`Browser tool "${name}" needs the Chrome extension popup to be open.`);
          }
          result = await requestBrowser(name, args);
        } else {
          result = await execute(name, args);
        }
        const parts = splitImage(result);
        result = parts.rest;
        image = parts.image;
        onEvent({ type: 'tool_result', name, ok: true, summary: summarizeResult(result), detail: resultDetail(result) });
      } catch (e) {
        result = { error: String((e && e.message) || e) };
        onEvent({ type: 'tool_result', name, ok: false, error: result.error });
      }
      const toolMessage = { role: 'tool', content: historyResult(result) };
      if (image) {
        if (vision) {
          toolMessage.images = [imageToBase64(image)];
        } else {
          toolMessage.content +=
            '\n(Screenshot captured and shown to the user in the panel. Your model has no vision support — verify with get_page/get_dom text instead.)';
        }
      }
      history.push(toolMessage);
    }

    if (sawNewOutput) {
      stagnantSteps = 0;
    } else {
      stagnantSteps++;
      if (stagnantSteps >= MAX_STAGNANT_STEPS) break;
    }
  }

  // The model stopped making progress without ever producing a final answer.
  // ALWAYS turn the run into a real result: synthesize one (with a strict
  // plain-text retry), and when that still fails, research the question from
  // scratch — then attach a progress summary. There is no dead-end message.
  onEvent({
    type: 'status',
    message: `No new progress after ${MAX_STAGNANT_STEPS} repeated steps — finishing with a researched answer and a summary…`,
  });
  const synthesized = await synthesizeFinalAnswer({ history, provider, model, signal, onEvent });
  if (synthesized) {
    history.push({ role: 'assistant', content: synthesized });
    return { content: synthesized, history };
  }

  let answer = null;
  if (!isPageActionRequest(history)) {
    const fallback = await runWebResearchFallback(history, onEvent);
    answer = (fallback && fallback.content) || null;
  }
  const summary = progressSummary(history, answer ? 'Run details:' : undefined);
  const content = answer ? `${answer}\n\n---\n\n${summary}` : summary;
  history.push({ role: 'assistant', content });
  return { content, history };
}

module.exports = {
  runAgent,
  buildSystemPrompt,
  DANGEROUS_TOOLS,
  MAX_STAGNANT_STEPS,
  convertToolCallObject,
  parseToolCallsFromContent,
  normalizeToolCalls,
  shouldRunWebResearch,
  isPageActionRequest,
  looksLikeManualInstructions,
  splitImage,
  imageToBase64,
};
