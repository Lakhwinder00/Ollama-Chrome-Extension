/**
 * Shared free web helpers — no API keys, no charges.
 *  - webSearch: DuckDuckGo HTML search (primary) with Bing RSS fallback,
 *    or the user's preferred provider first (searchProvider setting)
 *  - fetchPageText: fetch a URL and extract readable text
 *
 * Note: Google HTML scraping was removed — Google now serves a JS-only page
 * to server-side requests, so no result links can be parsed from it. The
 * extension-side `search` tool still opens Google in the visible tab, which is
 * why "google" is a valid provider preference even though this module cannot
 * scrape it.
 */

/** Providers the server can search with directly (no key, no JS required). */
const SEARCH_PROVIDERS = ['duckduckgo', 'bing', 'google'];

function normalizeSearchProvider(provider) {
  const p = String(provider || '').toLowerCase().trim();
  return SEARCH_PROVIDERS.includes(p) ? p : 'duckduckgo';
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Be polite: at least ~500ms between outbound requests (personal use).
let lastRequest = 0;
async function politeDelay() {
  const now = Date.now();
  const wait = Math.max(0, lastRequest + 500 - now);
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
}

function htmlDecode(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Never let a silent fetch look like a hang: every request gets a hard cap.
const SEARCH_TIMEOUT_MS = 15000;
const PAGE_TIMEOUT_MS = 20000;
const MAX_QUERY_CHARS = 300;

function timeoutError(ms) {
  return new Error(`Request timed out after ${Math.round(ms / 1000)}s.`);
}

/** Read a response body, turning an abort into the same clear timeout error. */
async function readText(res, ms) {
  try {
    return await res.text();
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw timeoutError(ms);
    throw e;
  }
}

/**
 * Search engines need a short phrase, not a whole prompt. The extension's
 * research mode builds a message that contains the entire page text, and both
 * the model and the research fallback used to pass that whole blob as the
 * query (giant URLs, no results, minutes of wasted time).
 */
function sanitizeSearchQuery(raw) {
  let q = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!q) return q;

  // 1. "I'm on a webpage with this content: ... The user asks: "...""
  const asked = /The user asks?:\s*["“]([^"”]{4,})["”]/i.exec(q);
  if (asked) q = asked[1].replace(/\s+/g, ' ').trim();

  // 2. "[Search performed based on your prompt: ...]"
  if (!asked) {
    const bracket = /\[Search performed based on your prompt:\s*([\s\S]{4,}?)\]/i.exec(q);
    if (bracket) q = bracket[1].replace(/\s+/g, ' ').trim();
  }

  // 3. "[Active browser tab ...] Title: ... --- page text --- [/Active browser tab] user question"
  if (!asked && /\[Active browser tab/.test(q)) {
    const title = /Title:\s*([\s\S]{1,160}?)(?:\s+---|\s+\[\/?Active|\s*$)/i.exec(q);
    const parts = q.split('[/Active browser tab]');
    const question = (parts[1] || '').replace(/^\s*[:\-–—]*/, '').replace(/\s+/g, ' ').trim();
    q =
      [title ? title[1].replace(/\s+/g, ' ').trim() : '', question].filter(Boolean).join(' ').trim() || q;
  }

  if (q.length > MAX_QUERY_CHARS) {
    q = q.slice(0, MAX_QUERY_CHARS);
    const lastSpace = q.lastIndexOf(' ');
    if (lastSpace > MAX_QUERY_CHARS * 0.5) q = q.slice(0, lastSpace);
    q = q.replace(/[,;:.–—-]\s*$/, '').trim();
  }
  return q || String(raw || '').trim().slice(0, MAX_QUERY_CHARS);
}

/** DuckDuckGo HTML endpoint — primary source (no key, no JS required). */
async function searchDuckDuckGo(q) {
  const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  }).catch((e) => {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw timeoutError(SEARCH_TIMEOUT_MS);
    throw e;
  });
  if (res.status === 403 || res.status === 429) {
    throw new Error('DuckDuckGo blocked this request (rate limit or bot detection).');
  }
  if (!res.ok) throw new Error(`DuckDuckGo request failed (HTTP ${res.status}).`);
  const html = await readText(res, SEARCH_TIMEOUT_MS);

  const titles = new Map(); // url -> title
  const snippets = new Map(); // url -> snippet
  const seen = new Set();
  const results = [];

  const decodeDdgUrl = (href) => {
    try {
      const full = href.startsWith('//') ? 'https:' + href : href;
      const u = new URL(full, 'https://duckduckgo.com');
      const uddg = u.searchParams.get('uddg');
      const raw = uddg ? decodeURIComponent(uddg) : full;
      const parsed = new URL(raw);
      if (!/^https?:$/i.test(parsed.protocol)) return null;
      return parsed.toString();
    } catch {
      return null;
    }
  };

  // Result titles: <a ... class="result__a" href="//duckduckgo.com/l/?uddg=<target>&...">Title</a>
  const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = titleRe.exec(html))) {
    const real = decodeDdgUrl(m[1]);
    const title = htmlDecode(m[2]);
    if (!real || !title || seen.has(real)) continue;
    seen.add(real);
    titles.set(real, title);
    results.push({ title, url: real, snippet: '' });
  }

  // Snippets: <a class="result__snippet" href="...same redirect...">Snippet text</a>
  const snipRe = /<a[^>]*class="result__snippet"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = snipRe.exec(html))) {
    const real = decodeDdgUrl(m[1]);
    if (!real) continue;
    const snippet = htmlDecode(m[2]);
    if (real && snippet && !snippets.has(real)) snippets.set(real, snippet);
  }
  for (const r of results) {
    if (snippets.has(r.url)) r.snippet = snippets.get(r.url);
  }

  return { source: 'DuckDuckGo', results };
}

/** Bing RSS endpoint — fallback source (clean XML, easy to parse). */
async function searchBingRss(q) {
  const res = await fetch('https://www.bing.com/search?q=' + encodeURIComponent(q) + '&format=rss', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  }).catch((e) => {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw timeoutError(SEARCH_TIMEOUT_MS);
    throw e;
  });
  if (res.status === 403 || res.status === 429) {
    throw new Error('Bing blocked this request (rate limit or bot detection).');
  }
  if (!res.ok) throw new Error(`Bing request failed (HTTP ${res.status}).`);
  const xml = await readText(res, SEARCH_TIMEOUT_MS);

  const results = [];
  const seen = new Set();
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  const tag = (block, name) => {
    const mm = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>', 'i').exec(block);
    return mm ? htmlDecode(mm[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')) : '';
  };
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const url = tag(block, 'link').trim();
    const title = tag(block, 'title').trim();
    if (!url || !title || seen.has(url)) continue;
    try {
      const parsed = new URL(url);
      if (!/^https?:$/i.test(parsed.protocol)) continue;
    } catch {
      continue;
    }
    seen.add(url);
    results.push({ title, url, snippet: tag(block, 'description').trim() });
  }
  return { source: 'Bing', results };
}

/**
 * Search with the user's preferred provider first, falling back to the other
 * so one blocked engine never breaks research. `google` cannot be scraped
 * server-side (JS-only page) — it is honoured by the extension's browser
 * `search` tool, so here it simply means "default chain"; results always
 * report the engine that actually answered via `source`.
 */
async function webSearch(query, provider) {
  const q = sanitizeSearchQuery(query);
  if (!q) throw new Error('web_search requires a "query".');
  const preferred = normalizeSearchProvider(provider);
  await politeDelay();

  const chain =
    preferred === 'bing'
      ? [searchBingRss, searchDuckDuckGo]
      : [searchDuckDuckGo, searchBingRss];

  const errors = [];
  for (const fn of chain) {
    try {
      const { source, results } = await fn(q);
      if (results && results.length) {
        return { query: q, provider: preferred, source, results: results.slice(0, 8) };
      }
      errors.push(`${fn.name}: no results parsed`);
    } catch (e) {
      errors.push(`${fn.name}: ${e.message}`);
    }
  }
  throw new Error(`No search results found. (${errors.join('; ')})`);
}

async function fetchPageText(url) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) {
    throw new Error('fetch_page requires a valid http(s) URL.');
  }
  await politeDelay();
  const res = await fetch(target, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  }).catch((e) => {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw timeoutError(PAGE_TIMEOUT_MS);
    throw e;
  });
  if (res.status === 403 || res.status === 429) {
    throw new Error('The site blocked this request (403/429). Try a different source URL.');
  }
  if (!res.ok) throw new Error(`Fetch failed (HTTP ${res.status}).`);
  const html = await readText(res, PAGE_TIMEOUT_MS);

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? htmlDecode(titleMatch[1]) : '';

  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ');
  body = htmlDecode(body);

  const text = ((title ? title + '\n\n' : '') + body).replace(/\n{3,}/g, '\n\n').trim();
  return text.slice(0, 8000);
}

module.exports = {
  webSearch,
  fetchPageText,
  htmlDecode,
  sanitizeSearchQuery,
  SEARCH_PROVIDERS,
  normalizeSearchProvider,
};
