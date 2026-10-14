/**
 * OpenCode API client (v2 API).
 * OpenCode runs a local API server (default: http://127.0.0.1:4096).
 * Implements the IModelProvider contract for use with the Agent Core.
 * 
 * Note: OpenCode v2 uses a session-based API, not OpenAI-compatible chat completions.
 * This implementation uses the experimental generate endpoint for basic chat.
 * For full agent functionality (tools, streaming), a session-based approach would be needed.
 */

const DEFAULT_OPENCODE_URL = process.env.OPENCODE_URL || 'http://127.0.0.1:4096';
let openCodeUrl = DEFAULT_OPENCODE_URL;
let openCodeAuth = null; // { type: 'bearer', token } or { type: 'basic', password }

function getOpenCodeUrl() {
  return openCodeUrl;
}

function setOpenCodeUrl(url) {
  openCodeUrl = url || DEFAULT_OPENCODE_URL;
}

function setOpenCodeAuth(auth) {
  openCodeAuth = auth;
}

function getAuthHeaders() {
  if (!openCodeAuth) return {};
  if (openCodeAuth.type === 'bearer') {
    return { 'Authorization': `Bearer ${openCodeAuth.token}` };
  }
  if (openCodeAuth.type === 'basic') {
    // OpenCode uses password-only auth with username "opencode"
    const credentials = Buffer.from(`opencode:${openCodeAuth.password}`).toString('base64');
    return { 'Authorization': `Basic ${credentials}` };
  }
  return {};
}

/**
 * Fetch from OpenCode API with error handling.
 */
async function opencodeFetch(pathname, options = {}) {
  const res = await fetch(`${getOpenCodeUrl()}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...getAuthHeaders(),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `OpenCode ${pathname} failed (${res.status} ${res.statusText}): ${body.slice(0, 500)}`
    );
  }
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}

/** List available models from OpenCode. */
async function listModels() {
  try {
    const data = await opencodeFetch('/api/model');
    // Response format: { location: {...}, data: [...] }
    return (data.data || []).map((m) => m.id).filter(Boolean);
  } catch {
    return getDefaultModels();
  }
}

/** Default models if API is unavailable. */
function getDefaultModels() {
  return [
    'opencode/coder',
    'opencode/general',
  ];
}

/**
 * Map OpenCode model entries to picker-friendly details.
 */
function mapModelDetails(models) {
  return (Array.isArray(models) ? models : []).map((m) => {
    const capabilities = m.capabilities || {};
    const limit = m.limit || {};
    const caps = [];
    if (capabilities.tools) caps.push('tools');
    if (capabilities.input?.includes('image')) caps.push('vision');
    // reasoning is not directly exposed but can be inferred from compatibility
    if (m.compatibility?.reasoningField) caps.push('thinking');
    
    return {
      name: m.id,
      size: null,
      parameterSize: null,
      family: m.family || m.providerID || 'opencode',
      quantization: null,
      capabilities: caps,
      modifiedAt: m.time?.released ? new Date(m.time.released).toISOString() : null,
      // Extra fields for UI
      contextLength: limit.context || null,
      maxOutput: limit.output || null,
      providerID: m.providerID,
      status: m.status,
      enabled: m.enabled,
    };
  });
}

/** Details for every available model (what the extension's picker shows). */
async function listModelDetails() {
  try {
    const data = await opencodeFetch('/api/model');
    return mapModelDetails(data.data || []);
  } catch {
    // Fallback to default models with basic details
    return getDefaultModels().map(name => ({
      name,
      size: null,
      parameterSize: null,
      family: 'opencode',
      quantization: null,
      capabilities: ['tools'],
      modifiedAt: null,
    }));
  }
}

/** Check API reachability. */
async function health() {
  try {
    const data = await opencodeFetch('/api/info');
    return { reachable: true, models: await listModels() };
  } catch (e) {
    return { reachable: false, error: e.message };
  }
}

/** Model capabilities map. */
async function modelCapabilities() {
  try {
    const data = await opencodeFetch('/api/model');
    const map = {};
    for (const m of data.data || []) {
      if (m.id) {
        const capabilities = m.capabilities || {};
        const caps = new Set();
        if (capabilities.tools) caps.add('tools');
        if (capabilities.input?.includes('image')) caps.add('vision');
        if (m.compatibility?.reasoningField) caps.add('thinking');
        map[m.id] = caps;
      }
    }
    return map;
  } catch {
    const models = await listModels();
    const map = {};
    for (const name of models) {
      map[name] = new Set(['tools']);
    }
    return map;
  }
}

/**
 * Deep detail for ONE model via OpenCode's /api/model list.
 * Returns { name, contextLength, capabilities, tools, thinking, vision, family,
 *   parameterSize, quantization, size } with nulls where OpenCode didn't say.
 */
async function showModel(name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('showModel requires a model name.');
  const trimmed = name.trim();
  try {
    const data = await opencodeFetch('/api/model');
    const model = (data.data || []).find(m => m.id === trimmed);
    if (!model) throw new Error(`Model ${trimmed} not found.`);
    
    const capabilities = model.capabilities || {};
    const limit = model.limit || {};
    const caps = [];
    if (capabilities.tools) caps.push('tools');
    if (capabilities.input?.includes('image')) caps.push('vision');
    if (model.compatibility?.reasoningField) caps.push('thinking');
    
    return {
      name: trimmed,
      contextLength: limit.context || 128000,
      capabilities: caps,
      tools: capabilities.tools === true ? true : caps.length ? false : null,
      thinking: model.compatibility?.reasoningField ? true : caps.length ? false : null,
      vision: capabilities.input?.includes('image') ? true : caps.length ? false : null,
      family: model.family || model.providerID || null,
      parameterSize: null,
      quantization: null,
      size: null,
    };
  } catch {
    // Fallback: use listModelDetails to find this model
    const details = await listModelDetails();
    const model = details.find(m => m.name === trimmed);
    if (!model) throw new Error(`Model ${trimmed} not found.`);
    const capabilities = model.capabilities || ['tools'];
    return {
      name: trimmed,
      contextLength: model.contextLength || 128000,
      capabilities,
      tools: capabilities.includes('tools') ? true : false,
      thinking: capabilities.includes('thinking') ? true : false,
      vision: capabilities.includes('vision') ? true : false,
      family: model.family,
      parameterSize: model.parameterSize,
      quantization: model.quantization,
      size: model.size,
    };
  }
}

/** Convert messages to a single prompt string for generate endpoint. */
function messagesToPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  
  const parts = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    const content = m.content || '';
    if (role === 'system') {
      parts.push(`System: ${content}`);
    } else if (role === 'user') {
      parts.push(`User: ${content}`);
    } else if (role === 'assistant') {
      parts.push(`Assistant: ${content}`);
    } else if (role === 'tool') {
      parts.push(`Tool (${m.name}): ${JSON.stringify(m.content)}`);
    }
  }
  // Add a final prompt for the assistant to continue
  parts.push('Assistant:');
  return parts.join('\n\n');
}

/** Build request headers with auth. */
function buildHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...getAuthHeaders(),
  };
}

/**
 * Non-streaming chat completion using experimental generate endpoint.
 * Note: This does not support tools - it's a simple text generation.
 */
async function chat({ model, messages, tools, think, signal }) {
  // Extract model ID and provider ID from the model string (format: "provider/id" or just "id")
  let providerID = 'opencode';
  let modelID = model;
  if (model.includes('/')) {
    const parts = model.split('/');
    providerID = parts[0];
    modelID = parts.slice(1).join('/');
  }
  
  const prompt = messagesToPrompt(messages);
  
  const payload = {
    prompt,
    model: { id: modelID, providerID },
  };

  const res = await fetch(`${getOpenCodeUrl()}/api/experimental/generate`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenCode API error (${res.status}): ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const text = data.data?.text || '';
  
  return {
    role: 'assistant',
    content: text,
    tool_calls: undefined,
  };
}

/**
 * Streaming chat completion.
 * Note: OpenCode v2 experimental generate doesn't support streaming.
 * This simulates streaming by returning the full response.
 */
async function chatStream({ model, messages, tools, think, onDelta, signal }) {
  // Use non-streaming chat and simulate streaming
  const result = await chat({ model, messages, tools, think, signal });
  
  if (result.content) {
    // Simulate streaming by sending in chunks
    const chunkSize = 50;
    for (let i = 0; i < result.content.length; i += chunkSize) {
      const chunk = result.content.slice(i, i + chunkSize);
      onDelta({ type: 'assistant', content: chunk });
      // Small delay to simulate streaming
      await new Promise(r => setTimeout(r, 10));
    }
  }
  
  return {
    streamedContent: true,
    message: result,
  };
}

module.exports = {
  DEFAULT_OPENCODE_URL,
  getOpenCodeUrl,
  setOpenCodeUrl,
  setOpenCodeAuth,
  listModels,
  listModelDetails,
  mapModelDetails,
  health,
  modelCapabilities,
  showModel,
  chat,
  chatStream,
};