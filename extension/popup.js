/* Local Code Agent — popup logic.
 * Streams Server-Sent Events from the local agent server and renders the
 * conversation: user/assistant text plus tool-call chips, with an
 * approve/deny banner for dangerous operations. */

const DEFAULT_SERVER = 'http://127.0.0.1:8787';
const STORE_KEY = 'localCodeAgent';

const trimAll = (s) => (s || '').replace(/^\s+|\s+$/g, '');

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('input');
const sendBtn = $('send');
const stopBtn = $('stopBtn');
const regenBtn = $('regenBtn');
const copyBtn = $('copyBtn');
const genStatusEl = $('genStatus');
const responseTimeEl = $('responseTime');
const statusModelEl = $('statusModel');

const GEN_LABELS = {
  idle: 'Ready',
  working: 'Working…',
  thinking: 'Thinking…',
  tools: 'Running tools…',
  generating: 'Generating…',
  stopped: 'Stopped',
  error: 'Error',
};

let settings = {
  serverUrl: DEFAULT_SERVER,
  model: '',
  autoApprove: false,
  includeTab: true,
  projectRoot: '',
  sessionId: null,
  autoSearchOnSend: false,
  findBestLink: true,
  autoPrompt: true,
  researchMode: 'full',
  searchProvider: 'google',
  contextMode: 'full',
};
let models = [];
let transcript = [];
let lastBlock = null;
let persistTimer = null;
let streaming = false;
let activeController = null;
let runStartedAt = 0;
let runTicker = null;

// ---------------- storage ----------------
async function loadSettings() {
  const [cfg, tr] = await Promise.all([
    chrome.storage.local.get(STORE_KEY),
    chrome.storage.local.get('transcript'),
  ]);
  Object.assign(settings, cfg[STORE_KEY] || {});
  transcript = Array.isArray(tr.transcript) ? tr.transcript : [];
  $('serverUrl').value = settings.serverUrl || DEFAULT_SERVER;
  $('modelSelect').value = settings.model || '';
  $('autoApprove').checked = !!settings.autoApprove;
  $('includeTab').checked = settings.includeTab !== false;
  $('projectRoot').value = settings.projectRoot || '';
  $('autoSearch').checked = !!settings.autoSearchOnSend;
  $('findBestLink').checked = settings.findBestLink !== false;
  $('autoPrompt').checked = settings.autoPrompt !== false;
  $('researchMode').value = settings.researchMode || 'full';
  if ($('searchProvider')) $('searchProvider').value = settings.searchProvider || 'google';
  if ($('contextMode')) $('contextMode').value = settings.contextMode || 'full';
  if (settings.projectRoot) $('projectSummary').textContent = settings.projectRoot;
  if (transcript.length) renderTranscript();
  updateStatusModel();
  updateAutoSummary();
  updateServerSummary();
  updateActionButtons();
  updateContextIndicator();
}

function saveSettings() {
  chrome.storage.local.set({ [STORE_KEY]: settings });
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(
    () => chrome.storage.local.set({ transcript: transcript.slice(-100) }),
    300
  );
}

// ---------------- status strip ----------------
function formatDuration(ms) {
  if (!isFinite(ms) || ms <= 0) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function setGenState(state, label) {
  if (!genStatusEl) return;
  genStatusEl.dataset.state = state;
  genStatusEl.textContent = label || GEN_LABELS[state] || GEN_LABELS.idle;
}

function setResponseTime(ms) {
  if (!responseTimeEl) return;
  responseTimeEl.textContent = formatDuration(ms);
  responseTimeEl.title = ms ? `Last run: ${formatDuration(ms)}` : 'Response time for the last run';
}

function updateStatusModel() {
  if (!statusModelEl) return;
  const model = settings.model || '';
  statusModelEl.textContent = model || 'no model';
  statusModelEl.title = model ? `Model: ${model} — click to change` : 'Pick a model';
  const summary = $('modelSummary');
  if (summary) summary.textContent = model || 'none';
  const sel = $('modelSelect');
  if (sel) sel.title = model ? `Current model: ${model}` : 'Ollama model';
}

function updateAutoSummary() {
  const el = $('autoSummary');
  if (!el) return;
  const on = [settings.autoSearchOnSend, settings.findBestLink, settings.autoPrompt !== false].filter(Boolean).length;
  el.textContent = on ? `${on} feature${on > 1 ? 's' : ''} on` : 'off';
}

function updateServerSummary() {
  const el = $('serverSummary');
  if (!el) return;
  el.textContent = (settings.serverUrl || DEFAULT_SERVER).replace(/^https?:\/\//, '');
}

/** Expand (or collapse) one settings section and scroll it into view. */
function toggleSection(id, open) {
  const section = $(id);
  if (!section) return;
  if (typeof open === 'boolean') section.open = open;
  else section.open = !section.open;
  const settingsBtn = $('settingsBtn');
  if (settingsBtn) {
    settingsBtn.classList.toggle('active', !!$('settingsPanel').open);
    settingsBtn.setAttribute('aria-expanded', String(!!$('settingsPanel').open));
  }
  if (section.open) section.scrollIntoView({ block: 'nearest' });
}

function lastUserText() {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    if (transcript[i].role === 'user') return transcript[i].text;
  }
  return '';
}

function lastAssistantText() {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const item = transcript[i];
    if (item.role === 'assistant' && item.text) return item.text;
  }
  return '';
}

function updateActionButtons() {
  if (stopBtn) stopBtn.disabled = !streaming;
  if (regenBtn) regenBtn.disabled = streaming || !lastUserText();
  if (copyBtn) copyBtn.disabled = !lastAssistantText();
}

function beginRun() {
  streaming = true;
  sendBtn.disabled = true;
  runStartedAt = performance.now();
  setGenState('working');
  setResponseTime(0);
  if (responseTimeEl) responseTimeEl.classList.add('live');
  clearInterval(runTicker);
  runTicker = setInterval(() => {
    if (runStartedAt) setResponseTime(performance.now() - runStartedAt);
  }, 100);
  updateActionButtons();
}

function endRun(state) {
  const ms = runStartedAt ? performance.now() - runStartedAt : 0;
  runStartedAt = 0;
  clearInterval(runTicker);
  runTicker = null;
  streaming = false;
  sendBtn.disabled = false;
  activeController = null;
  if (responseTimeEl) responseTimeEl.classList.remove('live');
  if (ms > 0) setResponseTime(ms);
  setGenState(state || 'idle');
  flushAssistantPaint();
  updateActionButtons();
}

// ---------------- rendering ----------------
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendEl(className) {
  const el = document.createElement('div');
  el.className = className;
  messagesEl.appendChild(el);
  return el;
}

// Assistant text is Markdown. Streaming repaints are coalesced into one
// animation frame so a token-by-token reply does not re-highlight the whole
// bubble on every chunk.
function paintMarkdown(bubble, item, immediate) {
  if (bubble._paintRaf) {
    cancelAnimationFrame(bubble._paintRaf);
    bubble._paintRaf = null;
  }
  const paint = () => {
    bubble._paintRaf = null;
    bubble.innerHTML = renderMarkdown(item.text);
  };
  if (immediate) paint();
  else bubble._paintRaf = requestAnimationFrame(paint);
}

function flushAssistantPaint() {
  if (lastBlock && lastBlock.type === 'assistant' && lastBlock.bubble) {
    paintMarkdown(lastBlock.bubble, lastBlock.item, true);
  }
}

function renderTranscript() {
  messagesEl.innerHTML = '';
  lastBlock = null;
  transcript.forEach(renderItem);
  scrollToBottom();
  updateActionButtons();
}

function renderItem(item) {
  if (item.role === 'user') {
    const wrap = appendEl('msg user');
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = item.text;
    wrap.appendChild(bubble);
    lastBlock = { type: 'user', wrap };
  } else if (item.role === 'assistant') {
    const wrap = appendEl('msg assistant' + (item.interim ? ' interim' : ''));
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    wrap.appendChild(bubble);
    paintMarkdown(bubble, item, true);
    lastBlock = { type: 'assistant', wrap, bubble, item };
  } else if (item.role === 'tool') {
    const block = buildToolEl(item.name, item.args);
    block.item = item;
    if (item.summary != null) {
      setToolResult(block, item.ok, item.summary);
      attachToolDetail(block, item.detail);
    }
  }
}

function buildToolEl(name, args) {
  const el = appendEl('msg tool');
  const header = document.createElement('div');
  header.className = 'tool-header';
  header.textContent = '⚙ ' + name;
  const argsPre = document.createElement('pre');
  argsPre.className = 'tool-args';
  argsPre.textContent = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
  const result = document.createElement('div');
  result.className = 'tool-result';
  result.textContent = 'working…';
  el.append(header, argsPre, result);
  const block = { type: 'tool', el, resultEl: result };
  lastBlock = block;
  return block;
}

function setToolResult(block, ok, summary) {
  block.resultEl.className = 'tool-result ' + (ok ? 'ok' : 'err');
  block.resultEl.textContent = summary || (ok ? 'done' : 'failed');
}

function attachToolDetail(block, detail) {
  if (!detail || !block.resultEl) return;
  block.resultEl.classList.add('toggle');
  const detailEl = document.createElement('div');
  detailEl.className = 'tool-detail hidden';
  detailEl.textContent = detail;
  block.el.appendChild(detailEl);
  block.resultEl.addEventListener('click', () => detailEl.classList.toggle('hidden'));
}

function appendUser(text) {
  transcript.push({ role: 'user', text });
  const wrap = appendEl('msg user');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  lastBlock = { type: 'user', wrap };
  schedulePersist();
  scrollToBottom();
}

function appendAssistant(text, interim) {
  if (!lastBlock || lastBlock.type !== 'assistant') {
    const item = { role: 'assistant', text: '', interim: !!interim };
    transcript.push(item);
    const wrap = appendEl('msg assistant' + (interim ? ' interim' : ''));
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    wrap.appendChild(bubble);
    lastBlock = { type: 'assistant', wrap, bubble, item };
  }
  lastBlock.item.text += text;
  paintMarkdown(lastBlock.bubble, lastBlock.item);
  schedulePersist();
  scrollToBottom();
}

function isPlanningStatus(message) {
  const text = String(message || '');
  return /\b(planning|thinking|reasoning|thoughts?)\b/i.test(text);
}

function appendThinking(text) {
  if (!lastBlock || lastBlock.type !== 'thinking') {
    const el = appendEl('msg thinking');
    const header = document.createElement('div');
    header.className = 'thinking-header';
    const chevron = document.createElement('span');
    chevron.className = 'thinking-chevron';
    chevron.textContent = '▾';
    const label = document.createElement('span');
    label.textContent = '💭 Thinking';
    header.append(chevron, label);
    const body = document.createElement('div');
    body.className = 'thinking-body';
    el.append(header, body);
    header.addEventListener('click', () => el.classList.toggle('collapsed'));
    lastBlock = { type: 'thinking', el, bodyEl: body };
  }

  // Keep the reasoning box visible while a plan/thinking stream is active, even
  // if the user collapsed it earlier. New reasoning should re-expand it.
  if (lastBlock.el.classList.contains('collapsed')) {
    lastBlock.el.classList.remove('collapsed');
  }

  lastBlock.bodyEl.textContent += text;
  lastBlock.bodyEl.scrollTop = lastBlock.bodyEl.scrollHeight;
  scrollToBottom();
}

function appendScreenshot(dataUrl) {
  const el = appendEl('msg screenshot');
  const img = document.createElement('img');
  img.src = dataUrl;
  el.appendChild(img);
  lastBlock = { type: 'screenshot', el };
  scrollToBottom();
}

function appendStatus(text) {
  // The same line can arrive from both the SSE event and the local action
  // (e.g. "Stopped.") — show it once.
  if (lastBlock && lastBlock.type === 'status' && lastBlock.el.textContent === text) {
    scrollToBottom();
    return;
  }
  const el = appendEl('msg status-line');
  el.textContent = text;
  lastBlock = { type: 'status', el };
  scrollToBottom();
}

function appendTool(name, args) {
  const item = { role: 'tool', name, args };
  transcript.push(item);
  const block = buildToolEl(name, args);
  block.item = item;
  lastBlock = block;
  schedulePersist();
  scrollToBottom();
}

function appendToolResult(ok, summary, detail) {
  const block = lastBlock && lastBlock.type === 'tool' ? lastBlock : null;
  if (!block) return;
  if (block.item) {
    block.item.ok = ok;
    block.item.summary = summary;
    if (detail) block.item.detail = detail;
  }
  setToolResult(block, ok, summary);
  attachToolDetail(block, detail);
  schedulePersist();
  scrollToBottom();
}

// ---------------- approval banner ----------------
function showApproval(id, name, args) {
  $('approvalName').textContent = name;
  $('approvalArgs').textContent =
    typeof args === 'string' ? args : JSON.stringify(args, null, 2);
  $('approval').classList.remove('hidden');
  $('approval').dataset.id = id;
}

function hideApproval() {
  $('approval').classList.add('hidden');
  delete $('approval').dataset.id;
}

async function respondApproval(allowed, scope) {
  const id = $('approval').dataset.id;
  if (!id) return;
  hideApproval();
  try {
    await fetch(`${settings.serverUrl || DEFAULT_SERVER}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, allowed, scope }),
    });
  } catch (e) {
    // The server may have gone away; nothing useful to do here.
  }
}

// ---------------- browser tools (run in the active tab) ----------------
// These functions are serialized by chrome.scripting and run in the page
// context, so they must be self-contained (no closure over popup state).
async function pageGetPage(args) {
  const a = args || {};
  const mode = a.mode === 'selection' || a.mode === 'visible' ? a.mode : 'full';
  const maxChars = a.max_chars || (mode === 'selection' ? 2000 : 8000);
  const maxScrolls = mode === 'full' ? (a.max_scrolls || 20) : 0;

  // Runs inside the page (chrome.scripting serializes this function alone), so
  // the redaction helper must live here. Obvious secrets never leave the tab.
  function redactSecrets(text) {
    if (!text) return text;
    return String(text)
      .replace(/\b(?:sk|pk|rk|api)[-_][A-Za-z0-9_-]{16,}/g, '[redacted-key]')
      .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[redacted-key]')
      .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted-key]')
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]')
      .replace(
        /\b(password|passwd|pwd|secret|token|api[_ ]?key|auth(?:orization)?)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
        '$1: [redacted]'
      );
  }

  if (mode === 'selection') {
    const raw = String((window.getSelection && String(window.getSelection())) || '').trim();
    const text = redactSecrets(raw).slice(0, maxChars);
    return {
      url: location.href,
      title: document.title,
      mode,
      text,
      empty: !raw,
      truncated: raw.length > maxChars,
      ...(raw ? {} : { hint: 'Nothing is selected on the page — ask the user to select the text first, or switch the context mode to Visible/Full page.' }),
    };
  }

  const collect = (parts, seen, total) => {
    const text = (document.body && document.body.innerText) || '';
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      parts.push(t);
      total += t.length;
      if (total >= maxChars) return false;
    }
    return true;
  };

  const seen = new Set();
  const parts = [];
  let total = 0;
  const startY = window.scrollY;
  let scrolls = 0;

  if (mode === 'visible') {
    // No scrolling: capture the page as currently rendered, then put the
    // scroll position back exactly where the user left it.
    collect(parts, seen, total);
    window.scrollTo(0, startY);
  } else {
    let keepGoing = collect(parts, seen, total);
    while (keepGoing && scrolls < maxScrolls) {
      const before = window.scrollY;
      window.scrollBy({ top: Math.round(window.innerHeight * 0.85) });
      scrolls++;
      await new Promise((r) => setTimeout(r, 120));
      if (window.scrollY <= before) break;
      keepGoing = collect(parts, seen, total);
    }
    window.scrollTo(0, startY);
  }

  const joined = parts.join('\n');
  const redacted = redactSecrets(joined);
  return {
    url: location.href,
    title: document.title,
    mode,
    text: redacted.slice(0, maxChars),
    truncated: joined.length > maxChars,
    scrolled: scrolls,
    redacted: redacted !== joined,
  };
}

function pageGetDom(args) {
  const selector = args && args.selector;
  const maxItems = (args && args.max_items) || 100;
  // Field values are omitted by default (they can contain passwords, tokens,
  // card numbers). The model opts in with include_values: true.
  const includeValues = !!(args && args.include_values);
  function redactValue(v) {
    return String(v)
      .replace(/\b(?:sk|pk|rk|api)[-_][A-Za-z0-9_-]{16,}/g, '[redacted-key]')
      .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted-key]')
      .slice(0, 60);
  }
  const nodes = selector
    ? document.querySelectorAll(selector)
    : document.querySelectorAll(
        'a, button, input, textarea, select, [role="button"], [onclick], h1, h2, h3, h4, p, li, td, img, [contenteditable="true"]'
      );
  const rt = window.__agentRuntime;
  for (const old of document.querySelectorAll('[data-agent-idx]')) old.removeAttribute('data-agent-idx');
  const elements = [];
  for (const el of Array.from(nodes)) {
    if (elements.length >= maxItems) break;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const index = elements.length + 1;
    el.setAttribute('data-agent-idx', String(index));
    const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const isPassword = (el.type || '').toLowerCase() === 'password';
    const entry = {
      index,
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      className: typeof el.className === 'string' ? el.className.slice(0, 80) : undefined,
      text,
      type: el.type || undefined,
      name: el.name || undefined,
      placeholder: el.placeholder || undefined,
      href: el.href || undefined,
      value:
        includeValues && !isPassword && el.value !== undefined && el.value !== ''
          ? redactValue(el.value)
          : undefined,
      editable: el.isContentEditable || undefined,
      selector: rt ? rt.path(el) : undefined,
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
    };
    elements.push(entry);
  }
  return {
    url: location.href,
    title: document.title,
    count: elements.length,
    elements,
    hint: includeValues
      ? 'Each element has a stable index — pass it as "index" to click/type/edit_element/delete_element. Field values were redacted where they looked sensitive.'
      : 'Each element has a stable index — pass it as "index" to click/type/edit_element/delete_element. Field values are hidden by default — re-run with include_values: true to see them.',
  };
}

function ensureAgentRuntime() {
  // Rebuild when an older injected runtime (without the newer helpers) is
  // still cached on the page — the runtime is stateless, so this is safe.
  if (
    window.__agentRuntime &&
    typeof window.__agentRuntime.toast === 'function' &&
    typeof window.__agentRuntime.key === 'function'
  ) {
    return true;
  }
  try {
    delete window.__agentRuntime;
  } catch (e) {
    window.__agentRuntime = undefined;
  }
  const svg =
    '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2 L20 12 L12 13 L9 21 Z" fill="#1f1f1f" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const rectOf = (t) =>
    t && t.getBoundingClientRect ? t.getBoundingClientRect() : t || { left: 0, top: 0, width: 0, height: 0 };
  window.__agentRuntime = {
    wait(ms) {
      return new Promise((r) => setTimeout(r, ms));
    },
    aim(target) {
      try {
        const p = document.createElement('div');
        p.style.cssText =
          'position:fixed;left:0;top:0;z-index:2147483648;pointer-events:none;transition:transform .55s cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 2px 5px rgba(0,0,0,.45));';
        p.innerHTML = svg;
        document.body.appendChild(p);
        p.style.transform = 'translate(' + (window.innerWidth - 70) + 'px,' + (window.innerHeight - 70) + 'px)';
        const r = rectOf(target);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            p.style.transform =
              'translate(' + (r.left + Math.max(4, r.width / 2)) + 'px,' + (r.top + Math.max(4, r.height / 2)) + 'px)';
          })
        );
        setTimeout(() => p.remove(), 2600);
      } catch (e) { /* pointer is best-effort */ }
    },
    highlight(el, color, ms) {
      try {
        const box = document.createElement('div');
        box.style.cssText =
          'position:fixed;z-index:2147483647;pointer-events:none;border:3px solid ' +
          (color || '#d97757') +
          ';border-radius:4px;box-shadow:0 0 0 2px rgba(217,119,87,.3),0 0 14px rgba(217,119,87,.6);transition:all .12s ease;';
        const place = () => {
          const r = rectOf(el);
          box.style.left = r.left + 'px';
          box.style.top = r.top + 'px';
          box.style.width = r.width + 'px';
          box.style.height = r.height + 'px';
        };
        place();
        document.body.appendChild(box);
        const onScroll = () => place();
        window.addEventListener('scroll', onScroll, { passive: true });
        setTimeout(() => {
          box.remove();
          window.removeEventListener('scroll', onScroll);
        }, ms || 2200);
      } catch (e) { /* highlight is best-effort */ }
    },
    toast(msg, ms) {
      try {
        const old = document.querySelector('[data-agent-toast]');
        if (old && old.remove) old.remove();
        const t = document.createElement('div');
        t.setAttribute('data-agent-toast', '1');
        t.textContent = msg;
        t.style.cssText =
          'position:fixed;top:14px;left:50%;transform:translate(-50%,-8px);z-index:2147483649;' +
          'max-width:70vw;padding:8px 14px;border-radius:999px;background:#1f1f1f;color:#fff;' +
          'font:600 13px/1.4 system-ui,-apple-system,sans-serif;letter-spacing:.2px;' +
          'box-shadow:0 4px 16px rgba(0,0,0,.45);border:1px solid #d97757;opacity:0;' +
          'transition:opacity .18s ease,transform .18s ease;pointer-events:none;white-space:nowrap;' +
          'overflow:hidden;text-overflow:ellipsis;';
        document.body.appendChild(t);
        requestAnimationFrame(() => {
          t.style.opacity = '1';
          t.style.transform = 'translate(-50%,0)';
        });
        setTimeout(() => {
          t.style.opacity = '0';
          t.style.transform = 'translate(-50%,-8px)';
          setTimeout(() => {
            try { t.remove(); } catch (e) { /* already gone */ }
          }, 220);
        }, ms || 2400);
      } catch (e) { /* toast is best-effort */ }
    },
    mouse(el, opts) {
      const o = opts || {};
      try {
        if (el.focus) el.focus();
      } catch (e) { /* focus is best-effort */ }
      try {
        const r = rectOf(el);
        const isRight = o.button === 'right';
        const base = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
          button: isRight ? 2 : 0,
          detail: o.double ? 2 : 1,
        };
        const buttons = isRight ? 2 : 1;
        const downUp = () => {
          el.dispatchEvent(
            new PointerEvent('pointerdown', Object.assign({}, base, { buttons: buttons, pointerId: 1, isPrimary: true, pointerType: 'mouse' }))
          );
          el.dispatchEvent(new MouseEvent('mousedown', Object.assign({}, base, { buttons: buttons })));
          el.dispatchEvent(
            new PointerEvent('pointerup', Object.assign({}, base, { buttons: 0, pointerId: 1, isPrimary: true, pointerType: 'mouse' }))
          );
          el.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, base, { buttons: 0 })));
        };
        if (o.double) {
          downUp();
          el.dispatchEvent(new MouseEvent('click', Object.assign({}, base, { detail: 1 })));
          downUp();
          el.dispatchEvent(new MouseEvent('click', Object.assign({}, base, { detail: 2 })));
          el.dispatchEvent(new MouseEvent('dblclick', base));
          return { clicked: true, double: true, clientX: Math.round(base.clientX), clientY: Math.round(base.clientY) };
        }
        if (isRight) {
          downUp();
          el.dispatchEvent(new MouseEvent('contextmenu', base));
          return { clicked: true, button: 'right', clientX: Math.round(base.clientX), clientY: Math.round(base.clientY) };
        }
        downUp();
        el.dispatchEvent(new MouseEvent('click', Object.assign({}, base, { buttons: 0 })));
        return { clicked: true, clientX: Math.round(base.clientX), clientY: Math.round(base.clientY) };
      } catch (e) {
        try {
          el.click();
        } catch (e2) { /* ignore */ }
        return { clicked: true };
      }
    },
    /** Press keyboard keys/shortcuts ("Enter", "Ctrl+A", "Ctrl+Shift+P"). */
    key(el, keys) {
      const CODES = {
        backspace: 8, tab: 9, enter: 13, shift: 16, control: 17, alt: 18, escape: 27,
        esc: 27, space: 32, ' ': 32, pageup: 33, pagedown: 34, end: 35, home: 36,
        arrowleft: 37, arrowup: 38, arrowright: 39, arrowdown: 40, insert: 45, delete: 46,
        meta: 91, cmd: 91, command: 91, f1: 112, f2: 113, f3: 114, f4: 115, f5: 116,
        f6: 117, f7: 118, f8: 119, f9: 120, f10: 121, f11: 122, f12: 123,
        '+': 187, '-': 189, '=': 187, ',': 188, '.': 190, '/': 191, ';': 186, "'": 222,
      };
      try {
        if (el && el.focus) el.focus();
      } catch (e) { /* focus is best-effort */ }
      const tokens = String(keys || '').trim().split(/[\s,]+/).filter(Boolean);
      const pressed = [];
      let submitted = false;
      for (const token of tokens) {
        const parts = token.split('+');
        let key = parts[parts.length - 1];
        const mods = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
        for (let i = 0; i < parts.length - 1; i++) {
          const m = parts[i].toLowerCase();
          if (m === 'ctrl' || m === 'control') mods.ctrlKey = true;
          else if (m === 'alt' || m === 'option') mods.altKey = true;
          else if (m === 'shift') mods.shiftKey = true;
          else if (m === 'meta' || m === 'cmd' || m === 'command') mods.metaKey = true;
        }
        const lower = key.toLowerCase();
        if (lower === 'space') key = ' ';
        const keyCode =
          CODES[lower] != null
            ? CODES[lower]
            : key.length === 1
              ? key.toUpperCase().charCodeAt(0)
              : 0;
        const init = Object.assign(
          {
            key: key,
            code: key === ' ' ? 'Space' : key.length === 1 ? 'Key' + key.toUpperCase() : key,
            keyCode: keyCode,
            which: keyCode,
            bubbles: true,
            cancelable: true,
          },
          mods
        );
        const downOk = el.dispatchEvent(new KeyboardEvent('keydown', init));
        let pressOk = true;
        if (lower === 'enter' || lower === 'space' || (key.length === 1 && !mods.ctrlKey && !mods.metaKey)) {
          pressOk = el.dispatchEvent(new KeyboardEvent('keypress', init));
        }
        el.dispatchEvent(new KeyboardEvent('keyup', init));
        pressed.push(token);
        // Enter in a real form field: submit when the page did not handle it.
        if (lower === 'enter' && downOk && pressOk && !submitted) {
          const target = el;
          submitted = true;
          setTimeout(function () {
            try {
              if (target.isConnected && target.form && typeof target.form.requestSubmit === 'function') {
                target.form.requestSubmit();
              }
            } catch (e) { /* page already handled it */ }
          }, 150);
        }
      }
      return { pressed: pressed, submitted: submitted || undefined };
    },
    type(el, value) {
      const text = String(value);
      const isSelect = typeof HTMLSelectElement !== 'undefined' && el instanceof HTMLSelectElement;
      if (isSelect) {
        el.value = text;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { typed: text.length, select: true };
      }
      try {
        el.focus();
      } catch (e) { /* focus is best-effort */ }
      if (el.isContentEditable) {
        try {
          document.execCommand('selectAll', false, null);
        } catch (e) { /* selection is best-effort */ }
        if (text.length > 1500) {
          el.textContent = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return { typed: text.length, bulk: true, contentEditable: true };
        }
        let ok = true;
        try {
          for (const ch of Array.from(text)) {
            if (!document.execCommand('insertText', false, ch)) {
              ok = false;
              break;
            }
          }
        } catch (e) {
          ok = false;
        }
        if (ok) return { typed: text.length, contentEditable: true };
        el.textContent = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { typed: text.length, contentEditable: true, fallback: true };
      }
      const proto =
        typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      if (text.length > 1500) {
        setter.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { typed: text.length, bulk: true };
      }
      setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      let built = '';
      for (const ch of Array.from(text)) {
        built += ch;
        const key = ch === '\n' ? 'Enter' : ch;
        try {
          el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key, bubbles: true, cancelable: true }));
        } catch (e) { /* older engines */ }
        setter.call(el, built);
        try {
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
        } catch (e) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        try {
          el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
        } catch (e) { /* older engines */ }
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { typed: text.length };
    },
    byIndex(i) {
      if (i == null || i === '') return null;
      return document.querySelector('[data-agent-idx="' + Number(i) + '"]');
    },
    byMatch(needle, opts) {
      const n = String(needle || '').toLowerCase().trim();
      if (!n) return null;
      const o = opts || {};
      if (!o.any) {
        const interactive = document.querySelectorAll(
          'a, button, [role="button"], input[type="submit"], input[type="button"], label, summary, [onclick], [tabindex]'
        );
        for (const e of interactive) {
          const t = ((e.innerText || e.textContent || e.value) || '').trim().toLowerCase();
          if (t && t.includes(n)) return e;
        }
      }
      let best = null;
      let bestLen = Infinity;
      for (const e of document.querySelectorAll('body *')) {
        const rect = e.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const t = ((e.innerText || e.textContent) || '').trim();
        if (!t || t.length > 300) continue;
        if (t.toLowerCase().includes(n) && t.length < bestLen) {
          best = e;
          bestLen = t.length;
        }
      }
      return best;
    },
    path(el) {
      if (!el || el.nodeType !== 1) return '';
      const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
      if (el.id) return '#' + esc(el.id);
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && node !== document.body && parts.length < 6) {
        if (node.id) {
          parts.unshift('#' + esc(node.id));
          break;
        }
        let seg = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
          if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
        }
        parts.unshift(seg);
        node = parent;
      }
      return parts.join(' > ');
    },
  };
  return true;
}

function pageClick(args) {
  const a = args || {};
  const rt = window.__agentRuntime;
  if (!rt) throw new Error('Agent runtime not loaded — reload the extension at chrome://extensions.');
  let el = rt.byIndex(a.index);
  if (a.index != null && a.index !== '' && !el) {
    throw new Error('Element #' + a.index + ' is stale — call get_dom again to refresh element numbers.');
  }
  if (!el && a.selector) el = document.querySelector(a.selector);
  if (!el && a.text) el = rt.byMatch(a.text);
  if (!el) throw new Error('No element matched: ' + JSON.stringify(a));
  const button = a.button === 'double' || a.button === 'right' ? a.button : 'left';
  el.scrollIntoView({ block: 'center', behavior: 'auto' });
  rt.aim(el);
  return rt.wait(550).then(() => {
    rt.highlight(el, '#d97757', 1800);
    const res = rt.mouse(el, { button: button === 'double' ? 'left' : button, double: button === 'double' });
    const out = {
      clicked: true,
      button: button,
      tag: el.tagName.toLowerCase(),
      text: ((el.innerText || el.textContent) || '').trim().slice(0, 120),
    };
    const verb = button === 'double' ? 'double-clicked' : button === 'right' ? 'right-clicked' : 'clicked';
    rt.toast('Agent ' + verb + ' ' + (out.text ? '“' + out.text.slice(0, 40) + '”' : '<' + out.tag + '>'));
    if (res && res.clientX != null) out.at = { x: res.clientX, y: res.clientY };
    if (a.index != null && a.index !== '') out.index = Number(a.index);
    return out;
  });
}

function pageType(args) {
  const a = args || {};
  const rt = window.__agentRuntime;
  if (!rt) throw new Error('Agent runtime not loaded — reload the extension at chrome://extensions.');
  let el = rt.byIndex(a.index);
  if (a.index != null && a.index !== '' && !el) {
    throw new Error('Element #' + a.index + ' is stale — call get_dom again to refresh element numbers.');
  }
  if (!el && a.selector) el = document.querySelector(a.selector);
  if (!el && !a.selector && !a.index) {
    const needle = String(a.text || '').toLowerCase();
    const fields = document.querySelectorAll('input, textarea, select, [contenteditable="true"]');
    for (const f of fields) {
      const p = (f.placeholder || '').toLowerCase();
      const n = (f.name || '').toLowerCase();
      const lbl = (f.getAttribute('aria-label') || '').toLowerCase();
      if (needle && (p.includes(needle) || n.includes(needle) || lbl.includes(needle))) { el = f; break; }
    }
  }
  if (!el) throw new Error('No input matched: ' + JSON.stringify(a));
  el.scrollIntoView({ block: 'center', behavior: 'auto' });
  rt.aim(el);
  return rt.wait(550).then(() => {
    rt.highlight(el, '#d97757', 2400);
    const r = rt.type(el, a.value);
    const out = {
      typed: true,
      into: a.selector || a.text || (a.index != null && a.index !== '' ? '#' + a.index : ''),
      value: String(a.value),
      chars: r && r.typed,
    };
    if (a.press_enter === true || a.press_enter === 'true') {
      const k = rt.key(el, 'Enter');
      out.enter = k && k.pressed;
    }
    rt.toast('Agent typed into ' + (a.selector || a.text || el.name || el.id || 'the field'));
    return out;
  });
}

/** Press keyboard keys/shortcuts on an element (or the focused element). */
function pageKey(args) {
  const a = args || {};
  const rt = window.__agentRuntime;
  if (!rt) throw new Error('Agent runtime not loaded — reload the extension at chrome://extensions.');
  let el = rt.byIndex(a.index);
  if (a.index != null && a.index !== '' && !el) {
    throw new Error('Element #' + a.index + ' is stale — call get_dom again to refresh element numbers.');
  }
  if (!el && a.selector) el = document.querySelector(a.selector);
  if (!el && a.text) el = rt.byMatch(a.text);
  if (!el) el = document.activeElement || document.body;
  const keys = String(a.keys != null ? a.keys : a.key != null ? a.key : '').trim();
  if (!keys) throw new Error('key requires keys, e.g. keys: "Enter", "Ctrl+A", or "Escape".');
  el.scrollIntoView ? el.scrollIntoView({ block: 'center', behavior: 'auto' }) : null;
  rt.aim(el);
  return rt.wait(350).then(() => {
    const res = rt.key(el, keys);
    rt.highlight(el, '#d97757', 1400);
    rt.toast('Agent pressed ' + keys);
    return {
      pressed: res.pressed,
      submitted: res.submitted,
      target: el.tagName ? el.tagName.toLowerCase() : 'page',
      selector: rt.path ? rt.path(el) : '',
    };
  });
}

function pageScroll(args) {
  const sel = args && args.selector;
  if (sel) {
    const el = document.querySelector(sel);
    if (!el) throw new Error('No element matched: ' + sel);
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return { scrolledTo: sel };
  }
  const dir = (args && args.direction) || 'down';
  const amount = (args && args.amount) || Math.round(window.innerHeight * 0.8);
  const before = window.scrollY;
  window.scrollBy({ top: dir === 'up' ? -amount : amount, behavior: 'smooth' });
  return { direction: dir, amount, scrollYBefore: before };
}

function pageGetLinks() {
  const nodes = document.querySelectorAll('a[href]');
  const links = [];
  for (const el of Array.from(nodes)) {
    const href = el.getAttribute('href') || '';
    const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (text) {
      links.push({
        tag: el.tagName.toLowerCase(),
        href,
        text,
      });
    }
  }
  return { url: location.href, count: links.length, links };
}

function highlightElement(el, color = 'rgba(40,167,67,.4)') {
  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;z-index:2147483647;pointer-events:none;border:3px solid #28a745;border-radius:4px;box-shadow:0 0 0 2px rgba(40,167,67,.4),0 0 14px rgba(40,167,67,.7);transition:all .12s ease;';
  const place = () => {
    const r = el.getBoundingClientRect();
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
  };
  place();
  document.body.appendChild(box);
  const onScroll = () => place();
  window.addEventListener('scroll', onScroll, { passive: true });
  setTimeout(() => { box.remove(); window.removeEventListener('scroll', onScroll); }, 2000);
  return box;
}

function pageGetLinksWithIds() {
  const nodes = document.querySelectorAll('a[href], button[onclick], input[type="submit"], input[type="button"]');
  const elements = [];
  for (const el of Array.from(nodes)) {
    const href = el.getAttribute('href') || '';
    const onclick = el.getAttribute('onclick') || '';
    const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (text || href) {
      elements.push({
        id: el.id || '',
        tag: el.tagName.toLowerCase(),
        href,
        onclick,
        text,
        type: el.type || undefined,
      });
    }
  }
  return { url: location.href, count: elements.length, elements };
}

/**
 * find_best_link — search the web, RANK the results for the query, and verify
 * each candidate is reachable. Runs in the extension page (not the tab), so
 * cross-origin fetches are allowed by host_permissions.
 */
async function findBestLink(args) {
  const query = String((args && args.query) || '').trim();
  if (!query) throw new Error('find_best_link requires a "query".');
  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
  const verify = args.verify !== false;
  const engine = searchEngineFor(settings.searchProvider);

  const html = await (async () => {
    const res = await fetch(engine.url(query), { headers: { 'Accept': 'text/html' } });
    if (!res.ok) throw new Error(`Search failed (${res.status} ${engine.label}).`);
    return res.text();
  })();

  const parsed = parseSearchResults(html, engine);
  if (!parsed.length) {
    throw new Error(`No results parsed from ${engine.label} for "${query}". Try web_search instead.`);
  }

  // --- ranking: score = title hits + snippet hits + source authority + rank ---
  const terms = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const AUTHORITATIVE = /(^|\.)(github\.com|wikipedia\.org|stackoverflow\.com|docs\.|developer\.|learn\.|en\.wikipedia)/i;
  const DOCSY = /(docs|documentation|guide|reference|api|tutorial|blog)/i;
  const SEARCH_INTERNAL = /(^|\.)(google|bing|duckduckgo)\.[a-z.]+$/i;

  const scored = parsed.map((r, i) => {
    let score = 0;
    const reasons = [];
    const title = (r.title || '').toLowerCase();
    const desc = (r.description || '').toLowerCase();
    const titleHits = terms.filter((t) => title.includes(t)).length;
    const descHits = terms.filter((t) => desc.includes(t)).length;
    if (titleHits) {
      score += titleHits * 2;
      reasons.push(`matches "${query}" in the title`);
    }
    if (descHits) {
      score += descHits;
      reasons.push('mentions the topic in its snippet');
    }
    let host = '';
    try { host = new URL(r.href).hostname; } catch {}
    if (host && SEARCH_INTERNAL.test(host)) score -= 3;
    if (host && AUTHORITATIVE.test(host)) {
      score += 1.5;
      reasons.push(`authoritative source (${host})`);
    }
    if (host && DOCSY.test(r.href)) score += 0.5;
    score += Math.max(0, 4 - i) * 0.5; // top search ranks carry weight
    if (i === 0 && !(titleHits || descHits)) reasons.push('top result from ' + engine.label);
    if (!reasons.length) reasons.push(`ranked #${i + 1} by ${engine.label}`);
    return { ...r, rank: i + 1, host, rawScore: score, reasons };
  });

  let candidates = scored.filter((r) => /^https?:\/\//i.test(r.href) && r.rawScore > 0);
  if (!candidates.length) candidates = scored.filter((r) => /^https?:\/\//i.test(r.href)).slice(0, limit);
  candidates.sort((a, b) => b.rawScore - a.rawScore);
  candidates = candidates.slice(0, limit);

  const maxScore = Math.max(...candidates.map((c) => c.rawScore), 1);

  // --- verification: does the URL actually respond? ---
  const results = await Promise.all(
    candidates.map(async (r) => {
      let reachable = null;
      let verification = 'skipped';
      if (verify) {
        try {
          let res = await fetch(r.href, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(4000) });
          if (!res.ok && (res.status === 405 || res.status === 501)) {
            res = await fetch(r.href, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(4000) });
          }
          reachable = res.ok || res.status < 400;
          verification = reachable ? `responded (HTTP ${res.status})` : `unreachable (HTTP ${res.status})`;
        } catch (e) {
          reachable = false;
          verification = 'unreachable (' + ((e && e.name) || 'error') + ')';
        }
      }
      return {
        rank: r.rank,
        title: r.title,
        href: r.href,
        description: r.description,
        reason: r.reasons.join('; '),
        relevance: Math.round((r.rawScore / maxScore) * 100) / 100,
        reachable,
        verification,
      };
    })
  );

  results.sort((a, b) => {
    // A dead link never outranks a live one at similar relevance.
    const av = a.reachable === false ? 1 : 0;
    const bv = b.reachable === false ? 1 : 0;
    if (av !== bv) return av - bv;
    return b.relevance - a.relevance;
  });
  results.forEach((r, i) => { r.rank = i + 1; });

  const best = results.find((r) => r.reachable !== false) || results[0];
  return {
    query,
    provider: settings.searchProvider || 'google',
    source: engine.label,
    count: results.length,
    best: best ? best.href : null,
    results,
    hint: 'Results are ranked by relevance (0–1) with a reason per link; fetch_url the best one to read it.',
  };
}

/** Pull organic results out of a search-engine HTML page (best-effort). */
function parseSearchResults(html, engine) {
  const out = [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const push = (a) => {
    const href = a.getAttribute('href') || '';
    const title = (a.textContent || '').trim().replace(/\s+/g, ' ');
    if (!/^https?:\/\//i.test(href)) return;
    if (/duckduckgo\.com\/y\.js|google\.com\/url|bing\.com\/ck/i.test(href)) return;
    if (out.some((r) => r.href === href)) return;
    const container = a.closest('div, article, li, tr');
    const descEl = container ? container.querySelector('span, p, .result__snippet, .b_caption p') : null;
    out.push({
      href,
      title: title.slice(0, 200),
      description: (descEl ? descEl.textContent || '' : '').trim().replace(/\s+/g, ' ').slice(0, 300),
    });
  };
  if (engine.host.includes('google')) {
    doc.querySelectorAll('a[href^="http"]').forEach((a) => {
      if (a.querySelector('h3')) push(a); // organic results wrap the title in <h3>
    });
    if (!out.length) doc.querySelectorAll('div.g a[href^="http"]').forEach(push);
  } else if (engine.host.includes('bing')) {
    doc.querySelectorAll('li.b_algo h2 a[href^="http"]').forEach(push);
    if (!out.length) doc.querySelectorAll('h2 a[href^="http"]').forEach(push);
  } else {
    doc.querySelectorAll('a.result__a[href^="http"], a[href^="http"][data-testid="result-title-a"]').forEach(push);
    if (!out.length) doc.querySelectorAll('a[href^="http"]').forEach(push);
  }
  return out.slice(0, 10);
}

function pageTypeWithSelection(args) {
  const text = String((args && args.text) || '').trim();
  const selector = args && args.selector;
  let el = null;
  if (selector) {
    el = document.querySelector(selector);
  } else {
    const needle = text.toLowerCase();
    const fields = document.querySelectorAll('input, textarea, select');
    for (const f of fields) {
      const p = (f.placeholder || '').toLowerCase();
      const n = (f.name || '').toLowerCase();
      const a = (f.getAttribute('aria-label') || '').toLowerCase();
      if (needle && (p.includes(needle) || n.includes(needle) || a.includes(needle))) {
        el = f;
        break;
      }
    }
  }
  if (!el) throw new Error('No input matched: ' + JSON.stringify(args));
  el.focus();
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  try {
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;border:3px solid #6c757d;border-radius:4px;box-shadow:0 0 0 2px rgba(108,117,125,.35),0 0 14px rgba(108,117,125,.7);transition:all .12s ease;';
    const place = () => {
      const r = el.getBoundingClientRect();
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
    };
    place();
    document.body.appendChild(box);
    const onScroll = () => place();
    window.addEventListener('scroll', onScroll, { passive: true });
    setTimeout(() => { box.remove(); window.removeEventListener('scroll', onScroll); }, 1500);
  } catch (e) { /* highlight is best-effort */ }
  if (el instanceof HTMLSelectElement) {
    el.value = text;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { typed: true, into: selector || 'search', value: text };
  }
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { typed: true, into: selector || 'search', value: text };
}

function pageScrollSmooth(args) {
  const dir = (args && args.direction) || 'down';
  const amount = (args && args.amount) || Math.round(window.innerHeight * 0.8);
  const before = window.scrollY;
  window.scrollBy({ top: dir === 'up' ? -amount : amount, behavior: 'smooth' });
  return { direction: dir, amount, scrollYBefore: before };
}

function pageSearchOnPage(args) {
  const q = String((args && args.query) || '').trim();
  if (!q) throw new Error('search_on_page requires a query.');
  const field =
    document.querySelector('textarea[name="q"]') ||
    document.querySelector('input[name="q"]') ||
    document.querySelector('textarea[aria-label="Search"]') ||
    document.querySelector('input[aria-label="Search"]');
  if (!field) throw new Error('No search field found on this page.');
  const startHref = location.href;
  field.focus();
  field.scrollIntoView({ block: 'center', behavior: 'smooth' });
  try {
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;border:3px solid #d97757;border-radius:4px;box-shadow:0 0 0 2px rgba(217,119,87,.35),0 0 14px rgba(217,119,87,.7);transition:all .12s ease;';
    const place = () => {
      const r = field.getBoundingClientRect();
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
    };
    place();
    document.body.appendChild(box);
    const onScroll = () => place();
    window.addEventListener('scroll', onScroll, { passive: true });
    setTimeout(() => {
      box.remove();
      window.removeEventListener('scroll', onScroll);
    }, 4000);
  } catch (e) { /* highlight is best-effort */ }
  try {
    const pointer = document.createElement('div');
    pointer.style.cssText =
      'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transition:transform .7s cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 2px 5px rgba(0,0,0,.45));';
    pointer.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2 L20 12 L12 13 L9 21 Z" fill="#1f1f1f" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(pointer);
    pointer.style.transform = `translate(${window.innerWidth - 70}px, ${window.innerHeight - 70}px)`;
    const target = field.getBoundingClientRect();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        pointer.style.transform = `translate(${target.left + 10}px, ${target.top + target.height / 2}px)`;
      })
    );
    setTimeout(() => pointer.remove(), 3500);
  } catch (e) { /* pointer is best-effort */ }
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  const setValue = (v) => {
    setter.call(field, v);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };
  return (async () => {
    const inc = Math.max(1, Math.ceil(q.length / 24));
    for (let i = inc; i < q.length; i += inc) {
      setValue(q.slice(0, i));
      await new Promise((r) => setTimeout(r, 45));
    }
    setValue(q);
    field.dispatchEvent(new Event('change', { bubbles: true }));
    ['keydown', 'keypress', 'keyup'].forEach((type) => {
      field.dispatchEvent(
        new KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    setTimeout(() => {
      if (location.href !== startHref) return;
      try {
        if (field.form && typeof field.form.requestSubmit === 'function') field.form.requestSubmit();
      } catch (e) { /* ignore */ }
    }, 800);
    return { submitted: true, query: q };
  })();
}

function pageEditElement(args) {
  const a = args || {};
  const rt = window.__agentRuntime;
  if (!rt) throw new Error('Agent runtime not loaded — reload the extension at chrome://extensions.');
  let el = rt.byIndex(a.index);
  if (a.index != null && a.index !== '' && !el) {
    throw new Error('Element #' + a.index + ' is stale — call get_dom again to refresh element numbers.');
  }
  if (!el && a.selector) el = document.querySelector(a.selector);
  if (!el && a.match) el = rt.byMatch(a.match, { any: true });
  if (!el) throw new Error('edit_element: no element matched ' + JSON.stringify({ index: a.index, selector: a.selector, match: a.match }));
  const isField =
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
  let mode;
  if (a.value !== undefined && isField) mode = 'value';
  else if (a.text !== undefined) mode = isField ? 'value' : 'text';
  else if (a.html !== undefined && !isField) mode = 'html';
  else if (a.value !== undefined) mode = 'text';
  else if (a.html !== undefined) mode = 'html';
  else if (a.attribute !== undefined) mode = 'attribute';
  else throw new Error('edit_element requires one of: text, html, value, or attribute.');
  const before = ((el.innerText || el.textContent || el.value) || '').trim().slice(0, 200);
  el.scrollIntoView({ block: 'center', behavior: 'auto' });
  rt.aim(el);
  return rt.wait(550).then(() => {
    if (mode === 'value') {
      rt.type(el, a.value !== undefined ? a.value : a.text);
    } else if (mode === 'text') {
      el.textContent = String(a.text !== undefined ? a.text : a.value);
    } else if (mode === 'html') {
      el.innerHTML = String(a.html);
    } else {
      el.setAttribute(String(a.attribute), String(a.attribute_value !== undefined ? a.attribute_value : ''));
    }
    rt.highlight(el, '#d97757', 2400);
    const after = ((el.innerText || el.textContent || el.value) || '').trim().slice(0, 200);
    rt.toast('Agent updated this element live');
    return {
      updated: true,
      mode,
      tag: el.tagName.toLowerCase(),
      before,
      after,
      index: a.index != null && a.index !== '' ? Number(a.index) : undefined,
      attribute: mode === 'attribute' ? String(a.attribute) : undefined,
    };
  });
}

function pageAddElement(args) {
  const a = args || {};
  let html = a.html !== undefined ? String(a.html) : '';
  if (html === '' && a.text !== undefined) {
    html = String(a.text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  if (!html.trim()) throw new Error('add_element requires html or text.');
  const position = ['append', 'prepend', 'before', 'after'].includes(a.position) ? a.position : 'append';
  const rt = window.__agentRuntime;
  let anchor = rt ? rt.byIndex(a.index) : null;
  if (a.index != null && a.index !== '' && !anchor) {
    throw new Error('Element #' + a.index + ' is stale — call get_dom again to refresh element numbers.');
  }
  if (!anchor && a.selector) anchor = document.querySelector(a.selector);
  if (!anchor) {
    if (a.selector) throw new Error('add_element: no element matched selector ' + JSON.stringify(a.selector));
    anchor = document.body;
  }
  let target = position;
  if ((position === 'before' || position === 'after') && !anchor.parentNode) target = 'append';
  const holder = document.createElement('div');
  holder.innerHTML = html;
  const firstEl = holder.firstElementChild;
  const fragment = document.createDocumentFragment();
  while (holder.firstChild) fragment.appendChild(holder.firstChild);
  const count = fragment.childNodes.length;
  if (target === 'prepend') anchor.insertBefore(fragment, anchor.firstChild);
  else if (target === 'before') anchor.parentNode.insertBefore(fragment, anchor);
  else if (target === 'after') anchor.parentNode.insertBefore(fragment, anchor.nextSibling);
  else anchor.appendChild(fragment);
  if (firstEl && rt) {
    try {
      firstEl.scrollIntoView({ block: 'center', behavior: 'auto' });
    } catch (e) { /* scroll is best-effort */ }
    rt.aim(firstEl);
    rt.highlight(firstEl, '#28a745', 2600);
    rt.toast('Agent added content to this page');
  } else if (firstEl) {
    try {
      firstEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (e) { /* scroll is best-effort */ }
  }
  return {
    added: true,
    count,
    position: target,
    target: a.selector || 'body',
    tag: firstEl && firstEl.nodeType === 1 ? firstEl.tagName.toLowerCase() : undefined,
    preview: html.slice(0, 200),
  };
}

function pageDeleteElement(args) {
  const a = args || {};
  const rt = window.__agentRuntime;
  if (!rt) throw new Error('Agent runtime not loaded — reload the extension at chrome://extensions.');
  let el = rt.byIndex(a.index);
  if (a.index != null && a.index !== '' && !el) {
    throw new Error('Element #' + a.index + ' is stale — call get_dom again to refresh element numbers.');
  }
  if (!el && a.selector) el = document.querySelector(a.selector);
  if (!el && a.match) el = rt.byMatch(a.match, { any: true });
  if (!el) throw new Error('delete_element: no element matched ' + JSON.stringify({ index: a.index, selector: a.selector, match: a.match }));
  const info = {
    deleted: true,
    tag: el.tagName.toLowerCase(),
    text: ((el.innerText || el.textContent) || '').trim().slice(0, 120),
    index: a.index != null && a.index !== '' ? Number(a.index) : undefined,
  };
  el.scrollIntoView({ block: 'center', behavior: 'auto' });
  rt.aim(el);
  rt.toast('Agent removed <' + info.tag + '> from this page');
  return rt.wait(550).then(() => {
    try {
      const r = el.getBoundingClientRect();
      const box = document.createElement('div');
      box.style.cssText =
        'position:fixed;z-index:2147483647;pointer-events:none;border:3px solid #dc3545;border-radius:4px;box-shadow:0 0 0 2px rgba(220,53,69,.35),0 0 14px rgba(220,53,69,.7);left:' +
        r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;';
      document.body.appendChild(box);
      setTimeout(() => box.remove(), 1500);
    } catch (e) { /* highlight is best-effort */ }
    el.remove();
    return info;
  });
}

const BROWSER_EXECUTORS = {
  get_page: pageGetPage,
  get_dom: pageGetDom,
  click: pageClick,
  type: pageType,
  key: pageKey,
  scroll: pageScroll,
  get_links: pageGetLinksWithIds,
  type_with_selection: pageTypeWithSelection,
  scroll_smooth: pageScrollSmooth,
  search_on_page: pageSearchOnPage,
  edit_element: pageEditElement,
  add_element: pageAddElement,
  delete_element: pageDeleteElement,
};

function isRestrictedUrl(url) {
  if (!url) return false;
  return (
    /^(chrome|edge|about|devtools|view-source|chrome-extension|chromium):/i.test(url) ||
    url.startsWith('https://chrome.google.com/webstore')
  );
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) throw new Error('No active tab found.');
  return tab;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode the screenshot.'));
    img.src = src;
  });
}

async function captureScreenshot() {
  const tab = await getActiveTab();
  if (isRestrictedUrl(tab.url)) {
    throw new Error(
      `Cannot capture the active tab (${tab.url || tab.id}) — it's a protected page.`
    );
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: 'jpeg',
    quality: 60,
  });
  // Downscale so the image is small enough to keep and display quickly.
  const img = await loadImage(dataUrl);
  const maxW = 900;
  const scale = Math.min(1, maxW / (img.naturalWidth || maxW));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const out = canvas.toDataURL('image/jpeg', 0.7);
  appendScreenshot(out);
  return { captured: true, width: canvas.width, height: canvas.height, image: out };
}

function normalizeUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('navigate requires a valid http(s) URL, e.g. "https://www.google.com/search?q=...".');
  }
  return url;
}

function hostnameOf(rawUrl) {
  try {
    return new URL(String(rawUrl || '')).hostname;
  } catch {
    return '';
  }
}

async function waitForUrlChange(tabId, ms) {
  let before;
  try {
    before = (await chrome.tabs.get(tabId)).url;
  } catch {
    return null;
  }
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      const t = await chrome.tabs.get(tabId);
      if (t && t.url && t.url !== before) return t.url;
    } catch {
      return null;
    }
  }
  return null;
}

async function waitForTabComplete(tabId, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t && t.status === 'complete') return true;
    } catch {
      return false;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function navigateTab(args) {
  const url = normalizeUrl(args && args.url);
  const tab = await getActiveTab();
  await chrome.tabs.update(tab.id, { url });
  // Best-effort wait for the page to finish loading so a following get_page reads real content.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const t = await chrome.tabs.get(tab.id);
      if (t && t.status === 'complete') break;
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { navigatedTo: url };
}

async function searchWeb(args) {
  const q = String((args && args.query) || '').trim();
  if (!q) throw new Error('search requires a query.');
  const engine = searchEngineFor(settings.searchProvider);
  const tab = await getActiveTab();
  const host = hostnameOf(tab.url);
  // Typing into the page's own search box keeps the user in the flow — but
  // only on the matching engine (a Google page search makes no sense when the
  // user picked Bing).
  if (!isRestrictedUrl(tab.url) && host === engine.host) {
    try {
      const r = await executeBrowserTool('search_on_page', { query: q });
      if (r && r.submitted) {
        const changed = await waitForUrlChange(tab.id, 3500);
        if (changed) {
          await waitForTabComplete(tab.id, 10000);
          return { query: q, provider: engine.label, typedIntoSearch: true, navigatedTo: changed };
        }
      }
    } catch (e) {
      // no search field or submit did not navigate — fall back to a plain URL search
    }
  }
  return navigateTab({ url: engine.url(q), provider: engine.label });
}

async function executeBrowserTool(name, args) {
  if (name === 'screenshot') {
    return captureScreenshot();
  }
  if (name === 'navigate') {
    return navigateTab(args);
  }
  if (name === 'search') {
    return searchWeb(args);
  }
  if (name === 'find_best_link') {
    return findBestLink(args);
  }
  if (!chrome.scripting) {
    throw new Error(
      'Browser tools unavailable: chrome.scripting is not loaded. Reload the extension at chrome://extensions (you must reload after adding permissions).'
    );
  }
  const fn = BROWSER_EXECUTORS[name];
  if (!fn) throw new Error('Unknown browser tool: ' + name);
  const tab = await getActiveTab();
  if (isRestrictedUrl(tab.url)) {
    throw new Error(
      `Cannot read the active tab (${tab.url || tab.id}). Chrome blocks extensions from reading chrome://, Web Store, and other protected pages. Switch to a normal web page and try again.`
    );
  }
  let results;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: ensureAgentRuntime,
    });
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fn,
      args: [args || {}],
    });
  } catch (e) {
    throw new Error(`Could not run ${name} on the active tab: ${(e && e.message) || e}`);
  }
  const first = results && results[0];
  let value = first && first.result;
  if (value && typeof value.then === 'function') value = await value;
  if (value !== undefined) return value;
  throw new Error(`No result from ${name}`);
}

async function executeBrowserToolWithRetry(name, args, maxRetries) {
  let lastError = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await executeBrowserTool(name, args);
    } catch (e) {
      lastError = e;
      if (i < maxRetries - 1) {
        // Brief wait before retry
        const waitTime = 200 * Math.pow(1.5, i);
        appendStatus(`⏳ Retrying ${name} in ${waitTime}ms...`);
        await new Promise((r) => setTimeout(r, waitTime));
      }
    }
  }
  throw lastError;
}

function browserToolStatus(name, args) {
  const a = args || {};
  switch (name) {
    case 'search': {
      const engine = searchEngineFor(settings.searchProvider);
      return `🔍 Searching ${engine.label}: "` + String(a.query || '').slice(0, 90) + '"';
    }
    case 'find_best_link': {
      const engine = searchEngineFor(settings.searchProvider);
      return `🔎 Finding the best link on ${engine.label}: "` + String(a.query || '').slice(0, 80) + '"';
    }
    case 'search_on_page':
      return '🔍 Filling the search box on the page…';
    case 'navigate':
      return '🌐 Opening ' + String(a.url || '');
    case 'click':
      return (
        '🌐 ' +
        (a.button === 'double' ? 'Double-clicking ' : a.button === 'right' ? 'Right-clicking ' : 'Clicking ') +
        (a.text || a.selector || 'the target')
      );
    case 'type':
      return '🌐 Typing into ' + (a.selector || a.text || 'the field');
    case 'key':
      return '🌐 Pressing ' + String(a.keys || a.key || '') + ' on the page';
    case 'get_page':
      return '🌐 Reading the active tab…';
    case 'get_dom':
      return '🌐 Inspecting the page…';
    case 'screenshot':
      return '🌐 Capturing a screenshot…';
    case 'scroll':
      return '🌐 Scrolling the page…';
    case 'edit_element':
      return '🌐 Updating ' + (a.selector || a.match || 'page element');
    case 'add_element':
      return '🌐 Adding content to ' + (a.selector || 'the page');
    case 'delete_element':
      return '🌐 Removing ' + (a.selector || a.match || 'page element');
    default:
      return '🌐 ' + name + ' on active tab';
  }
}

async function handleBrowserRequest(payload) {
  const { id, name, arguments: args } = payload;
  const base = settings.serverUrl || DEFAULT_SERVER;
  appendStatus(browserToolStatus(name, args));
  try {
    const result = await executeBrowserTool(name, args);
    await fetch(`${base}/browser/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, result }),
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    appendStatus('✖ ' + msg);
    try {
      await fetch(`${base}/browser/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, error: msg }),
      });
    } catch (_) {
      // server may be gone
    }
  }
}

// ---------------- SSE streaming ----------------
function parseSSE(raw) {
  let event = '';
  let data = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '');
  }
  return { event, data };
}

function handleEvent(event, data) {
  let payload = {};
  try {
    payload = JSON.parse(data);
  } catch {
    payload = {};
  }
  switch (event) {
    case 'start':
      if (payload.sessionId) {
        settings.sessionId = payload.sessionId;
        saveSettings();
      }
      break;
    case 'status': {
      const message = payload.message || '…';
      if (streaming) setGenState('working');
      // Heartbeat lines repeat while the model is silent — update in place so
      // the transcript does not fill up with identical pills.
      if (/still working/i.test(message) && lastBlock && lastBlock.type === 'status') {
        lastBlock.el.textContent = message;
        scrollToBottom();
        break;
      }
      if (isPlanningStatus(message)) {
        setGenState('thinking');
        appendThinking(message);
        break;
      }
      appendStatus(message);
      break;
    }
    case 'thinking':
      setGenState('thinking');
      appendThinking(payload.content || '');
      break;
    case 'assistant':
      setGenState('generating');
      appendAssistant(payload.content || '', payload.interim);
      break;
    case 'tool':
      setGenState('tools');
      appendTool(payload.name, payload.arguments);
      break;
    case 'tool_result':
      appendToolResult(payload.ok, payload.summary || payload.error || 'done', payload.detail);
      break;
    case 'tool_denied':
      appendStatus('⛔ ' + payload.name + ' denied');
      break;
    case 'approve_request':
      showApproval(payload.id, payload.name, payload.arguments);
      break;
    case 'browser_request':
      handleBrowserRequest(payload);
      break;
    case 'stopped':
      appendStatus('⏹ Stopped.');
      endRun('stopped');
      break;
    case 'done':
      endRun('idle');
      break;
    case 'error': {
      const msg = payload.message || 'unknown error';
      appendStatus('✖ ' + msg);
      if (/402|not included in your free usage|payment required/i.test(msg)) {
        appendStatus(
          'ℹ That model is a paid Ollama cloud model. Open ⚙ settings and pick a local model (qwen2.5-coder:14b or gemma4:latest).'
        );
      }
      endRun('error');
      break;
    }
  }
}

async function readStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const { event, data } = parseSSE(raw);
      if (event) handleEvent(event, data);
    }
  }
  if (buffer.trim()) {
    const { event, data } = parseSSE(buffer);
    if (event) handleEvent(event, data);
  }
}

// ---------------- sending ----------------
/**
 * True when the user wants the PAGE changed ("update my profile", "fix the
 * headline") rather than an answer to a question — those prompts must tell the
 * model to edit the active tab instead of writing an analysis.
 */
function looksLikePageEditRequest(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const question =
    t.includes('?') ||
    /^\s*(what|who|when|where|why|how|which|is|are|was|were|does|did|do|can|could|will|would|should|explain|describe|summar\w*|tell me)\b/i.test(
      t
    );
  if (question) return false;
  return /\b(updat\w*|edit\w*|chang\w*|fix\w*|correct\w*|replac\w*|rewrit\w*|fill\w*|add\w*|remov\w*|delet\w*|sav\w*|submit\w*|publish\w*|post\w*|writ\w*|appl\w*|renam\w*|complet\w*|improv\w*)\b/i.test(
    t
  );
}

/**
 * Smarter auto-search: instead of firing a browser search for every message,
 * only three conditions trigger it up front —
 *   1. an explicit research request ("look up", "research", "google X"),
 *   2. a request for current information ("latest", "today", "news", …),
 *   3. (server-side) the model can't answer confidently — handled by the
 *      agent's own web-research fallback, not here.
 * Anything else is left to the model's own judgment.
 */
function shouldAutoSearch(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, reason: 'empty' };
  if (looksLikePageEditRequest(t)) return { ok: false, reason: 'page-edit' };
  if (
    /\b(look\s*up|research|google|web\s*search|search\s+(?:the\s+)?(?:web|online|internet|google|duckduckgo|bing|news)|find\s+me\s|dig\s*up|hunt\s*down)\b/i.test(
      t
    )
  ) {
    return { ok: true, reason: 'explicit-research' };
  }
  if (
    /\b(latest|breaking|today|tonight|yesterday|this\s+(?:week|month|year)|currently|right\s+now|as\s+of|recent(?:ly)?|news|score[sd]?|weather|stock|price[sd]?|release\s+(?:date|notes)|who\s+(?:won|is\s+leading)|what(?:'s| is)\s+the\s+(?:latest|current)|20(?:2[5-9]|[3-9]\d))\b/i.test(
      t
    )
  ) {
    return { ok: true, reason: 'current-info' };
  }
  return { ok: false, reason: 'model-decides' };
}

// --- search provider -------------------------------------------------------

const SEARCH_ENGINES = {
  google: { label: 'Google', host: 'www.google.com', url: (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q) },
  duckduckgo: { label: 'DuckDuckGo', host: 'duckduckgo.com', url: (q) => 'https://duckduckgo.com/?q=' + encodeURIComponent(q) },
  bing: { label: 'Bing', host: 'www.bing.com', url: (q) => 'https://www.bing.com/search?q=' + encodeURIComponent(q) },
};

function searchEngineFor(provider) {
  return SEARCH_ENGINES[provider] || SEARCH_ENGINES.google;
}

// --- page context modes ----------------------------------------------------

const CONTEXT_MODE_LABELS = {
  selection: 'Selected text',
  visible: 'Visible page',
  full: 'Full page',
};

function currentContextMode() {
  return settings.contextMode === 'selection' || settings.contextMode === 'visible'
    ? settings.contextMode
    : 'full';
}

/** Chip above the composer + summary line inside the Context section. */
function updateContextIndicator() {
  const on = settings.includeTab !== false;
  const mode = currentContextMode();
  const label = CONTEXT_MODE_LABELS[mode];
  const chip = $('contextChip');
  if (chip) {
    chip.classList.toggle('hidden', !on);
    chip.textContent = on ? `Context: ${label}` : '';
  }
  const indicator = $('contextIndicator');
  if (indicator) {
    indicator.textContent = on
      ? `Will send: ${label} from the active tab (obvious secrets redacted)`
      : 'Will send: nothing from the page';
    indicator.dataset.state = on ? 'on' : 'off';
  }
  const summary = $('tabSummary');
  if (summary) {
    const title = $('tabTitle');
    summary.textContent = on ? `${label} · ${(title && title.textContent) || 'Active tab'}` : 'Context off';
  }
}

// Capture the active tab's content and frame it as context for the model.
function buildTabContext(snap) {
  const s = snap || {};
  return [
    '[Active browser tab — captured by the extension. This page is open in front of the user right now, so act on it directly with the browser tools (click, type, edit_element, add_element) instead of telling the user to do things manually.]',
    'URL: ' + (s.url || ''),
    'Title: ' + (s.title || ''),
    s.mode ? 'Captured: ' + (CONTEXT_MODE_LABELS[s.mode] || s.mode) : '',
    s.empty ? '(The user had nothing selected, so no selection text was captured.)' : '',
    '---',
    s.text || '',
    '[/Active browser tab]',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

async function sendMessage(overrideText, options) {
  const opts = options || {};
  const isRegen = typeof overrideText === 'string';
  const text = isRegen ? overrideText : inputEl.value.trim();
  if (!text || streaming) return;
  if (!isRegen) {
    inputEl.value = '';
    autoGrow();
    appendUser(text);
  }
  beginRun();
  const ac = new AbortController();
  activeController = ac;

  // Show research cursor on the page
  try { document.body.style.cursor = 'progress'; } catch {}

  // Optionally read the active browser tab and attach it as context so the
  // agent can plan and act on the page step by step (like Claude). The mode
  // (selection / visible / full page) comes from Settings → Context.
  let outMessage = text;
  let capturedFullSnap = null;
  if (settings.includeTab !== false) {
    const mode = currentContextMode();
    appendStatus(mode === 'selection' ? '📄 Reading selection…' : '🌐 Reading page…');
    try {
      const snap = await executeBrowserTool('get_page', {
        max_chars: mode === 'full' ? 5000 : 3000,
        max_scrolls: mode === 'full' ? 1 : 0,
        mode,
      });
      if (mode === 'full') capturedFullSnap = snap;
      if (mode === 'selection' && snap && snap.empty) {
        appendStatus('ℹ Nothing selected — sending without page context');
      } else {
        outMessage = buildTabContext(snap) + '\n\n' + text;
      }
    } catch (e) {
      appendStatus('⚠ Could not read page: ' + ((e && e.message) || e));
      outMessage = text;
    }
  }

  // Generate a prompt from user input + page context. Searching Google with
  // it is opt-in (autoSearchOnSend) — by default the model decides if and
  // when a search is needed and runs it itself, visible in the active tab.
  const userPrompt = trimAll(text);
  let searchPrompt = userPrompt || 'analyze this webpage and provide insights';

  // Build the actual message prompt combining page context + user intent
  if (settings.autoPrompt && settings.researchMode) {
    appendStatus('🔍 Generating research prompt…');
    try {
      let pageContext = '';
      if (settings.researchMode === 'full' || settings.researchMode === 'summary') {
        // Reuse the page snapshot captured for context when we already have a
        // full-page read; only re-read the tab if context was off/selection.
        const snap =
          capturedFullSnap ||
          (await executeBrowserTool('get_page', { max_chars: 3000, max_scrolls: 1 }));
        pageContext = (snap.text || '').slice(0, 3000);
        if (settings.researchMode === 'summary') {
          const sentences = pageContext.split(/[.!?]+/).filter(s => s.trim().length > 10);
          pageContext = sentences.slice(0, 3).join('. ') + '.';
        }
      }
      if (settings.researchMode === 'links') {
        const linksSnap = await executeBrowserTool('get_links');
        const relevantLinks = (linksSnap.elements || linksSnap.links || [])
          .filter((l) => (l.text || '').length > 10)
          .slice(0, 5)
          .map((l) => `${l.text}: ${l.href}`)
          .join('\n');
        pageContext = `Relevant links found on page:\n${relevantLinks}`;
      }
      // Generate proper prompt: combine page context with user's question.
      // "Update my profile" must stay an EDIT task — the old template forced
      // "provide a comprehensive analysis", so the model researched instead of
      // changing the page.
      searchPrompt = looksLikePageEditRequest(userPrompt)
        ? `I'm on a webpage with this content:\n${pageContext}\n\nThe user asks: "${userPrompt}". Review this active tab and perform the change yourself with the browser tools (get_dom, click, type, edit_element, add_element, delete_element), then screenshot to verify. Do NOT answer with analysis, research, or step-by-step instructions — actually update the page and report what you changed.`
        : `I'm on a webpage with this content:\n${pageContext}\n\nThe user asks: "${userPrompt}". Please provide a comprehensive analysis and answer their question.`;
      outMessage = searchPrompt;
    } catch (e) {
      appendStatus('⚠ Prompt generation failed: ' + ((e && e.message) || e));
      searchPrompt = userPrompt || 'analyze this webpage and provide insights';
    }
    outMessage = searchPrompt;
  } else if (userPrompt && !settings.autoPrompt) {
    // Auto-prompt disabled but user typed something - use their prompt
    searchPrompt = userPrompt;
    outMessage = searchPrompt;
  }

  // Auto-search only fires for research/current-info prompts (see
  // shouldAutoSearch); everything else is left to the model, which runs its
  // own web research when it can't answer confidently.
  if (settings.autoSearchOnSend && searchPrompt && !outMessage.includes('google.com/search')) {
    const decision = shouldAutoSearch(text);
    if (decision.ok) {
      appendStatus(`🔍 Searching (${decision.reason === 'explicit-research' ? 'research request' : 'current info'})…`);
      try {
        await executeBrowserTool('search', { query: searchPrompt });
        outMessage = outMessage + '\n\n[Search performed based on your prompt: ' + searchPrompt + ']';
      } catch (e) {
        appendStatus('⚠ Search failed: ' + ((e && e.message) || e));
        outMessage = outMessage + '\n\n[Search failed: ' + (e && e.message || 'unknown error') + ']';
      }
    }
  }

  const body = {
    sessionId: settings.sessionId,
    message: outMessage,
    model: settings.model || undefined,
    autoApprove: settings.autoApprove,
    searchProvider: settings.searchProvider || undefined,
    findBestLink: settings.findBestLink !== false,
  };
  // Regenerating rewinds the server-side history so the old answer is not
  // part of the context for the replacement answer.
  if (Array.isArray(opts.seedMessages)) body.messages = opts.seedMessages;

  try {
    const res = await fetch(`${settings.serverUrl || DEFAULT_SERVER}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Server responded ${res.status}`);
    await readStream(res.body);
    if (streaming) endRun('idle'); // stream closed without a done event
  } catch (e) {
    if (ac.signal.aborted) return; // stopRun() already finalized this run
    appendStatus('✖ ' + (e.message || e));
    endRun('error');
  } finally {
    // Hide research cursor
    try { document.body.style.cursor = ''; } catch {}
  }
}

async function stopRun() {
  if (!streaming) return;
  if (activeController) {
    try { activeController.abort(); } catch {}
  }
  if (settings.sessionId) {
    try {
      await fetch(`${settings.serverUrl || DEFAULT_SERVER}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: settings.sessionId }),
      });
    } catch {}
  }
  endRun('stopped');
  appendStatus('⏹ Stopped.');
}

// ---------------- server / project helpers ----------------
async function checkHealth() {
  const healthEl = $('modelHealth');
  try {
    const res = await fetch(`${settings.serverUrl || DEFAULT_SERVER}/health`);
    const data = await res.json();
    const connEl = $('conn');
    if (data.ok) {
      connEl.textContent = 'connected';
      connEl.className = 'conn ok';
      if (healthEl) {
        healthEl.textContent = 'ollama online';
        healthEl.dataset.state = 'yes';
      }
      loadModels(); // Load models when server is up
    } else {
      connEl.textContent = 'ollama unreachable';
      connEl.className = 'conn err';
      if (healthEl) {
        healthEl.textContent = 'ollama unreachable';
        healthEl.dataset.state = 'no';
      }
    }
  } catch (e) {
    const connEl = $('conn');
    connEl.textContent = 'server offline';
    connEl.className = 'conn err';
    if (healthEl) {
      healthEl.textContent = 'server offline';
      healthEl.dataset.state = 'no';
    }
  }
}

function isCloudModel(name) {
  return /:cloud$/i.test(String(name || ''));
}

function defaultModelChoice(list) {
  const local = list.filter((m) => !isCloudModel(m));
  const pool = local.length ? local : list;
  return pool.find((m) => /coder/i.test(m)) || pool[0];
}

// ---------------- grouped model picker ----------------
const MODEL_GROUP_ORDER = ['Light (<4B)', 'Medium (4–8B)', 'Large (9–14B)', 'Heavy (15B+)', 'Vision', 'Cloud', 'Other'];

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !isFinite(bytes) || bytes <= 0) return '';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1).replace(/\.0$/, '')} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function paramBillions(parameterSize) {
  const m = /([\d.]+)\s*B\b/i.exec(String(parameterSize || ''));
  return m ? parseFloat(m[1]) : null;
}

function modelGroup(d) {
  if (isCloudModel(d.name)) return 'Cloud';
  if (Array.isArray(d.capabilities) && d.capabilities.includes('vision')) return 'Vision';
  const b = paramBillions(d.parameterSize);
  if (b == null) return 'Other';
  if (b < 4) return 'Light (<4B)';
  if (b < 9) return 'Medium (4–8B)';
  if (b < 15) return 'Large (9–14B)';
  return 'Heavy (15B+)';
}

function modelOptionLabel(d) {
  const size = formatBytes(d.size);
  const meta = [size, d.quantization].filter(Boolean).join(' · ');
  const caps = Array.isArray(d.capabilities) ? d.capabilities.filter((c) => c !== 'completion') : [];
  const tail = [
    meta,
    caps.length ? `[${caps.join(', ')}]` : '',
    isCloudModel(d.name) ? '(cloud)' : '',
  ].filter(Boolean).join(' ');
  return tail ? `${d.name} — ${tail}` : d.name;
}

/** Rebuild the model <select> with grouped options; keeps the current value. */
function fillModelSelect(sel, list, details) {
  const byName = new Map((Array.isArray(details) ? details : []).map((d) => [d.name, d]));
  const groups = new Map();
  for (const name of list) {
    const d = byName.get(name) || { name };
    const g = modelGroup(d);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(d);
  }
  const ordered = [
    ...MODEL_GROUP_ORDER.filter((g) => groups.has(g)),
    ...[...groups.keys()].filter((g) => !MODEL_GROUP_ORDER.includes(g)),
  ];
  sel.innerHTML = '';
  for (const label of ordered) {
    const members = groups.get(label);
    const og = document.createElement('optgroup');
    og.label = `${label} (${members.length})`;
    for (const d of members) {
      const o = document.createElement('option');
      o.value = d.name;
      o.textContent = modelOptionLabel(d);
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
}

async function loadModels() {
  try {
    // Try to fetch models from local Ollama server
    const res = await fetch(`${settings.serverUrl || DEFAULT_SERVER}/models`);
    const data = await res.json();
    if (data.ok && Array.isArray(data.models) && data.models.length > 0) {
      models = data.models;
      modelDetailsCache = Array.isArray(data.details) ? data.details : [];
      const sel = $('modelSelect');
      fillModelSelect(sel, models, data.details);
      const local = models.filter((m) => !isCloudModel(m));

      // Set model to default if it's not already set or is a cloud model
      const needsReset =
        !settings.model ||
        (isCloudModel(settings.model) && local.length) ||
        !models.includes(settings.model);

      if (needsReset && models.length) {
        settings.model = defaultModelChoice(models);
        saveSettings();
        sel.value = settings.model || '';
        // Notify user of model selection
        appendStatus(`Selected local model: ${settings.model}`);
      } else {
        sel.value = settings.model || '';
      }
      sel.title = `${models.length} Ollama models installed — current: ${settings.model || 'none'}`;
      updateStatusModel();
      updateActionButtons();
      updatePresetHighlight();
      loadModelInfo(settings.model);
    } else {
      // If no models are found, show error message in UI
      const connEl = $('conn');
      connEl.textContent = 'online · no models';
      connEl.className = 'conn err';
      
      // Try to prompt user to check Ollama
      appendStatus('ℹ Check if Ollama is running and has local models');
    }
  } catch (e) {
    const connEl = $('conn');
    connEl.textContent = 'server offline';
    connEl.className = 'conn err';
    // Provide troubleshooting message
    appendStatus('✖ Could not connect to Ollama server. Make sure Ollama is running at ' + 
      (settings.serverUrl || DEFAULT_SERVER));
  }
}

// ---------------- model capabilities & presets ----------------
/**
 * Real capability data for the selected model, from the server's /model_info
 * (backed by Ollama /api/show): context window length, tools/thinking/vision
 * flags. "Unknown" is shown when the install is too old to report — the UI
 * never guesses from the model's name.
 */
let currentModelInfo = null;

async function loadModelInfo(name) {
  const ctxEl = $('modelCtx');
  const toolsEl = $('modelTools');
  const thinkingEl = $('modelThinking');
  if (!ctxEl && !toolsEl) return;
  if (!name) {
    currentModelInfo = null;
    if (ctxEl) ctxEl.textContent = 'ctx —';
    if (toolsEl) {
      toolsEl.textContent = 'tools —';
      toolsEl.dataset.state = 'unknown';
    }
    if (thinkingEl) thinkingEl.textContent = 'thinking —';
    return;
  }
  if (ctxEl) ctxEl.textContent = 'ctx …';
  if (toolsEl) {
    toolsEl.textContent = 'tools …';
    toolsEl.dataset.state = 'unknown';
  }
  try {
    const res = await fetch(`${settings.serverUrl || DEFAULT_SERVER}/model_info?name=${encodeURIComponent(name)}`);
    const info = await res.json();
    if (!info.ok || (settings.model && info.name !== settings.model)) return;
    currentModelInfo = info;
    if (ctxEl) {
      ctxEl.textContent = info.contextLength ? `ctx ${Number(info.contextLength).toLocaleString()}` : 'ctx —';
      ctxEl.title = info.contextLength
        ? `Context window reported by Ollama: ${info.contextLength} tokens`
        : 'Ollama did not report a context length for this model';
    }
    if (toolsEl) {
      const t = info.tools;
      toolsEl.textContent = t === true ? 'tools yes' : t === false ? 'tools no' : 'tools unknown';
      toolsEl.dataset.state = t === true ? 'yes' : t === false ? 'no' : 'unknown';
      toolsEl.title =
        t === true
          ? 'Ollama reports native tool calling for this model'
          : t === false
            ? 'Ollama reports no tool support — file/browser tools will not be sent to this model'
            : 'This Ollama install does not report capabilities — tool support is unknown';
    }
    if (thinkingEl) {
      const th = info.thinking;
      thinkingEl.textContent = th === true ? 'thinking yes' : th === false ? 'thinking no' : 'thinking unknown';
      thinkingEl.dataset.state = th === true ? 'yes' : th === false ? 'no' : 'unknown';
    }
  } catch (e) {
    if (ctxEl) ctxEl.textContent = 'ctx —';
    if (toolsEl) {
      toolsEl.textContent = 'tools unknown';
      toolsEl.dataset.state = 'unknown';
    }
  }
}

// Quick presets: pick the best installed model for a job using REAL
// capabilities (tools/vision/context), never name matching alone.
let modelDetailsCache = [];

function scoreModelForPreset(d, preset) {
  const caps = Array.isArray(d.capabilities) ? d.capabilities : [];
  const b = paramBillions(d.parameterSize);
  const size = b == null ? 6 : b;
  let score = 0;
  if (preset === 'coding') {
    if (caps.includes('tools')) score += 6;
    score += Math.min(size, 14); // bigger local models code better, up to a point
    if (isCloudModel(d.name)) score -= 4;
    if (d.family && /qwen|codellama|deepseek|starcoder|llama/.test(d.family)) score += 1;
  } else if (preset === 'research') {
    if (caps.includes('tools')) score += 4;
    if (typeof d.contextLength === 'number') score += Math.min(d.contextLength / 4096, 8);
    score += Math.min(size, 12);
    if (isCloudModel(d.name)) score -= 4;
  } else {
    // general: fast + good instructions; tools not required
    score += Math.max(0, 10 - Math.abs(size - 8)); // sweet spot around 8B
    if (caps.includes('thinking')) score += 1;
    if (isCloudModel(d.name)) score -= 4;
  }
  return score;
}

function pickModelFor(preset, details) {
  const list = (details || modelDetailsCache).filter((d) => d && !isCloudModel(d.name));
  if (!list.length) return null;
  return [...list].sort((a, b) => scoreModelForPreset(b, preset) - scoreModelForPreset(a, preset))[0].name;
}

function updatePresetHighlight() {
  const active = settings.model || '';
  for (const btn of document.querySelectorAll('.preset-btn')) {
    const preset = btn.dataset.preset;
    btn.classList.toggle('active', !!active && pickModelFor(preset) === active);
  }
}

function applyPreset(preset) {
  const name = pickModelFor(preset);
  if (!name) {
    appendStatus('✖ No local models available for this preset.');
    return;
  }
  settings.model = name;
  saveSettings();
  const sel = $('modelSelect');
  if (sel) sel.value = name;
  updateStatusModel();
  updatePresetHighlight();
  loadModelInfo(name);
  appendStatus(`Model set for ${preset}: ${name}`);
}

// ---------------- project connection ----------------
let projectPollTimer = null;

const PROJECT_STATUS_LABELS = {
  'not-connected': 'Not connected',
  indexing: 'Indexing…',
  connected: 'Connected',
  error: 'Index error',
};

/** Paint the connection pill + summary from a /project (or /health) payload. */
function updateProjectPill(data) {
  const root = (data && data.root) || '';
  const status = root ? (data && data.status) || 'connected' : 'not-connected';
  const pill = $('projectStatus');
  const label = $('projectStatusText');
  const nameEl = $('projectName');
  const meta = $('projectMeta');
  const reindexBtn = $('reindexProject');
  if (pill) pill.dataset.state = status;
  if (label) {
    const base = PROJECT_STATUS_LABELS[status] || status;
    const files = data && typeof data.fileCount === 'number' ? data.fileCount : null;
    label.textContent = status === 'connected' && files != null ? `${base} · ${files} files` : base;
  }
  if (nameEl) {
    nameEl.textContent = root ? (data.name || root.split(/[\\/]/).filter(Boolean).pop() || '') : '';
  }
  if (meta) {
    const bits = [];
    if (data && data.truncated) bits.push('scanned (capped)');
    if (data && data.error) bits.push('error: ' + data.error);
    meta.textContent = bits.join(' · ');
  }
  if (reindexBtn) reindexBtn.disabled = !root || status === 'indexing';
  const summary = $('projectSummary');
  if (summary) {
    summary.textContent = root
      ? `${PROJECT_STATUS_LABELS[status] || status} · ${nameEl ? nameEl.textContent : ''}`
      : 'Not set';
  }
  if (root) settings.projectRoot = root;
}

/** Poll GET /project while the server is scanning; one shot otherwise. */
async function refreshProjectStatus({ poll = true } = {}) {
  try {
    const res = await fetch(`${settings.serverUrl || DEFAULT_SERVER}/project`);
    const data = await res.json();
    updateProjectPill(data.ok ? data : null);
    clearTimeout(projectPollTimer);
    if (poll && data.status === 'indexing') {
      projectPollTimer = setTimeout(() => refreshProjectStatus({ poll: true }), 1200);
    }
  } catch (e) {
    updateProjectPill(null);
  }
}

async function setProject() {
  const root = $('projectRoot').value.trim();
  if (!root) return;
  try {
    const res = await fetch(`${settings.serverUrl || DEFAULT_SERVER}/project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root }),
    });
    const data = await res.json();
    if (!data.ok) {
      appendStatus('✖ ' + data.error);
      const pill = $('projectStatus');
      if (pill) pill.dataset.state = 'error';
      const label = $('projectStatusText');
      if (label) label.textContent = data.error || 'Connect failed';
      return;
    }
    settings.projectRoot = data.root;
    saveSettings();
    updateProjectPill(data);
    refreshProjectStatus(); // follow the background scan to completion
    appendStatus('Project connected: ' + data.root);
  } catch (e) {
    appendStatus('✖ Could not reach server to set project. Please ensure Ollama is running.');
  }
}

async function reindexProject() {
  if (!settings.projectRoot) return;
  const btn = $('reindexProject');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`${settings.serverUrl || DEFAULT_SERVER}/project/index`, { method: 'POST' });
    const data = await res.json();
    if (!data.ok) {
      appendStatus('✖ ' + data.error);
      if (btn) btn.disabled = false;
      return;
    }
    updateProjectPill(data);
    refreshProjectStatus();
  } catch (e) {
    appendStatus('✖ Could not reach server to re-index.');
    if (btn) btn.disabled = false;
  }
}

async function applyProject(root) {
  try {
    const res = await fetch(`${settings.serverUrl || DEFAULT_SERVER}/project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root }),
    });
    const data = await res.json();
    if (data.ok) updateProjectPill(data);
    refreshProjectStatus();
  } catch (e) {
    // server may be offline
  }
}

async function refreshActiveTabProfile() {
  const favEl = $('tabFavicon');
  const summary = $('tabSummary');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const titleEl = $('tabTitle');
    const urlEl = $('tabUrl');
    if (!tab) {
      titleEl.textContent = 'No active tab';
      urlEl.textContent = 'Open a page to enable context';
      if (summary) summary.textContent = 'No active tab';
      favEl.classList.add('hidden');
      return;
    }
    const title = (tab.title || 'Untitled page').trim() || 'Untitled page';
    const url = (tab.url || 'chrome://newtab').trim() || 'chrome://newtab';
    titleEl.textContent = title;
    urlEl.textContent = url;
    updateContextIndicator();
    updateTabFavicon(tab, url);
  } catch (e) {
    $('tabTitle').textContent = 'Active tab unavailable';
    $('tabUrl').textContent = 'Tab metadata could not be loaded';
    if (summary) summary.textContent = 'Tab unavailable';
    $('tabFavicon').classList.add('hidden');
  }
}

function updateTabFavicon(tab, url) {
  const favEl = $('tabFavicon');
  if (!favEl) return;
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch (e) {
    host = '';
  }
  const fallback = host ? `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(host)}` : '';
  const src = (tab && tab.favIconUrl) || fallback;
  if (!src) {
    favEl.classList.add('hidden');
    return;
  }
  favEl.onerror = () => {
    if (fallback && !favEl.src.includes('s2/favicons')) favEl.src = fallback;
    else favEl.classList.add('hidden');
  };
  favEl.classList.remove('hidden');
  favEl.src = src;
}

function clearHistory() {
  settings.sessionId = null;
  transcript = [];
  messagesEl.innerHTML = '';
  lastBlock = null;
  saveSettings();
  chrome.storage.local.set({ transcript: [] });
  setResponseTime(0);
  setGenState('idle');
  updateActionButtons();
}

function deleteHistory() {
  if (!confirm('Delete the entire chat history?')) return;
  clearHistory();
}

function newChat() {
  if (streaming) stopRun();
  clearHistory();
}

// ---------------- regenerate / copy ----------------
/** Rewind to the last user prompt and run it again with fresh context. */
function regenerate() {
  if (streaming) return;
  let idx = -1;
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    if (transcript[i].role === 'user') { idx = i; break; }
  }
  if (idx === -1) return;

  const text = transcript[idx].text;
  // Everything after the prompt (answer, tools, status lines) is discarded
  // both locally and on the server, so the retry is not conditioned on the
  // answer it replaces.
  const seedMessages = transcript
    .slice(0, idx)
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && item.text)
    .map((item) => ({ role: item.role, content: item.text }));
  transcript = transcript.slice(0, idx + 1);
  schedulePersist();
  renderTranscript();
  sendMessage(text, { seedMessages });
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // Fallback for contexts where the async clipboard API is unavailable.
    try {
      const scratch = document.createElement('textarea');
      scratch.value = text;
      scratch.setAttribute('readonly', '');
      scratch.style.position = 'fixed';
      scratch.style.opacity = '0';
      document.body.appendChild(scratch);
      scratch.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(scratch);
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

async function copyLastResponse() {
  const text = lastAssistantText();
  if (!text) return;
  const ok = await writeClipboard(text);
  if (copyBtn) {
    const original = copyBtn.textContent;
    copyBtn.textContent = ok ? '✓ Copied' : '✕ Failed';
    setTimeout(() => { copyBtn.textContent = original; }, 1400);
  }
}

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
}

// ---------------- wiring ----------------
function init() {
  // Settings initialized from storage
  refreshActiveTabProfile();
  if (chrome.tabs && chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener(refreshActiveTabProfile);
    chrome.tabs.onUpdated.addListener(() => refreshActiveTabProfile());
    chrome.windows.onFocusChanged.addListener(() => refreshActiveTabProfile());
  }

  $('send').addEventListener('click', sendMessage);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  inputEl.addEventListener('input', autoGrow);
  $('newChatBtn').addEventListener('click', newChat);
  $('clearHistoryBtn').addEventListener('click', deleteHistory);
  $('stopBtn').addEventListener('click', stopRun);
  $('regenBtn').addEventListener('click', regenerate);
  $('copyBtn').addEventListener('click', copyLastResponse);

  // Collapsible sections: the gear jumps to Server & approvals, the model chip
  // jumps to Model — both expand their <details> instead of hiding controls.
  $('settingsBtn').addEventListener('click', () => toggleSection('settingsPanel'));
  statusModelEl.addEventListener('click', () => {
    toggleSection('modelSection', true);
    const sel = $('modelSelect');
    if (sel) sel.focus();
  });

  // Copy buttons live inside rendered Markdown, so they are delegated.
  messagesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.code-copy');
    if (!btn) return;
    const code = btn.closest('.code-block') && btn.closest('.code-block').querySelector('code');
    if (!code) return;
    writeClipboard(code.textContent).then((ok) => {
      btn.textContent = ok ? 'Copied' : 'Failed';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
    });
  });
  $('setProject').addEventListener('click', setProject);
  $('projectRoot').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') setProject();
  });
  $('serverUrl').addEventListener('change', (e) => {
    settings.serverUrl = e.target.value.trim() || DEFAULT_SERVER;
    saveSettings();
    checkHealth();
    loadModels();
  });
  $('modelSelect').addEventListener('change', (e) => {
    settings.model = e.target.value;
    saveSettings();
    updateStatusModel();
    updatePresetHighlight();
    loadModelInfo(settings.model);
  });
  $('autoApprove').addEventListener('change', (e) => {
    settings.autoApprove = e.target.checked;
    saveSettings();
  });
  $('includeTab').addEventListener('change', (e) => {
    settings.includeTab = e.target.checked;
    saveSettings();
    updateContextIndicator();
  });
  if ($('contextMode')) {
    $('contextMode').addEventListener('change', (e) => {
      settings.contextMode = e.target.value;
      saveSettings();
      updateContextIndicator();
    });
  }
  if ($('searchProvider')) {
    $('searchProvider').addEventListener('change', (e) => {
      settings.searchProvider = e.target.value;
      saveSettings();
    });
  }
  if ($('reindexProject')) {
    $('reindexProject').addEventListener('click', reindexProject);
  }
  const presetRow = document.querySelector('.preset-row');
  if (presetRow) {
    presetRow.addEventListener('click', (e) => {
      const btn = e.target.closest('.preset-btn');
      if (btn && btn.dataset.preset) applyPreset(btn.dataset.preset);
    });
  }
  $('autoSearch').addEventListener('change', (e) => {
    settings.autoSearchOnSend = e.target.checked;
    saveSettings();
  });
  $('findBestLink').addEventListener('change', (e) => {
    settings.findBestLink = e.target.checked;
    saveSettings();
  });
  $('autoPrompt').addEventListener('change', (e) => {
    settings.autoPrompt = e.target.checked;
    saveSettings();
  });
  $('researchMode').addEventListener('change', (e) => {
    settings.researchMode = e.target.value;
    saveSettings();
  });
  $('refreshModels').addEventListener('click', loadModels);
  $('approveBtn').addEventListener('click', () => respondApproval(true, 'once'));
  $('sessionBtn').addEventListener('click', () => respondApproval(true, 'session'));
  $('alwaysBtn').addEventListener('click', () => respondApproval(true, 'always'));
  $('denyBtn').addEventListener('click', () => respondApproval(false, 'once'));

  loadSettings().then(() => {
    if (settings.projectRoot) applyProject(settings.projectRoot);
    else refreshProjectStatus();
    checkHealth();
    loadModels();
  });
}

init();
