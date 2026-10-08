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
  looksLikeManualInstructions,
  splitImage,
  imageToBase64,
  runAgent,
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

test('a model with no local answer streams the web fallback to the client', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('duckduckgo')) {
      return {
        ok: true,
        status: 200,
        text: async () => `
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide">Example Guide</a>
          <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide">The official guide</a>`,
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => '<html><head><title>Guide</title></head><body><p>Useful page text for the answer.</p></body></html>',
    };
  };

  try {
    const events = [];
    const provider = { name: 'mock', chatStream: async () => ({ message: { content: '' }, streamedContent: false }) };
    const result = await runAgent({
      model: 'mock',
      messages: [{ role: 'user', content: 'What is the guide?' }],
      provider,
      onEvent: (e) => events.push(e),
    });

    const assistant = events.filter((e) => e.type === 'assistant');
    assert.equal(assistant.length, 1, 'the web answer must be emitted as an assistant event');
    assert.match(assistant[0].content, /checked the web/);
    assert.match(assistant[0].content, /https:\/\/example\.com\/guide/);
    // fetch_url returns { url, content } — stringifying it produced "[object Object]".
    assert.doesNotMatch(assistant[0].content, /\[object Object\]/);
    assert.match(assistant[0].content, /Useful page text/);
    assert.match(result.content, /checked the web/);
    assert.ok(events.some((e) => e.type === 'tool' && e.name === 'web_search'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('manual-instruction replies are detected, real answers are not', () => {
  const instructive =
    'Since I cannot directly edit your profile, you will need to make these changes yourself:\n' +
    '1. Clicking "Edit" on your profile\n2. Updating the headline\n3. Editing the About section\n4. Adding new skills';
  assert.equal(looksLikeManualInstructions(instructive), true);
  assert.equal(looksLikeManualInstructions('The capital of France is Paris.'), false);
  assert.equal(looksLikeManualInstructions("I don't know."), false);
  assert.equal(looksLikeManualInstructions(''), false);
});

test('the model is nudged to act in the browser instead of instructing the user', async () => {
  let calls = 0;
  const provider = {
    name: 'mock',
    chatStream: async () => {
      calls++;
      if (calls === 1) {
        return {
          message: {
            content:
              'Since I cannot edit directly, you will need to do it yourself:\n' +
              '1. Click Edit on your profile\n2. Update the headline\n3. Add the new skills',
          },
          streamedContent: false,
        };
      }
      return { message: { content: 'Done — I updated the headline and added the skills.' }, streamedContent: false };
    },
  };
  const events = [];
  const result = await runAgent({
    model: 'mock',
    messages: [
      {
        role: 'user',
        content:
          '[Active browser tab]\nURL: https://example.com/in/me\n[/Active browser tab]\n\nUpdate my profile headline',
      },
    ],
    provider,
    requestBrowser: async () => ({ ok: true }),
    onEvent: (e) => events.push(e),
  });
  assert.equal(calls, 2, 'the model must be asked again instead of showing the user manual steps');
  assert.ok(events.some((e) => e.type === 'status' && /directly in the browser/i.test(e.message || '')));
  assert.match(result.content, /Done/);
});

test('the browser nudge gives up after two attempts', async () => {
  let calls = 0;
  const instruct =
    'I cannot edit it for you. You will need to do this yourself:\n' +
    '1. Open your profile page\n2. Click the Edit button near the headline\n3. Type the new headline and save the section';
  const provider = {
    name: 'mock',
    chatStream: async () => {
      calls++;
      return { message: { content: instruct }, streamedContent: false };
    },
  };
  const result = await runAgent({
    model: 'mock',
    messages: [{ role: 'user', content: 'update my headline' }],
    provider,
    requestBrowser: async () => ({ ok: true }),
  });
  assert.equal(calls, 3, 'one attempt plus at most two nudges');
  assert.match(result.content, /do this yourself/);
});

test('splitImage separates the screenshot from the tool result', () => {
  const r = splitImage({ captured: true, width: 900, image: 'data:image/jpeg;base64,QUJD' });
  assert.deepEqual(r.rest, { captured: true, width: 900 });
  assert.equal(r.image, 'data:image/jpeg;base64,QUJD');
  assert.equal(imageToBase64('data:image/jpeg;base64,QUJD'), 'QUJD');
  assert.deepEqual(splitImage({ error: 'x' }), { rest: { error: 'x' }, image: null });
  assert.deepEqual(splitImage('plain string'), { rest: 'plain string', image: null });
});

test('screenshot images go back to vision models and are stripped for text-only ones', async () => {
  const makeProvider = () => {
    let calls = 0;
    return {
      name: 'mock',
      chatStream: async () => {
        calls++;
        if (calls === 1) {
          return {
            message: { content: '', tool_calls: [{ function: { name: 'screenshot', arguments: '{}' } }] },
            streamedContent: false,
          };
        }
        return { message: { content: 'Verified the page visually.' }, streamedContent: false };
      },
    };
  };
  const requestBrowser = async () => ({ captured: true, width: 900, height: 500, image: 'data:image/jpeg;base64,QUJD' });

  const visionRun = await runAgent({
    model: 'mock',
    messages: [{ role: 'user', content: 'check the page' }],
    provider: makeProvider(),
    requestBrowser,
    vision: true,
  });
  const visionTool = visionRun.history.find((m) => m.role === 'tool');
  assert.deepEqual(visionTool.images, ['QUJD']);
  assert.ok(!visionTool.content.includes('base64,'), 'history must not contain the raw data URL');
  assert.match(visionRun.content, /Verified/);

  const blindRun = await runAgent({
    model: 'mock',
    messages: [{ role: 'user', content: 'check the page' }],
    provider: makeProvider(),
    requestBrowser,
    vision: false,
  });
  const blindTool = blindRun.history.find((m) => m.role === 'tool');
  assert.equal(blindTool.images, undefined);
  assert.match(blindTool.content, /shown to the user/);
  assert.ok(!blindTool.content.includes('base64,'), 'history must not contain the raw data URL');
});

test('a model that keeps searching is forced to answer from what it gathered', async () => {
  let calls = 0;
  const provider = {
    name: 'mock',
    chatStream: async () => {
      calls++;
      if (calls <= 5) {
        return {
          message: {
            content: '',
            tool_calls: [{ function: { name: 'search', arguments: JSON.stringify({ query: 'local llm ' + calls }) } }],
          },
          streamedContent: false,
        };
      }
      return {
        message: {
          content: 'Best local LLMs: llama.cpp and Ollama both run on CPU. Sources: https://example.com/local-llm',
        },
        streamedContent: false,
      };
    },
  };
  const events = [];
  const result = await runAgent({
    model: 'mock',
    messages: [{ role: 'user', content: 'what is the best local LLM?' }],
    provider,
    requestBrowser: async () => ({ navigatedTo: 'https://www.google.com/search?q=local+llm' }),
    onEvent: (e) => events.push(e),
  });
  assert.equal(calls, 6, 'five searches, then one forced synthesis call');
  assert.match(result.content, /llama\.cpp/);
  assert.ok(events.some((e) => e.type === 'status' && /final answer/i.test(e.message || '')));
  assert.ok(
    !events.some((e) => e.type === 'status' && /maximum steps/i.test(e.message || '')),
    'the user must never see "maximum steps reached" after successful synthesis'
  );
});
