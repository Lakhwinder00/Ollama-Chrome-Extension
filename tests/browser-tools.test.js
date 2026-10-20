/**
 * Tests for the browser capabilities that make the extension work like Claude
 * in Chrome: tab control, frame-aware element indexing, coordinate clicks and
 * the screenshot verification loop.
 * Run with: node --test tests/browser-tools.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TOOL_DEFINITIONS, BROWSER_TOOLS } = require('../agent/tools');
const { pickTools, buildScopePrompt, TOOLS_BY_SCOPE } = require('../agent/scope');

const defOf = (name) =>
  TOOL_DEFINITIONS.find((t) => t && t.function && t.function.name === name);

const names = (tools) => tools.map((t) => t.function.name);

// --- tab control ------------------------------------------------------------

test('the tab tools are declared and routed to the extension', () => {
  for (const name of ['list_tabs', 'switch_tab', 'open_tab', 'close_tab']) {
    assert.ok(BROWSER_TOOLS.has(name), `${name} must be handled by the extension`);
    assert.ok(defOf(name), `${name} must be in TOOL_DEFINITIONS`);
  }
});

test('switch_tab and close_tab require a tab id, open_tab requires a url', () => {
  assert.deepEqual(defOf('switch_tab').function.parameters.required, ['tab_id']);
  assert.deepEqual(defOf('close_tab').function.parameters.required, ['tab_id']);
  assert.deepEqual(defOf('open_tab').function.parameters.required, ['url']);
  assert.deepEqual(defOf('list_tabs').function.parameters.required, undefined);
});

test('every browser tool can be pointed at a specific tab', () => {
  for (const name of [
    'get_page',
    'get_dom',
    'click',
    'type',
    'key',
    'edit_element',
    'add_element',
    'delete_element',
    'scroll',
    'screenshot',
    'navigate',
    'search',
    'click_at',
  ]) {
    const def = defOf(name);
    assert.ok(def, `${name} must be declared`);
    assert.ok(
      def.function.parameters.properties.tab_id,
      `${name} must accept a tab_id`
    );
  }
});

// --- coordinate clicking ----------------------------------------------------

test('click_at is a browser tool that needs x and y', () => {
  assert.ok(BROWSER_TOOLS.has('click_at'));
  const def = defOf('click_at');
  assert.deepEqual(def.function.parameters.required, ['x', 'y']);
  assert.match(def.function.description, /screenshot/i);
});

// --- scope routing ----------------------------------------------------------

test('the page scope offers the browser tools, the research scope does not', () => {
  const pageTools = names(pickTools(TOOL_DEFINITIONS, 'page'));
  for (const name of ['list_tabs', 'switch_tab', 'open_tab', 'close_tab', 'click_at']) {
    assert.ok(pageTools.includes(name), `${name} must be available in the page scope`);
  }
  assert.ok(!pageTools.includes('write_file'), 'file tools stay out of the page scope');

  const researchTools = names(pickTools(TOOL_DEFINITIONS, 'research'));
  assert.ok(!researchTools.includes('click'), 'research must not click on the page');
  assert.ok(!researchTools.includes('edit_element'));
  assert.ok(!researchTools.includes('click_at'));
  assert.ok(researchTools.includes('list_tabs'), 'research may still look at other tabs');
  assert.ok(researchTools.includes('open_tab'));
});

test('the page scope prompt explains the new browser workflow', () => {
  const prompt = buildScopePrompt(
    'page',
    { title: 'Example', url: 'https://example.com', text: 'hello' },
    'auto',
    'update the headline'
  );
  assert.match(prompt, /click_at/, 'the model must know about coordinate clicks');
  assert.match(prompt, /list_tabs/, 'the model must know it can use other tabs');
  assert.match(prompt, /screenshot/i, 'the model must know it sees pictures');
  assert.match(prompt, /update the headline/, 'the task is passed through');
});
