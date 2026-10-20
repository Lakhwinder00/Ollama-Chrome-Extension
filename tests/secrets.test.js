/**
 * Tests for the persistent provider credential store (agent/secrets.js).
 * Uses MYAGENT_HOME to redirect the store to a temp dir (never touches
 * ~/.myagent). Run with: node --test tests/secrets.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmp;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-secrets-'));
  process.env.MYAGENT_HOME = tmp;
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.MYAGENT_HOME;
});

// Re-require after MYAGENT_HOME is set so a cached path can't leak between tests.
const {
  loadStore,
  getApiKey,
  setApiKey,
  clearApiKey,
  getOpencodeAuth,
  setOpencodeAuth,
} = require('../agent/secrets');

test('an empty store is returned when no file exists', () => {
  assert.deepEqual(loadStore(), { apiKeys: {}, opencode: null });
  assert.equal(getApiKey('anthropic'), null);
});

test('an API key survives a reload', () => {
  setApiKey('anthropic', 'sk-test-123');
  assert.equal(getApiKey('anthropic'), 'sk-test-123');
  const file = path.join(tmp, '.myagent', 'providers.json');
  assert.ok(fs.existsSync(file), 'the key is written to disk');
});

test('clearing an API key removes it', () => {
  setApiKey('openai', 'sk-test-456');
  clearApiKey('openai');
  assert.equal(getApiKey('openai'), null);
});

test('the OpenCode auth survives a reload and can be cleared', () => {
  setOpencodeAuth({ type: 'basic', password: 'secret' });
  assert.deepEqual(getOpencodeAuth(), { type: 'basic', password: 'secret' });
  setOpencodeAuth(null);
  assert.equal(getOpencodeAuth(), null);
});

test('a corrupt store file is ignored', () => {
  const file = path.join(tmp, '.myagent', 'providers.json');
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(loadStore(), { apiKeys: {}, opencode: null });
});
