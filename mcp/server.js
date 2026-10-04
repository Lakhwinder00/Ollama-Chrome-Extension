#!/usr/bin/env node
/**
 * Free Research MCP server — 100% free, no API keys, no charges.
 *
 * Implements the Model Context Protocol (stdio transport, JSON-RPC 2.0) and
 * exposes three research tools:
 *   - web_search(query)  → Google top results
 *   - fetch_page(url)    → readable text of a web page
 *   - wikipedia(query)   → Wikipedia summary of the top article
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
const { webSearch, fetchPageText } = require('../agent/web');

const SERVER_NAME = 'free-research-mcp';
const SERVER_VERSION = '1.0.0';
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

const TOOLS = [
  {
    name: 'web_search',
    description:
      'Search the web on Google and return the top related results with titles and URLs.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query.' } },
      required: ['query'],
    },
  },
  {
    name: 'fetch_page',
    description: 'Fetch a web page URL and return its readable text.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full URL to fetch.' } },
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
];

async function callTool(name, args) {
  if (name === 'web_search') return JSON.stringify(await webSearch(args.query), null, 2);
  if (name === 'fetch_page') return await fetchPageText(args.url);
  if (name === 'wikipedia') return JSON.stringify(await wikipedia(args.query), null, 2);
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
