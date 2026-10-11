#!/usr/bin/env node
/**
 * Free Research MCP server — 100% free, no API keys, no charges.
 *
 * Implements the Model Context Protocol (stdio transport, JSON-RPC 2.0) and
 * exposes four research tools:
 *   - web_search(query)   → DuckDuckGo/Bing top results with snippets
 *   - fetch_page(url)     → readable plain text of a web page
 *   - wikipedia(query)    → Wikipedia summary of the top article
 *   - deep_research(query) → multi-query, multi-source research bundle
 *
 * Usage (Claude Desktop claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "free-research": {
 *         "command": "node",
 *         "args": ["C:\\path\\to\\mcp\\server.js"]
 *       }
 *     }
 *   }
 */

const readline = require('readline');
const { webSearch, fetchPageText, sanitizeSearchQuery } = require('../agent/web');

const SERVER_NAME = 'free-research-mcp';
const SERVER_VERSION = '1.1.0';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function wikipedia(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('wikipedia requires a "query".');
  const searchUrl =
    'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
    encodeURIComponent(q) +
    '&format=json&srlimit=1&origin=*';
  const sres = await fetch(searchUrl, { headers: { 'User-Agent': UA } });
  const sdata = await sres.json();
  const hits = sdata.query && sdata.query.search;
  if (!hits || !hits.length) throw new Error('No Wikipedia article found.');
  const title = hits[0].title;
  const extractUrl =
    'https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&format=json&titles=' +
    encodeURIComponent(title) +
    '&origin=*';
  const eres = await fetch(extractUrl, { headers: { 'User-Agent': UA } });
  const edata = await eres.json();
  const pages = edata.query && edata.query.pages;
  const page = pages && Object.values(pages)[0];
  return {
    title,
    url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')),
    summary: ((page && page.extract) || '').slice(0, 3000),
  };
}

function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function buildResearchQueries(query, maxQueries) {
  const base = sanitizeSearchQuery(query);
  const variants = [
    base,
    base + ' overview',
    base + ' official documentation',
    base + ' latest news',
    base + ' comparison',
  ];
  return variants.slice(0, Math.max(1, maxQueries));
}

async function deepResearch(args = {}) {
  const query = sanitizeSearchQuery(args.query);
  if (!query) throw new Error('deep_research requires a "query".');
  const maxQueries = clampInt(args.max_queries, 3, 1, 5);
  const maxSources = clampInt(args.max_sources, 5, 1, 8);
  const queries = buildResearchQueries(query, maxQueries);

  const seen = new Set();
  const sources = [];
  const searchErrors = [];

  for (const q of queries) {
    try {
      const result = await webSearch(q);
      for (const r of result.results || []) {
        if (!r || !r.url || seen.has(r.url)) continue;
        seen.add(r.url);
        sources.push({
          title: r.title || r.url,
          url: r.url,
          snippet: r.snippet || '',
          query: result.query || q,
          provider: result.provider || result.source || 'unknown',
        });
      }
    } catch (e) {
      searchErrors.push(`${q}: ${e.message}`);
    }
  }

  if (!sources.length) {
    throw new Error('No research sources found. ' + searchErrors.join('; '));
  }

  const limited = sources.slice(0, maxSources);
  for (const source of limited) {
    try {
      source.excerpt = (await fetchPageText(source.url)).slice(0, 2000);
    } catch (e) {
      source.error = e.message;
    }
  }

  let wiki = null;
  try {
    wiki = await wikipedia(query);
  } catch {
    wiki = null;
  }

  return JSON.stringify(
    {
      query,
      searched_queries: queries,
      source_count: limited.length,
      sources: limited.map((s, i) => ({ rank: i + 1, ...s })),
      wikipedia: wiki,
      search_errors: searchErrors,
    },
    null,
    2
  );
}

const TOOLS = [
  {
    name: 'web_search',
    description:
      'Search the web using DuckDuckGo or Bing without API keys and return the top related results with titles, snippets, and URLs.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query. Use a few short keywords.' } },
      required: ['query'],
    },
  },
  {
    name: 'fetch_page',
    description: 'Fetch a web page URL and return readable plain text, truncated to 8000 characters.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full http(s) URL to fetch.' } },
      required: ['url'],
    },
  },
  {
    name: 'wikipedia',
    description: 'Search Wikipedia and return a short summary of the top article.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Topic to look up.' } },
      required: ['query'],
    },
  },
  {
    name: 'deep_research',
    description:
      'Run a deeper free web research pass: search several query angles, collect multiple unique sources, fetch short excerpts from the top sources, and include Wikipedia context when available. Use this instead of web_search for complex, current, comparison, or multi-source questions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The research question or topic.' },
        max_sources: { type: 'integer', description: 'Maximum sources to fetch (1-8, default 5).' },
        max_queries: { type: 'integer', description: 'Maximum search angles to run (1-5, default 3).' },
      },
      required: ['query'],
    },
  },
];

async function callTool(name, args) {
  if (name === 'web_search') return JSON.stringify(await webSearch(args.query), null, 2);
  if (name === 'fetch_page') return await fetchPageText(args.url);
  if (name === 'wikipedia') return JSON.stringify(await wikipedia(args.query), null, 2);
  if (name === 'deep_research') return deepResearch(args);
  throw new Error('Unknown tool: ' + name);
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });

rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;

  if (method === 'initialize') {
    const protocolVersion = (params && params.protocolVersion) || '2024-11-05';
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
  } else if (method === 'notifications/initialized') {
    // notification — no response
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    try {
      const result = await callTool(params.name, params.arguments || {});
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: result }], isError: false },
      });
    } catch (e) {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: String((e && e.message) || e) }],
          isError: true,
        },
      });
    }
  }
  // other methods are ignored
});
