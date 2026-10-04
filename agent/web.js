/**
 * Shared free web helpers — no API keys, no charges.
 *  - webSearch: Google HTML search (top results with related links)
 *  - fetchPageText: fetch a URL and extract readable text
 */

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

async function webSearch(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('web_search requires a "query".');
  await politeDelay();
  const url = 'https://www.google.com/search?q=' + encodeURIComponent(q) + '&hl=en&num=10';
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (res.status === 403 || res.status === 429) {
    throw new Error('Google blocked this request (rate limit or bot detection). Wait a moment and retry, or use the browser search tools.');
  }
  if (!res.ok) throw new Error(`Search request failed (HTTP ${res.status}).`);
  const html = await res.text();

  const results = [];
  const seen = new Set();
  const linkRe = /<a[^>]+href="\/url\?q=([^"&]+)[^\"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRe.exec(html))) {
    const rawUrl = match[1];
    const title = htmlDecode(match[2]);
    if (!rawUrl || !title) continue;
    try {
      const decoded = decodeURIComponent(rawUrl);
      const parsed = new URL(decoded);
      if (!/^https?:$/i.test(parsed.protocol)) continue;
      const real = parsed.toString();
      if (seen.has(real)) continue;
      seen.add(real);
      results.push({ title, url: real, snippet: '' });
    } catch {
      // ignore non-URL or malformed matches
    }
  }

  if (!results.length) throw new Error('No search results found.');
  return { query: q, source: 'Google', results: results.slice(0, 8) };
}

async function fetchPageText(url) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) {
    throw new Error('fetch_page requires a valid http(s) URL.');
  }
  await politeDelay();
  const res = await fetch(target, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (res.status === 403 || res.status === 429) {
    throw new Error('The site blocked this request (403/429). Try a different source URL.');
  }
  if (!res.ok) throw new Error(`Fetch failed (HTTP ${res.status}).`);
  const html = await res.text();

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

module.exports = { webSearch, fetchPageText, htmlDecode };
