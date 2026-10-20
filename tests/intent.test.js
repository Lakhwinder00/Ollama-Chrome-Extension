/**
 * Tests for the extension's request-intent helpers (extension/intent.js).
 * Run with: node --test tests/intent.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  looksLikePageEditRequest,
  pageAmbiguityNote,
  shouldAutoSearch,
} = require('../extension/intent.js');

// --- page edit detection ---------------------------------------------------

test('an explicit change of the page is an edit request', () => {
  assert.equal(looksLikePageEditRequest('update my profile headline'), true);
  assert.equal(looksLikePageEditRequest('fix the title of the article'), true);
  assert.equal(looksLikePageEditRequest('delete the second paragraph'), true);
  assert.equal(looksLikePageEditRequest('save the form'), true);
  assert.equal(looksLikePageEditRequest('rewrite this section'), true);
});

test('questions are never edit requests', () => {
  assert.equal(looksLikePageEditRequest('what does this page say?'), false);
  assert.equal(looksLikePageEditRequest('summarize this page'), false);
  assert.equal(looksLikePageEditRequest('who wrote this article?'), false);
  assert.equal(looksLikePageEditRequest('explain the pricing'), false);
});

test('a word that merely contains a verb is not an edit request', () => {
  // "add" inside "address" must not trigger a page edit.
  assert.equal(looksLikePageEditRequest('what is the address of the company'), false);
  assert.equal(looksLikePageEditRequest('list the addresses on the page'), false);
});

test('a targeted verb only counts when a page is referenced', () => {
  assert.equal(looksLikePageEditRequest('make the current tab dark'), true);
  assert.equal(looksLikePageEditRequest('check the newsletter box on this page'), true);
  assert.equal(looksLikePageEditRequest('make me a coffee'), false);
});

test('a read request about the current page is not an edit request', () => {
  assert.equal(looksLikePageEditRequest('show me what is on the current page'), false);
  assert.equal(looksLikePageEditRequest('read this page for me'), false);
});

// --- ambiguity note --------------------------------------------------------

test('an explicit reference to the current page asks for confirmation', () => {
  assert.ok(pageAmbiguityNote('what is on the current page?'));
  assert.ok(pageAmbiguityNote('the page I am on is slow'));
  assert.ok(pageAmbiguityNote('open the active tab'));
});

test('an ordinary message is not treated as ambiguous', () => {
  // "here" alone used to trigger a clarification for every other sentence.
  assert.equal(pageAmbiguityNote('summarize the article'), null);
  assert.equal(pageAmbiguityNote('put the file here'), null);
  assert.equal(pageAmbiguityNote('fix the login bug'), null);
});

// --- auto search -----------------------------------------------------------

test('explicit research and current-info requests trigger a search', () => {
  assert.deepEqual(shouldAutoSearch('look up the price of gold'), {
    ok: true,
    reason: 'explicit-research',
  });
  assert.deepEqual(shouldAutoSearch('what is the latest news about ollama'), {
    ok: true,
    reason: 'current-info',
  });
});

test('ordinary and edit requests do not trigger a search', () => {
  assert.equal(shouldAutoSearch('summarize the page').ok, false);
  assert.equal(shouldAutoSearch('update my profile').ok, false);
  assert.equal(shouldAutoSearch('fix the login bug').ok, false);
  assert.equal(shouldAutoSearch('').ok, false);
});
