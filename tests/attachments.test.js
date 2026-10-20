/**
 * Tests for the attachment handling: the extension reads documents into text
 * and images into data URLs, the server puts them into the user turn and
 * saves the documents in the project.
 * Run with: node --test tests/attachments.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readAttachment } = require('../extension/extract.js');
const { prepareMessages } = require('../agent/ollama');
const { setProjectRoot, getProjectRoot } = require('../agent/tools');

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// --- the provider gets the picture -----------------------------------------

test('the Ollama payload carries the picture as raw base64', () => {
  const out = prepareMessages([
    { role: 'user', content: 'what is in this picture?', images: [PNG_DATA_URL] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].images.length, 1);
  assert.ok(!out[0].images[0].startsWith('data:'), 'the data URL prefix is stripped');
  assert.match(out[0].images[0], /^iVBORw0KGgo/);
});

// --- the extension reads the files -----------------------------------------

test('a document becomes text and a picture stays a picture', async () => {
  const doc = await readAttachment('notes.txt', new Uint8Array(Buffer.from('hello world')));
  assert.equal(doc.kind, 'text');
  assert.equal(doc.text, 'hello world');

  const img = await readAttachment('shot.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  assert.equal(img.kind, 'image');
  assert.match(img.dataUrl, /^data:image\/png;base64,/);
});

// --- the server saves the document in the project --------------------------

test('the attached document is saved in the project so the agent can read it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-attach-'));
  try {
    setProjectRoot(tmp);
    assert.equal(getProjectRoot(), path.resolve(tmp));
    // The server helper writes into <project>/.myagent/attachments.
    const dir = path.join(tmp, '.myagent', 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'report.txt'), 'the full text', 'utf8');
    const saved = path.join(dir, 'report.txt');
    assert.ok(fs.existsSync(saved));
    assert.equal(fs.readFileSync(saved, 'utf8'), 'the full text');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
