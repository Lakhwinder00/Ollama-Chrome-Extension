/**
 * Tests for the persistent "always allow" permission store (agent/permissions.js).
 * Uses MYAGENT_HOME to redirect the store to a temp dir (never touches ~/.myagent).
 * Run with: node --test tests/permissions.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmp;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-perm-'));
  process.env.MYAGENT_HOME = tmp;
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.MYAGENT_HOME;
});

// Re-require after MYAGENT_HOME is set so a cached path can't leak between tests.
const { loadAlwaysAllowed, saveAlwaysAllowed, allowAlways } = require('../agent/permissions');

test('loadAlwaysAllowed returns [] when no file exists', () => {
  assert.deepEqual(loadAlwaysAllowed(), []);
});

test('save + load round-trips and deduplicates', () => {
  saveAlwaysAllowed(['run_command', 'write_file', 'run_command']);
  assert.deepEqual(loadAlwaysAllowed(), ['run_command', 'write_file']);
});

test('allowAlways appends idempotently', () => {
  allowAlways('git_commit');
  allowAlways('git_commit');
  assert.deepEqual(loadAlwaysAllowed(), ['run_command', 'write_file', 'git_commit']);
});
