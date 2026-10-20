/**
 * Tests for the context budget and the step limit of the Agent Core.
 * A browse produces a lot of text (page dumps, DOM snapshots) and every
 * change adds a picture — the history has to stay inside the model's context.
 * Run with: node --test tests/context.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  runAgent,
  trimHistory,
  MAX_ITERATIONS,
  MAX_CONTEXT_CHARS,
} = require('../agent/agent');

const bigText = (n) => 'x'.repeat(n);

// --- trimming ---------------------------------------------------------------

test('a long history is trimmed, but the task survives', () => {
  const history = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'book a flight to New York' },
  ];
  for (let i = 0; i < 40; i++) {
    history.push({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_page' } }] });
    history.push({ role: 'tool', content: bigText(3000) });
  }

  const trimmed = trimHistory(history);
  assert.ok(trimmed.length < history.length, 'the history must shrink');
  assert.equal(trimmed[0].role, 'system', 'the system prompt stays');
  assert.match(trimmed[1].content, /book a flight/, 'the task stays');
  assert.match(
    trimmed[2].content,
    /earlier step\(s\) were removed/,
    'the model is told what was dropped'
  );
  assert.match(trimmed[2].content, /get_page/, 'and which tools it used');
});

test('the trimmed history fits the context budget', () => {
  const history = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'task' },
  ];
  for (let i = 0; i < 100; i++) {
    history.push({ role: 'tool', content: bigText(5000) });
  }
  const trimmed = trimHistory(history);
  const total = trimmed.reduce((n, m) => n + String(m.content || '').length, 0);
  assert.ok(total <= MAX_CONTEXT_CHARS, `history is ${total} chars, budget is ${MAX_CONTEXT_CHARS}`);
});

test('only the newest screenshots stay in the history', () => {
  const history = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'task' },
  ];
  for (let i = 0; i < 6; i++) {
    history.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'screenshot' } }],
    });
    history.push({
      role: 'tool',
      content: `shot ${i}`,
      tool_call_id: `c${i}`,
      images: [`data:image/png;base64,${bigText(100)}`],
    });
  }
  const trimmed = trimHistory(history);
  const withImages = trimmed.filter((m) => Array.isArray(m.images) && m.images.length);
  assert.ok(withImages.length <= 3, 'at most three pictures stay');
  assert.ok(
    trimmed.some((m) => String(m.content || '').includes('shot 5')),
    'the newest picture survives'
  );
});

// --- the step limit ---------------------------------------------------------

test('a runaway run stops at the step limit and says so', async () => {
  let calls = 0;
  const provider = {
    name: 'mock',
    chatStream: async () => {
      calls++;
      if (calls <= MAX_ITERATIONS) {
        return {
          message: {
            content: '',
            tool_calls: [{ function: { name: 'list_directory', arguments: { n: calls } } }],
          },
          streamedContent: false,
        };
      }
      return { message: { content: '{bad json}' }, streamedContent: false };
    },
  };
  const events = [];
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('no network in tests');
  };
  try {
    const result = await runAgent({
      model: 'mock',
      messages: [{ role: 'user', content: 'Update my profile headline' }],
      provider,
      onEvent: (e) => events.push(e),
    });
    assert.equal(calls, MAX_ITERATIONS + 2, 'the loop, then the two synthesis attempts');
    assert.ok(
      events.some((e) => e.type === 'status' && /step limit reached/i.test(e.message || '')),
      'the user must be told that the step limit ended the run'
    );
    assert.match(result.content, /step limit/i, 'the summary mentions the limit');
  } finally {
    global.fetch = originalFetch;
  }
});

test('a long browse does not blow up the context', async () => {
  let calls = 0;
  const provider = {
    name: 'mock',
    chatStream: async () => {
      calls++;
      if (calls <= 30) {
        return {
          message: {
            content: '',
            tool_calls: [{ function: { name: 'get_page', arguments: { n: calls } } }],
          },
          streamedContent: false,
        };
      }
      return { message: { content: 'All done.' }, streamedContent: false };
    },
  };
  const result = await runAgent({
    model: 'mock',
    messages: [{ role: 'user', content: 'fill in the whole form' }],
    provider,
    requestBrowser: async () => bigText(6000), // a huge page dump per step
    onEvent: () => {},
  });
  const total = result.history.reduce((n, m) => n + String(m.content || '').length, 0);
  assert.ok(
    total < MAX_CONTEXT_CHARS * 2,
    `the history must stay bounded, it is ${total} chars`
  );
  assert.match(result.content, /All done/);
});
