/**
 * Tests for the file/git tools and path safety (agent/tools.js).
 * Run with: node --test tests/tools.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { setProjectRoot, resolveSafe, execute } = require('../agent/tools');

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-'));
  setProjectRoot(root);
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

test('setProjectRoot rejects non-existent directories', () => {
  assert.throws(() => setProjectRoot(path.join(root, 'does-not-exist')), /does not exist/);
});

test('resolveSafe blocks path traversal outside the root', () => {
  assert.throws(() => resolveSafe('../../etc/passwd'), /outside the project root/);
  assert.throws(() => resolveSafe(path.join(os.tmpdir(), 'other')), /outside the project root/);
});

test('resolveSafe allows paths inside the root', () => {
  const p = resolveSafe('src/foo.js');
  assert.equal(p, path.join(root, 'src', 'foo.js'));
});

// ---------------------------------------------------------------------------
// File tools
// ---------------------------------------------------------------------------

test('write_file + read_file round-trip with line numbers', async () => {
  const content = 'line one\nline two\nline three';
  const written = await execute('write_file', { path: 'hello.txt', content });
  assert.equal(written.bytesWritten, Buffer.byteLength(content, 'utf8'));

  const read = await execute('read_file', { path: 'hello.txt' });
  assert.equal(read.lines.total, 3);
  assert.match(read.content, /1\| line one/);
  assert.match(read.content, /3\| line three/);
});

test('read_file honors start_line/end_line', async () => {
  const read = await execute('read_file', { path: 'hello.txt', start_line: 2, end_line: 2 });
  assert.match(read.content, /2\| line two/);
  assert.doesNotMatch(read.content, /1\|/);
});

test('edit_file replaces an exact string', async () => {
  const res = await execute('edit_file', { path: 'hello.txt', old_string: 'line two', new_string: 'line TWO' });
  assert.equal(res.replacedOccurrences, 1);
  const read = await execute('read_file', { path: 'hello.txt' });
  assert.match(read.content, /line TWO/);
});

test('edit_file errors when old_string is missing', async () => {
  await assert.rejects(execute('edit_file', { path: 'hello.txt', old_string: 'zzz', new_string: 'x' }), /not found/);
});

test('edit_file requires replace_all for duplicate matches', async () => {
  await execute('write_file', { path: 'dup.txt', content: 'a a a\n' });
  await assert.rejects(
    execute('edit_file', { path: 'dup.txt', old_string: 'a', new_string: 'b' }),
    /replace_all/
  );
  const res = await execute('edit_file', { path: 'dup.txt', old_string: 'a', new_string: 'b', replace_all: true });
  assert.equal(res.replacedOccurrences, 3);
});

test('list_directory lists created files', async () => {
  const res = await execute('list_directory', {});
  const names = res.entries.map((e) => e.name);
  assert.ok(names.includes('hello.txt'));
  assert.ok(names.includes('dup.txt'));
});

test('search_files finds content matches', async () => {
  const res = await execute('search_files', { query: 'line TWO' });
  assert.ok(res.matches >= 1);
  assert.ok(res.results.some((r) => r.file === 'hello.txt' && r.type === 'content'));
});

test('delete_file removes a file and rejects directories', async () => {
  await execute('delete_file', { path: 'dup.txt' });
  await assert.rejects(execute('read_file', { path: 'dup.txt' }));
  await execute('write_file', { path: 'sub/dir/file.txt', content: 'x' });
  await assert.rejects(execute('delete_file', { path: 'sub/dir' }), /not directories/);
});

// ---------------------------------------------------------------------------
// Git tools
// ---------------------------------------------------------------------------

test('git tools: status, diff, commit, branch, checkout', async () => {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });

  // Untracked -> dirty status and diff.
  await execute('write_file', { path: 'repo.txt', content: 'v1\n' });
  const status1 = await execute('git_status', {});
  assert.match(status1.output, /repo\.txt/);

  // Commit via git_commit (stages -A by default).
  const commit = await execute('git_commit', { message: 'initial commit' });
  assert.equal(commit.ok, true);
  assert.match(commit.output, /initial commit/);

  // Now the tree is clean.
  const status2 = await execute('git_status', {});
  assert.equal(status2.output, '(clean working tree)');

  const log = await execute('git_log', { n: 5 });
  assert.match(log.output, /initial commit/);

  const branches = await execute('git_branch', {});
  assert.match(branches.output, /\*/);

  // Create a branch, then check it out with the tool.
  execFileSync('git', ['branch', 'feature'], { cwd: root });
  const checkout = await execute('git_checkout', { branch: 'feature' });
  assert.equal(checkout.ok, true);
  const current = execFileSync('git', ['branch', '--show-current'], { cwd: root }).toString().trim();
  assert.equal(current, 'feature');
});

test('git_commit requires a message', async () => {
  await assert.rejects(execute('git_commit', { message: '   ' }), /non-empty "message"/);
});
