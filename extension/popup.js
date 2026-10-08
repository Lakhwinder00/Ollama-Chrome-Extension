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

let settings = {
  serverUrl: DEFAULT_SERVER,
  model: '',
  autoApprove: false,
  includeTab: true,
  projectRoot: '',
  sessionId: null,
  autoSearch: true,
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
  $('autoSearch').checked = settings.autoSearch !== false;
  $('findBestLink').checked = settings.findBestLink || false;
  $('autoPrompt').checked = settings.autoPrompt !== false;
  $('researchMode').value = settings.researchMode || 'full';
  if (transcript.length) renderTranscript();
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

function renderTranscript() {
  messagesEl.innerHTML = '';
  lastBlock = null;
  transcript.forEach(renderItem);
  scrollToBottom();
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
    bubble.textContent = item.text;
    wrap.appendChild(bubble);
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
  result.textContent = '…';
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
  lastBlock.bubble.textContent = lastBlock.item.text;
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
    : document.querySelectorAll('a, button, input, textarea, select, [role="button"], [onclick]');
  const elements = [];
  for (const el of Array.from(nodes)) {
    if (elements.length >= maxItems) break;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    elements.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      className: typeof el.className === 'string' ? el.className.slice(0, 80) : undefined,
      text,
      type: el.type || undefined,
      name: el.name || undefined,
      placeholder: el.placeholder || undefined,
      href: el.href || undefined,
      value: el.value !== undefined ? String(el.value).slice(0, 60) : undefined,
    });
  }
  return { url: location.href, count: elements.length, elements };
}

function pageClick(args) {
  let el = null;
  if (args.selector) {
    el = document.querySelector(args.selector);
  } else if (args.text) {
    const needle = String(args.text).toLowerCase();
    const all = document.querySelectorAll(
      'a, button, [role="button"], input[type="submit"], input[type="button"], label'
    );
    for (const e of all) {
      const t = ((e.innerText || e.textContent || e.value) || '').trim().toLowerCase();
      if (t && t.includes(needle)) { el = e; break; }
    }
  }
  if (!el) throw new Error('No element matched: ' + JSON.stringify(args));
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  try {
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;border:3px solid #d97757;border-radius:4px;box-shadow:0 0 0 2px rgba(217,119,87,.35),0 0 14px rgba(217,119,87,.7);transition:all .12s ease;';
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
  el.click();
  return {
    clicked: true,
    tag: el.tagName.toLowerCase(),
    text: ((el.innerText || el.textContent) || '').trim().slice(0, 120),
  };
}

function pageType(args) {
  let el = null;
  if (args.selector) {
    el = document.querySelector(args.selector);
  } else {
    const needle = String(args.text || '').toLowerCase();
    const fields = document.querySelectorAll('input, textarea, select');
    for (const f of fields) {
      const p = (f.placeholder || '').toLowerCase();
      const n = (f.name || '').toLowerCase();
      const a = (f.getAttribute('aria-label') || '').toLowerCase();
      if (needle && (p.includes(needle) || n.includes(needle) || a.includes(needle))) { el = f; break; }
    }
  }
  if (!el) throw new Error('No input matched: ' + JSON.stringify(args));
  el.focus();
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  try {
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;border:3px solid #d97757;border-radius:4px;box-shadow:0 0 0 2px rgba(217,119,87,.35),0 0 14px rgba(217,119,87,.7);transition:all .12s ease;';
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
  const value = String(args.value);
  if (el instanceof HTMLSelectElement) {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { typed: true, into: args.selector || args.text, value };
  }
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { typed: true, into: args.selector || args.text, value };
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
  highlightElement(best.el, 'rgba(40,167,67,.4)');
  best.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  try {
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;border:3px solid #28a745;border-radius:4px;box-shadow:0 0 0 2px rgba(40,167,67,.35),0 0 14px rgba(40,167,67,.7);transition:all .12s ease;';
    const place = () => {
      const r = best.el.getBoundingClientRect();
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

const BROWSER_EXECUTORS = {
  get_page: pageGetPage,
  get_dom: pageGetDom,
  click: pageClick,
  type: pageType,
  scroll: pageScroll,
  get_links: pageGetLinksWithIds,
  find_best_link: pageFindBestLink,
  type_with_selection: pageTypeWithSelection,
  scroll_smooth: pageScrollSmooth,
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
  return { captured: true, width: canvas.width, height: canvas.height };
}

function normalizeUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('navigate requires a valid http(s) URL, e.g. "https://www.google.com/search?q=...".');
  }
  return url;
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

async function handleBrowserRequest(payload) {
  const { id, name, arguments: args } = payload;
  const base = settings.serverUrl || DEFAULT_SERVER;
  appendStatus('🌐 ' + name + ' on active tab');
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
      if (isPlanningStatus(message)) {
        appendThinking(message);
        break;
      }
      appendStatus(message);
      break;
    }
    case 'thinking':
      appendThinking(payload.content || '');
      break;
    case 'assistant':
      appendAssistant(payload.content || '', payload.interim);
      break;
    case 'tool':
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
      streaming = false;
      sendBtn.disabled = false;
      stopBtn.hidden = true;
      break;
    case 'done':
      streaming = false;
      sendBtn.disabled = false;
      stopBtn.hidden = true;
      break;
    case 'error': {
      const msg = payload.message || 'unknown error';
      appendStatus('✖ ' + msg);
      if (/402|not included in your free usage|payment required/i.test(msg)) {
        appendStatus(
          'ℹ That model is a paid Ollama cloud model. Open ⚙ settings and pick a local model (qwen2.5-coder:14b or gemma4:latest).'
        );
      }
      streaming = false;
      sendBtn.disabled = false;
      stopBtn.hidden = true;
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
// Capture the active tab's content and frame it as context for the model.
function buildTabContext(snap) {
  const s = snap || {};
  return [
    '[Active browser tab — captured by the extension]',
    'URL: ' + (s.url || ''),
    'Title: ' + (s.title || ''),
    '---',
    s.text || '',
    '[/Active browser tab]',
  ].join('\n');
}

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || streaming) return;
  inputEl.value = '';
  autoGrow();
  appendUser(text);
  streaming = true;
  sendBtn.disabled = true;
  stopBtn.hidden = false;
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

  // Always generate a proper prompt based on user input + page context,
  // then search based on this generated prompt (not the raw user input).
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
      // Generate proper prompt: combine page context with user's question
      searchPrompt = `I'm on a webpage with this content:\n${pageContext}\n\nThe user asks: "${userPrompt}". Please provide a comprehensive analysis and answer their question.`;
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

  // Perform search based on the generated prompt
  if (searchPrompt && !outMessage.includes('google.com/search')) {
    appendStatus('🔍 Searching with generated prompt…');
    try {
      await executeBrowserTool('search', { query: searchPrompt });
      // After search, add search context and mark that search is done
      outMessage = outMessage + '\n\n[Search performed based on your prompt: ' + searchPrompt + ']';
      // Don't continue adding more search markers - the search is now part of the message context
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

  try {
    const res = await fetch(`${settings.serverUrl || DEFAULT_SERVER}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Server responded ${res.status}`);
    await readStream(res.body);
  } catch (e) {
    if (!ac.signal.aborted) appendStatus('✖ ' + (e.message || e));
    streaming = false;
    sendBtn.disabled = false;
    stopBtn.hidden = true;
    activeController = null;
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
  streaming = false;
  sendBtn.disabled = false;
  stopBtn.hidden = true;
  activeController = null;
  appendStatus('⏹ Stopped.');
}

// ---------------- server / project helpers ----------------
async function checkHealth() {
  try {
    const res = await fetch(`${settings.serverUrl || DEFAULT_SERVER}/health`);
    const data = await res.json();
    const connEl = $('conn');
    if (data.ok) {
      connEl.textContent = '● connected';
      connEl.className = 'conn ok';
      loadModels(); // Load models when server is up
    } else {
      connEl.textContent = '● ollama unreachable';
      connEl.className = 'conn err';
    }
  } catch (e) {
    const connEl = $('conn');
    connEl.textContent = '● server offline';
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

async function loadModels() {
  try {
    // Try to fetch models from local Ollama server
    const res = await fetch(`${settings.serverUrl || DEFAULT_SERVER}/models`);
    const data = await res.json();
    if (data.ok && Array.isArray(data.models) && data.models.length > 0) {
      models = data.models;
      const sel = $('modelSelect');
      sel.innerHTML = '';
      models.forEach((m) => {
        const o = document.createElement('option');
        o.value = m;
        o.textContent = m + (isCloudModel(m) ? ' (cloud)' : '');
        sel.appendChild(o);
      });
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
    } else {
      // If no models are found, show error message in UI
      const connEl = $('conn');
      connEl.textContent = '● server online (no models)';
      connEl.className = 'conn err';
      
      // Try to prompt user to check Ollama
      appendStatus('ℹ Check if Ollama is running and has local models');
    }
  } catch (e) {
    const connEl = $('conn');
    connEl.textContent = '● server offline';
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
    appendStatus('Project set: ' + data.root);
  } catch (e) {
    appendStatus('✖ Could not reach server to set project. Please ensure Ollama is running.');
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
    appendStatus('Project set: ' + data.root);
  } catch (e) {
    appendStatus('✖ Could not reach server to set project');
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
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const titleEl = $('tabTitle');
    const urlEl = $('tabUrl');
    if (!tab) {
      titleEl.textContent = 'No active tab';
      urlEl.textContent = 'Open a page to enable context';
      return;
    }
    const title = (tab.title || 'Untitled page').trim() || 'Untitled page';
    const url = (tab.url || 'chrome://newtab').trim() || 'chrome://newtab';
    titleEl.textContent = title;
    urlEl.textContent = url;
  } catch (e) {
    $('tabTitle').textContent = 'Active tab unavailable';
    $('tabUrl').textContent = 'Tab metadata could not be loaded';
  }
}

function clearHistory() {
  settings.sessionId = null;
  transcript = [];
  messagesEl.innerHTML = '';
  lastBlock = null;
  saveSettings();
  chrome.storage.local.set({ transcript: [] });
}

function deleteHistory() {
  if (!confirm('Delete the entire chat history?')) return;
  clearHistory();
}

function newChat() {
  clearHistory();
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
  $('settingsBtn').addEventListener('click', () =>
    $('settingsPanel').classList.toggle('hidden')
  );
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
  });
  $('autoApprove').addEventListener('change', (e) => {
    settings.autoApprove = e.target.checked;
    saveSettings();
  });
  $('includeTab').addEventListener('change', (e) => {
    settings.includeTab = e.target.checked;
    saveSettings();
  });
  $('autoSearch').addEventListener('change', (e) => {
    settings.autoSearch = e.target.checked;
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
