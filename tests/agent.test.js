/**
 * Tests for the Agent Core's tool-call normalization and prompt building
 * (agent/agent.js) — no model call is made.
 * Run with: node --test tests/agent.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DANGEROUS_TOOLS,
  convertToolCallObject,
  parseToolCallsFromContent,
  normalizeToolCalls,
  buildSystemPrompt,
  shouldRunWebResearch,
} = require('../agent/agent');
const { webSearch } = require('../agent/web');

test('dangerous tools require approval (incl. git_commit/git_checkout)', () => {
  for (const t of ['write_file', 'edit_file', 'delete_file', 'run_command', 'git_commit', 'git_checkout']) {
    assert.ok(DANGEROUS_TOOLS.has(t), `${t} should be dangerous`);
  }
  for (const t of ['read_file', 'search_files', 'git_status', 'git_diff', 'git_log']) {
    assert.ok(!DANGEROUS_TOOLS.has(t), `${t} should be read-only`);
  }
});

test('convertToolCallObject normalizes {name, args} shapes', () => {
  assert.equal(convertToolCallObject({ name: 'read_file', args: { path: 'x' } }).function.name, 'read_file');
  assert.deepEqual(
    convertToolCallObject({ function: { name: 'run_command', arguments: '{"command":"ls"}' } }).function.arguments,
    { command: 'ls' }
  );
  assert.equal(convertToolCallObject({ nothing: true }), null);
});

test('parseToolCallsFromContent finds a JSON tool call in content', () => {
  const r = parseToolCallsFromContent('{"function":{"name":"read_file","arguments":{"path":"a.txt"}}}');
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, 'read_file');
});

test('parseToolCallsFromContent finds a fenced ```json block', () => {
  const r = parseToolCallsFromContent('Here is the call:\n```json\n{"name":"read_file","arguments":{"path":"a.txt"}}\n```');
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, 'read_file');
});

test('parseToolCallsFromContent returns null when no tool call', () => {
  assert.equal(parseToolCallsFromContent('just a normal answer'), null);
});

test('normalizeToolCalls converts string arguments to objects', () => {
  const out = normalizeToolCalls([{ function: { name: 'write_file', arguments: '{"path":"x","content":"y"}' } }]);
  assert.equal(out[0].function.name, 'write_file');
  assert.deepEqual(out[0].function.arguments, { path: 'x', content: 'y' });
});

test('normalizeToolCalls tolerates garbage input', () => {
  const out = normalizeToolCalls([{ function: { name: 'bad', arguments: 'not json' } }, null, { function: {} }]);
  assert.equal(out[0].function.name, 'bad');
  assert.deepEqual(out[0].function.arguments, { _raw: 'not json' });
  assert.equal(out[2].function.name, 'unknown_tool');
});

test('shouldRunWebResearch triggers when the model gives no usable answer', () => {
  assert.equal(shouldRunWebResearch(''), true);
  assert.equal(shouldRunWebResearch('I do not know the answer.'), true);
  assert.equal(shouldRunWebResearch('The current homepage is example.com.'), false);
  assert.equal(shouldRunWebResearch('Sorry, I can\'t answer that.'), true);
});

test('webSearch parses DuckDuckGo result URLs and marks the source', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => `
      <html><body>
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https://example.com/docs">Example Docs</a>
        <div class="result__snippet">Helpful answer snippet</div>
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https://example.org/more">More Info</a>
        <div class="result__snippet">More information snippet</div>
      </body></html>
    `,
  });

  try {
    const r = await webSearch('test query');
    assert.equal(r.source, 'DuckDuckGo');
    assert.equal(r.results[0].title, 'Example Docs');
    assert.match(r.results[0].url, /example\.com/);
    assert.equal(r.results[1].title, 'More Info');
  } finally {
    global.fetch = originalFetch;
  }
});

test('buildSystemPrompt lists git_commit/git_checkout and stays model-agnostic', () => {
  const p = buildSystemPrompt();
  assert.match(p, /git_commit/);
  assert.match(p, /git_checkout/);
  assert.match(p, /Operating system/);
  // The core must not assume a single model name.
  assert.doesNotMatch(p, /qwen/);
});
