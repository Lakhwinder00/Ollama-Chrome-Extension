/**
 * Shared free web helpers — no API keys, no charges.
 *  - webSearch: DuckDuckGo HTML search (top results with snippets)
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
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q);
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (res.status === 403 || res.status === 429) {
    throw new Error('Search engine blocked this request (rate limit or bot detection). Wait a moment and retry, or use the browser search tools.');
  }
  if (!res.ok) throw new Error(`Search request failed (HTTP ${res.status}).`);
  const html = await res.text();

  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const links = [];
  const snippets = [];
  let m;
  while ((m = linkRe.exec(html))) links.push({ href: m[1], title: htmlDecode(m[2]) });
  while ((m = snippetRe.exec(html))) snippets.push(htmlDecode(m[1]));

  const results = [];
  for (let i = 0; i < Math.min(links.length, 10); i++) {
    let real = links[i].href;
    try {
      const u = new URL(links[i].href, 'https://html.duckduckgo.com');
      const uddg = u.searchParams.get('uddg');
      if (uddg) real = decodeURIComponent(uddg);
    } catch {}
    results.push({ title: links[i].title, url: real, snippet: snippets[i] || '' });
  }
  if (!results.length) throw new Error('No search results found.');
  return { query: q, source: 'DuckDuckGo', results };
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
