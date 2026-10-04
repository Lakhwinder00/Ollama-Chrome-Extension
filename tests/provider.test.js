/**
 * Tests for the IModelProvider abstraction (agent/provider.js).
 * Run with: node --test tests/provider.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ModelProvider, OllamaProvider } = require('../agent/provider');

test('ModelProvider is abstract and cannot be instantiated directly', () => {
  assert.throws(() => new ModelProvider(), /abstract/);
});

test('OllamaProvider implements the IModelProvider contract', () => {
  const p = new OllamaProvider();
  assert.equal(p.name, 'Ollama');
  assert.match(p.endpoint, /^https?:\/\//);
  assert.ok(typeof p.defaultModel === 'string' && p.defaultModel.length > 0);
  for (const method of ['listModels', 'health', 'modelCapabilities', 'chat', 'chatStream']) {
    assert.equal(typeof p[method], 'function', `${method} must exist`);
  }
});

test('OllamaProvider accepts a custom default model', () => {
  const p = new OllamaProvider({ defaultModel: 'my-model' });
  assert.equal(p.defaultModel, 'my-model');
});

test('health() always returns the contract shape (even if Ollama is down)', async () => {
  const p = new OllamaProvider();
  const h = await p.health();
  assert.equal(typeof h.reachable, 'boolean');
  if (!h.reachable) assert.ok(typeof h.error === 'string');
});
