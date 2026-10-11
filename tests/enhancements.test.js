const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  webSearch,
  SEARCH_PROVIDERS,
  normalizeSearchProvider,
} = require('../agent/web');
const {
  TOOL_DEFINITIONS,
  BROWSER_TOOLS,
  setSearchProvider,
  getSearchProvider,
  setProjectRoot,
  getProjectRoot,
  indexProject,
  getProjectIndex,
} = require('../agent/tools');
const { showModel } = require('../agent/ollama');
const { buildSystemPrompt } = require('../agent/agent');

// --- search provider -------------------------------------------------------

test('search providers are duckduckgo/bing/google with duckduckgo fallback', () => {
  assert.deepEqual(SEARCH_PROVIDERS, ['duckduckgo', 'bing', 'google']);
  assert.equal(normalizeSearchProvider('BING'), 'bing');
  assert.equal(normalizeSearchProvider('  Google '), 'google');
  assert.equal(normalizeSearchProvider('yahoo'), 'duckduckgo');
  assert.equal(normalizeSearchProvider(undefined), 'duckduckgo');
});

test('setSearchProvider normalizes and getSearchProvider reports it', () => {
  assert.equal(setSearchProvider('bing'), 'bing');
  assert.equal(getSearchProvider(), 'bing');
  assert.equal(setSearchProvider('nonsense'), 'duckduckgo');
  assert.equal(getSearchProvider(), 'duckduckgo');
});

const BING_RSS = `<?xml version="1.0"?>
<rss><channel>
  <item><title>Bing Result One</title><link>https://example.com/one</link><description>First snippet</description></item>
  <item><title>Bing Result Two</title><link>https://example.org/two</link><description>Second snippet</description></item>
</channel></rss>`;

test('webSearch with bing provider prefers Bing and reports the source', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => BING_RSS });
  try {
    const r = await webSearch('test query', 'bing');
    assert.equal(r.source, 'Bing');
    assert.equal(r.provider, 'bing');
    assert.equal(r.results.length, 2);
    assert.match(r.results[0].url, /example\.com/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('webSearch with google provider falls back to the scrapeable chain', async () => {
  // Google cannot be scraped server-side; the chain must still return results
  // from DuckDuckGo (or Bing) and say which engine answered.
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (/duckduckgo/i.test(String(url))) {
      return {
        ok: true,
        status: 200,
        text: async () => `<a class="result__a" href="//duckduckgo.com/l/?uddg=https://example.com/docs">Example</a>`,
      };
    }
    return { ok: true, status: 200, text: async () => BING_RSS };
  };
  try {
    const r = await webSearch('test query', 'google');
    assert.equal(r.provider, 'google');
    assert.ok(['DuckDuckGo', 'Bing'].includes(r.source));
    assert.ok(r.results.length >= 1);
  } finally {
    global.fetch = originalFetch;
  }
});

// --- find_best_link tool ---------------------------------------------------

test('find_best_link is declared as a browser tool with query/limit/verify', () => {
  assert.ok(BROWSER_TOOLS.has('find_best_link'), 'must route to the extension');
  const def = TOOL_DEFINITIONS.find((t) => t.function && t.function.name === 'find_best_link');
  assert.ok(def, 'must be in TOOL_DEFINITIONS');
  assert.deepEqual(def.function.parameters.required, ['query']);
  assert.ok(def.function.parameters.properties.limit);
  assert.ok(def.function.parameters.properties.verify);
});

test('web_search and find_best_link never appear in DANGEROUS_TOOLS', () => {
  const { DANGEROUS_TOOLS } = require('../agent/agent');
  assert.equal(DANGEROUS_TOOLS.has('web_search'), false);
  assert.equal(DANGEROUS_TOOLS.has('find_best_link'), false);
});

test('buildSystemPrompt documents the ranked find_best_link tool', () => {
  assert.match(buildSystemPrompt(), /find_best_link/);
});

// --- project connection status --------------------------------------------

test('setProjectRoot connects and getProjectIndex reflects it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-proj-'));
  try {
    setProjectRoot(tmp);
    assert.equal(getProjectRoot(), path.resolve(tmp));
    const snap = getProjectIndex();
    assert.equal(snap.status, 'connected'); // connected, scan not started yet
    assert.equal(snap.root, path.resolve(tmp));
    assert.equal(snap.name, path.basename(tmp));

    const indexed = await indexProject();
    assert.equal(indexed.status, 'connected');
    assert.equal(indexed.error, null);
    assert.ok(indexed.finishedAt, 'scan records when it finished');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('indexProject counts files and skips VCS/build dirs', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-proj-'));
  try {
    fs.writeFileSync(path.join(tmp, 'a.js'), 'console.log(1)');
    fs.writeFileSync(path.join(tmp, 'b.md'), '# hi');
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'c.js'), 'x');
    fs.mkdirSync(path.join(tmp, 'node_modules'));
    fs.writeFileSync(path.join(tmp, 'node_modules', 'junk.js'), 'j');
    fs.mkdirSync(path.join(tmp, '.git'));
    fs.writeFileSync(path.join(tmp, '.git', 'config'), 'g');

    setProjectRoot(tmp);
    const snap = await indexProject();
    assert.equal(snap.fileCount, 3, 'a.js, b.md, src/c.js — not node_modules or .git');
    assert.equal(snap.truncated, false);
    assert.equal(snap.status, 'connected');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('indexProject with no root returns not-connected', async () => {
  // Fresh module instance (own require cache entry) so projectRoot is null.
  const toolsPath = require.resolve('../agent/tools');
  const cached = require.cache[toolsPath];
  delete require.cache[toolsPath];
  try {
    const freshTools = require('../agent/tools');
    assert.equal(freshTools.getProjectRoot(), null);
    const snap = await freshTools.indexProject();
    assert.equal(snap.status, 'not-connected');
    assert.equal(snap.root, null);
    assert.equal(snap.fileCount, 0);
    assert.equal(freshTools.getProjectIndex().status, 'not-connected');
  } finally {
    require.cache[toolsPath] = cached; // restore the shared instance for other tests
  }
});

// --- model capabilities ----------------------------------------------------

test('showModel maps Ollama /api/show into real capability flags', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model_info: { context_length: 32768 },
        capabilities: ['tools', 'thinking'],
        details: { family: 'qwen3', parameter_size: '30.8B', quantization_level: 'Q4_K_M' },
        size: 19193123456,
      }),
    };
  };
  try {
    const info = await showModel('qwen3-coder:30b');
    assert.equal(info.name, 'qwen3-coder:30b');
    assert.equal(info.contextLength, 32768);
    assert.deepEqual(info.capabilities, ['tools', 'thinking']);
    assert.equal(info.tools, true);
    assert.equal(info.thinking, true);
    assert.equal(info.vision, false);
    assert.equal(info.family, 'qwen3');
    assert.equal(info.parameterSize, '30.8B');
    assert.equal(info.quantization, 'Q4_K_M');
    assert.equal(info.size, 19193123456);
    // Compatible with both old (name) and new (model) Ollama builds.
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.model, 'qwen3-coder:30b');
    assert.equal(body.name, 'qwen3-coder:30b');
    assert.match(calls[0].url, /\/api\/show$/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('showModel reports tools:false when capabilities are listed without tools', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ model_info: {}, capabilities: ['completion', 'vision'] }),
  });
  try {
    const info = await showModel('llava:7b');
    assert.equal(info.tools, false);
    assert.equal(info.vision, true);
    assert.equal(info.contextLength, null, 'absent context_length stays null');
  } finally {
    global.fetch = originalFetch;
  }
});

test('showModel reports tools:null when the install reports no capabilities', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ model_info: {}, details: {} }),
  });
  try {
    const info = await showModel('mystery:latest');
    assert.equal(info.tools, null, 'unknown, never guessed from the name');
    assert.equal(info.thinking, null);
    assert.equal(info.vision, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('showModel rejects an empty model name', async () => {
  await assert.rejects(() => showModel(''), /model name/);
});
