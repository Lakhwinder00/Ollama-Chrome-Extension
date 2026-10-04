/**
 * IModelProvider — the model-provider contract the Agent Core depends on.
 *
 * The Agent Core (agent/agent.js) never talks to Ollama directly: it talks to
 * a provider object that implements this contract. Additional providers
 * (OpenAI, Anthropic, Gemini, OpenRouter, …) can be added later by extending
 * ModelProvider without touching the Agent Core.
 *
 * Required members:
 *   name              string    provider label shown in UIs ("Ollama")
 *   endpoint          string    base URL of the provider
 *   defaultModel      string    default model name for this provider
 *   listModels()                Promise<string[]>
 *   health()                    Promise<{ reachable: boolean, models?: string[], error?: string }>
 *   modelCapabilities()         Promise<{ [model: string]: Set<string> }>
 *   chat(opts)                  Promise<object>   (non-streaming completion)
 *   chatStream(opts)            Promise<{ streamedContent, message }>
 *
 *   opts shared by chat/chatStream:
 *     { model, messages, tools?, think?, signal?, onDelta? }
 */

const ollama = require('./ollama');

class ModelProvider {
  constructor() {
    if (this.constructor === ModelProvider) {
      throw new Error('ModelProvider is abstract — extend it and implement the contract.');
    }
  }

  async listModels() { throw new Error('Not implemented.'); }
  async health() { throw new Error('Not implemented.'); }
  async modelCapabilities() { throw new Error('Not implemented.'); }
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

  async health() {
    return ollama.health();
  }

  async modelCapabilities() {
    return ollama.modelCapabilities();
  }

  async chat(opts) {
    return ollama.chat(opts);
  }

  async chatStream(opts) {
    return ollama.chatStream(opts);
  }
}

module.exports = { ModelProvider, OllamaProvider };
