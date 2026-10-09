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
  findBestLink: false,
  autoPrompt: true,
  researchMode: 'full',
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
  $('findBestLink').checked = settings.findBestLink || false;
  $('autoPrompt').checked = settings.autoPrompt !== false;
  $('researchMode').value = settings.researchMode || 'full';
  if (settings.projectRoot) $('projectSummary').textContent = settings.projectRoot;
  if (transcript.length) renderTranscript();
  updateStatusModel();
  updateAutoSummary();
  updateServerSummary();
  updateActionButtons();
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
  const maxChars = (args && args.max_chars) || 8000;
  const maxScrolls = (args && args.max_scrolls) || 20;
  const scrollStep = Math.round(window.innerHeight * 0.85);
  const seen = new Set();
  const parts = [];
  let total = 0;

  const collect = () => {
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

  let keepGoing = collect();
  const startY = window.scrollY;
  let scrolls = 0;
  while (keepGoing && scrolls < maxScrolls) {
    const before = window.scrollY;
    window.scrollBy({ top: scrollStep });
    scrolls++;
    await new Promise((r) => setTimeout(r, 120));
    if (window.scrollY <= before) break;
    keepGoing = collect();
  }
  window.scrollTo(0, startY);

  const joined = parts.join('\n');
  return {
    url: location.href,
    title: document.title,
    text: joined.slice(0, maxChars),
    truncated: joined.length > maxChars,
    scrolled: scrolls,
  };
}

function pageGetDom(args) {
  const selector = args && args.selector;
  const maxItems = (args && args.max_items) || 100;
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
      value: el.value !== undefined && el.value !== '' ? String(el.value).slice(0, 60) : undefined,
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
    hint: 'Each element has a stable index — pass it as "index" to click/type/edit_element/delete_element.',
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

function pageFindBestLink(args) {
  const keyword = String((args && args.keyword) || '').trim().toLowerCase();
  const selector = args && args.selector;
  let candidates = [];
  if (selector) {
    const el = document.querySelector(selector);
    if (el) {
      candidates = [{ el, text: (el.innerText || el.textContent || '').trim() }];
    }
  } else {
    const nodes = document.querySelectorAll('a[href]');
    for (const el of Array.from(nodes)) {
      const t = ((el.innerText || el.textContent) || '').trim().toLowerCase();
      if (t && t.includes(keyword)) {
        candidates.push({
          el,
          text: t,
          href: el.getAttribute('href') || '',
        });
      }
    }
  }
  if (candidates.length === 0) {
    throw new Error('No link matched keyword: ' + keyword);
  }
  // Sort by relevance: exact match first, then by longer text
  candidates.sort((a, b) => {
    const aLower = a.text.toLowerCase();
    const bLower = b.text.toLowerCase();
    if (aLower === keyword) return -1;
    if (bLower === keyword) return 1;
    return b.text.length - a.text.length;
  });
  const best = candidates[0];
  best.el.scrollIntoView({ block: 'center', behavior: 'auto' });
  if (window.__agentRuntime) {
    window.__agentRuntime.aim(best.el);
    window.__agentRuntime.highlight(best.el, '#28a745', 1800);
  }
  best.el.click();
  return {
    clicked: true,
    tag: best.el.tagName.toLowerCase(),
    text: best.text,
    href: best.href,
  };
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
  find_best_link: pageFindBestLink,
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
  const tab = await getActiveTab();
  const host = hostnameOf(tab.url);
  if (!isRestrictedUrl(tab.url) && /(^|\.)google\./i.test(host)) {
    try {
      const r = await executeBrowserTool('search_on_page', { query: q });
      if (r && r.submitted) {
        const changed = await waitForUrlChange(tab.id, 3500);
        if (changed) {
          await waitForTabComplete(tab.id, 10000);
          return { query: q, typedIntoSearch: true, navigatedTo: changed };
        }
      }
    } catch (e) {
      // no search field or submit did not navigate — fall back to a plain URL search
    }
  }
  return navigateTab({ url: 'https://www.google.com/search?q=' + encodeURIComponent(q) });
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
    case 'search':
      return '🔍 Searching Google: "' + String(a.query || '').slice(0, 90) + '"';
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

// Capture the active tab's content and frame it as context for the model.
function buildTabContext(snap) {
  const s = snap || {};
  return [
    '[Active browser tab — captured by the extension. This page is open in front of the user right now, so act on it directly with the browser tools (click, type, edit_element, add_element) instead of telling the user to do things manually.]',
    'URL: ' + (s.url || ''),
    'Title: ' + (s.title || ''),
    '---',
    s.text || '',
    '[/Active browser tab]',
  ].join('\n');
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
  // agent can plan and act on the page step by step (like Claude).
  let outMessage = text;
  if (settings.includeTab !== false) {
    appendStatus('🌐 Reading page…');
    try {
      const snap = await executeBrowserTool('get_page', { max_chars: 5000, max_scrolls: 1 });
      outMessage = buildTabContext(snap) + '\n\n' + text;
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
        const snap = await executeBrowserTool('get_page', { max_chars: 3000, max_scrolls: 1 });
        pageContext = snap.text || '';
        if (settings.researchMode === 'summary') {
          const sentences = pageContext.split(/[.!?]+/).filter(s => s.trim().length > 10);
          pageContext = sentences.slice(0, 3).join('. ') + '.';
        }
      }
      if (settings.researchMode === 'links') {
        const linksSnap = await executeBrowserTool('get_links');
        const relevantLinks = linksSnap.links
          .filter(l => l.text.length > 10)
          .slice(0, 5)
          .map(l => `${l.text}: ${l.href}`)
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

  if (settings.autoSearchOnSend && searchPrompt && !outMessage.includes('google.com/search')) {
    appendStatus('🔍 Searching with generated prompt…');
    try {
      await executeBrowserTool('search', { query: searchPrompt });
      outMessage = outMessage + '\n\n[Search performed based on your prompt: ' + searchPrompt + ']';
    } catch (e) {
      appendStatus('⚠ Search failed: ' + ((e && e.message) || e));
      outMessage = outMessage + '\n\n[Search failed: ' + (e && e.message || 'unknown error') + ']';
    }
  }

  const body = {
    sessionId: settings.sessionId,
    message: outMessage,
    model: settings.model || undefined,
    autoApprove: settings.autoApprove,
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
  try {
    const res = await fetch(`${settings.serverUrl || DEFAULT_SERVER}/health`);
    const data = await res.json();
    const connEl = $('conn');
    if (data.ok) {
      connEl.textContent = 'connected';
      connEl.className = 'conn ok';
      loadModels(); // Load models when server is up
    } else {
      connEl.textContent = 'ollama unreachable';
      connEl.className = 'conn err';
    }
  } catch (e) {
    const connEl = $('conn');
    connEl.textContent = 'server offline';
    connEl.className = 'conn err';
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
      return;
    }
    settings.projectRoot = data.root;
    saveSettings();
    $('projectSummary').textContent = data.root;
    appendStatus('Project set: ' + data.root);
  } catch (e) {
    appendStatus('✖ Could not reach server to set project. Please ensure Ollama is running.');
  }
}

async function applyProject(root) {
  try {
    await fetch(`${settings.serverUrl || DEFAULT_SERVER}/project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root }),
    });
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
    if (summary) {
      const include = $('includeTab');
      summary.textContent = include && include.checked ? title : 'Context off';
    }
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
  });
  $('autoApprove').addEventListener('change', (e) => {
    settings.autoApprove = e.target.checked;
    saveSettings();
  });
  $('includeTab').addEventListener('change', (e) => {
    settings.includeTab = e.target.checked;
    saveSettings();
    const summary = $('tabSummary');
    if (summary) summary.textContent = e.target.checked ? $('tabTitle').textContent : 'Context off';
  });
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
    checkHealth();
    loadModels();
  });
}

init();
