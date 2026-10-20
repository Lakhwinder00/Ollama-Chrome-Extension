/**
 * Tests for the server's origin/host policy (agent/http-security.js).
 * Run with: node --test tests/http-security.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isOriginAllowed, corsHeadersFor, isLoopbackHost } = require('../agent/http-security');

test('the Chrome extension may talk to the server', () => {
  const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  assert.equal(isOriginAllowed(origin), true);
  const headers = corsHeadersFor(origin);
  assert.equal(headers['Access-Control-Allow-Origin'], origin);
  assert.equal(headers.Vary, 'Origin');
});

test('clients without an Origin header are allowed (CLI, desktop app)', () => {
  assert.equal(isOriginAllowed(undefined), true);
  assert.equal(isOriginAllowed(null), true);
  assert.equal(isOriginAllowed(''), true);
});

test('a web page may not talk to the server', () => {
  assert.equal(isOriginAllowed('https://evil.example'), false);
  assert.equal(isOriginAllowed('http://localhost:3000'), false);
  assert.equal(isOriginAllowed('null'), false); // sandboxed iframe / file://
  assert.equal(isOriginAllowed('chrome-extension://'), false);
  assert.deepEqual(corsHeadersFor('https://evil.example'), {});
});

test('only loopback hosts are accepted', () => {
  assert.equal(isLoopbackHost('127.0.0.1:8787'), true);
  assert.equal(isLoopbackHost('localhost:8787'), true);
  assert.equal(isLoopbackHost('[::1]:8787'), true);
  assert.equal(isLoopbackHost('evil.example'), false);
  assert.equal(isLoopbackHost('192.168.1.10:8787'), false);
  assert.equal(isLoopbackHost(''), false);
});
