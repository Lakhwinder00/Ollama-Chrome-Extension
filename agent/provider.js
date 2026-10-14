/**
 * IModelProvider — the model-provider contract the Agent Core depends on.
 *
 * The Agent Core (agent/agent.js) never talks to a provider directly: it talks to
 * a provider object that implements this contract. Additional providers
 * (OpenAI, Anthropic, Gemini, OpenRouter, …) can be added by extending
 * ModelProvider without touching the Agent Core.
 *
 * Required members:
 *   name              string    provider label shown in UIs ("Ollama")
 *   endpoint          string    base URL of the provider
 *   defaultModel      string    default model name for this provider
 *   listModels(apiKey?)                Promise<string[]>
 *   listModelDetails(apiKey?)          Promise<Array<{ name, size, parameterSize, family, quantization, capabilities }>>
 *   health(apiKey?)                    Promise<{ reachable: boolean, models?: string[], error?: string }>
 *   modelCapabilities(apiKey?)         Promise<{ [model: string]: Set<string> }>
 *   showModel(name, apiKey?)           Promise<{ name, contextLength, capabilities, tools, thinking, vision, … }>
 *   chat(opts)                  Promise<object>   (non-streaming completion)
 *   chatStream(opts)            Promise<{ streamedContent, message }>
 *
 *   opts shared by chat/chatStream:
 *     { model, messages, tools?, think?, signal?, onDelta?, apiKey? }
 */

const ollama = require('./ollama');
const anthropic = require('./anthropic');
const openai = require('./openai');
const gemini = require('./gemini');
const openrouter = require('./openrouter');
const opencode = require('./opencode');

class ModelProvider {
  constructor() {
    if (this.constructor === ModelProvider) {
      throw new Error('ModelProvider is abstract — extend it and implement the contract.');
    }
  }

  async listModels() { throw new Error('Not implemented.'); }
  async listModelDetails() { throw new Error('Not implemented.'); }
  async health() { throw new Error('Not implemented.'); }
  async modelCapabilities() { throw new Error('Not implemented.'); }
  async showModel() { throw new Error('Not implemented.'); }
  async chat() { throw new Error('Not implemented.'); }
  async chatStream() { throw new Error('Not implemented.'); }
}

/**
 * OllamaProvider — the default and primary provider (local models only).
 * Ollama listens on http://127.0.0.1:11434 by default (OLLAMA_URL overrides).
 */
class OllamaProvider extends ModelProvider {
  constructor(options = {}) {
    super();
    this.name = 'Ollama';
    this.endpoint = ollama.DEFAULT_OLLAMA_URL;
    this.defaultModel = options.defaultModel || process.env.OLLAMA_MODEL || 'qwen2.5-coder:14b';
  }

  async listModels() {
    return ollama.listModels();
  }

  async listModelDetails() {
    return ollama.listModelDetails();
  }

  async health() {
    return ollama.health();
  }

  async modelCapabilities() {
    return ollama.modelCapabilities();
  }

  async showModel(name) {
    return ollama.showModel(name);
  }

  async chat(opts) {
    return ollama.chat(opts);
  }

  async chatStream(opts) {
    return ollama.chatStream(opts);
  }
}

/**
 * AnthropicProvider — Anthropic (Claude) API.
 * Requires an API key passed via options or ANTHROPIC_API_KEY env var.
 */
class AnthropicProvider extends ModelProvider {
  constructor(options = {}) {
    super();
    this.name = 'Anthropic';
    this.endpoint = anthropic.DEFAULT_ANTHROPIC_URL;
    this.defaultModel = options.defaultModel || anthropic.DEFAULT_MODEL;
    this.apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
  }

  setApiKey(key) {
    this.apiKey = key;
  }

  async listModels() {
    return anthropic.listModels();
  }

  async listModelDetails() {
    return anthropic.listModelDetails();
  }

  async health() {
    return anthropic.health(this.apiKey);
  }

  async modelCapabilities() {
    return anthropic.modelCapabilities();
  }

  async showModel(name) {
    return anthropic.showModel(name);
  }

  async chat(opts) {
    return anthropic.chat({ ...opts, apiKey: this.apiKey });
  }

  async chatStream(opts) {
    return anthropic.chatStream({ ...opts, apiKey: this.apiKey });
  }
}

/**
 * OpenAIProvider — OpenAI (ChatGPT) API.
 * Requires an API key passed via options or OPENAI_API_KEY env var.
 */
class OpenAIProvider extends ModelProvider {
  constructor(options = {}) {
    super();
    this.name = 'OpenAI';
    this.endpoint = openai.DEFAULT_OPENAI_URL;
    this.defaultModel = options.defaultModel || openai.DEFAULT_MODEL;
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  }

  setApiKey(key) {
    this.apiKey = key;
  }

  async listModels() {
    return openai.listModels(this.apiKey);
  }

  async listModelDetails() {
    return openai.listModelDetails(this.apiKey);
  }

  async health() {
    return openai.health(this.apiKey);
  }

  async modelCapabilities() {
    return openai.modelCapabilities(this.apiKey);
  }

  async showModel(name) {
    return openai.showModel(name, this.apiKey);
  }

  async chat(opts) {
    return openai.chat({ ...opts, apiKey: this.apiKey });
  }

  async chatStream(opts) {
    return openai.chatStream({ ...opts, apiKey: this.apiKey });
  }
}

/**
 * GeminiProvider — Google Gemini API.
 * Requires an API key passed via options or GEMINI_API_KEY env var.
 */
class GeminiProvider extends ModelProvider {
  constructor(options = {}) {
    super();
    this.name = 'Google Gemini';
    this.endpoint = gemini.DEFAULT_GEMINI_URL;
    this.defaultModel = options.defaultModel || gemini.DEFAULT_MODEL;
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY;
  }

  setApiKey(key) {
    this.apiKey = key;
  }

  async listModels() {
    return gemini.listModels(this.apiKey);
  }

  async listModelDetails() {
    return gemini.listModelDetails(this.apiKey);
  }

  async health() {
    return gemini.health(this.apiKey);
  }

  async modelCapabilities() {
    return gemini.modelCapabilities(this.apiKey);
  }

  async showModel(name) {
    return gemini.showModel(name, this.apiKey);
  }

  async chat(opts) {
    return gemini.chat({ ...opts, apiKey: this.apiKey });
  }

  async chatStream(opts) {
    return gemini.chatStream({ ...opts, apiKey: this.apiKey });
  }
}

/**
 * OpenRouterProvider — OpenRouter API (access to many models via one key).
 * Requires an API key passed via options or OPENROUTER_API_KEY env var.
 */
class OpenRouterProvider extends ModelProvider {
  constructor(options = {}) {
    super();
    this.name = 'OpenRouter';
    this.endpoint = openrouter.DEFAULT_OPENROUTER_URL;
    this.defaultModel = options.defaultModel || openrouter.DEFAULT_MODEL;
    this.apiKey = options.apiKey || process.env.OPENROUTER_API_KEY;
  }

  setApiKey(key) {
    this.apiKey = key;
  }

  async listModels() {
    return openrouter.listModels(this.apiKey);
  }

  async listModelDetails() {
    return openrouter.listModelDetails(this.apiKey);
  }

  async health() {
    return openrouter.health(this.apiKey);
  }

  async modelCapabilities() {
    return openrouter.modelCapabilities(this.apiKey);
  }

  async showModel(name) {
    return openrouter.showModel(name, this.apiKey);
  }

  async chat(opts) {
    return openrouter.chat({ ...opts, apiKey: this.apiKey });
  }

  async chatStream(opts) {
    return openrouter.chatStream({ ...opts, apiKey: this.apiKey });
  }
}

/**
 * OpenCodeProvider — OpenCode local API server.
 * Runs on http://127.0.0.1:4096 by default (OPENCODE_URL overrides).
 * Supports password authentication via options.opencodeAuth.
 */
class OpenCodeProvider extends ModelProvider {
  constructor(options = {}) {
    super();
    this.name = 'OpenCode';
    this.endpoint = options.opencodeUrl || opencode.DEFAULT_OPENCODE_URL;
    this.defaultModel = options.defaultModel || 'opencode/coder';
    if (options.opencodeUrl) {
      opencode.setOpenCodeUrl(options.opencodeUrl);
    }
    if (options.opencodeAuth) {
      opencode.setOpenCodeAuth(options.opencodeAuth);
    }
  }

  async listModels() {
    return opencode.listModels();
  }

  async listModelDetails() {
    return opencode.listModelDetails();
  }

  async health() {
    return opencode.health();
  }

  async modelCapabilities() {
    return opencode.modelCapabilities();
  }

  async showModel(name) {
    return opencode.showModel(name);
  }

  async chat(opts) {
    return opencode.chat(opts);
  }

  async chatStream(opts) {
    return opencode.chatStream(opts);
  }
}

/**
 * Create a provider instance by name.
 * @param {string} name - Provider name: 'ollama', 'anthropic', 'openai', 'gemini', 'openrouter', 'opencode'
 * @param {object} options - Provider options (defaultModel, apiKey, etc.)
 * @returns {ModelProvider}
 */
function createProvider(name, options = {}) {
  switch (name.toLowerCase()) {
    case 'ollama':
      return new OllamaProvider(options);
    case 'anthropic':
      return new AnthropicProvider(options);
    case 'openai':
      return new OpenAIProvider(options);
    case 'gemini':
      return new GeminiProvider(options);
    case 'openrouter':
      return new OpenRouterProvider(options);
    case 'opencode':
      return new OpenCodeProvider(options);
    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}

/**
 * Get all available provider names.
 * @returns {string[]}
 */
function getProviderNames() {
  return ['ollama', 'anthropic', 'openai', 'gemini', 'openrouter', 'opencode'];
}

/**
 * Get provider display info for UI.
 * @returns {Array<{ id: string, name: string, requiresApiKey: boolean, defaultModel: string }>}
 */
function getProviderInfo() {
  return [
    { id: 'ollama', name: 'Ollama (Local)', requiresApiKey: false, defaultModel: 'qwen2.5-coder:14b' },
    { id: 'anthropic', name: 'Anthropic (Claude)', requiresApiKey: true, defaultModel: 'claude-3-5-sonnet-20241022' },
    { id: 'openai', name: 'OpenAI (ChatGPT)', requiresApiKey: true, defaultModel: 'gpt-4o-2024-08-06' },
    { id: 'gemini', name: 'Google Gemini', requiresApiKey: true, defaultModel: 'gemini-1.5-pro' },
    { id: 'openrouter', name: 'OpenRouter (Multi-model)', requiresApiKey: true, defaultModel: 'anthropic/claude-3.5-sonnet' },
    { id: 'opencode', name: 'OpenCode (Local)', requiresApiKey: false, defaultModel: 'opencode/coder' },
  ];
}

module.exports = {
  ModelProvider,
  OllamaProvider,
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  OpenRouterProvider,
  createProvider,
  getProviderNames,
  getProviderInfo,
};