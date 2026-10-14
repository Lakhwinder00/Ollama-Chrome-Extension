/**
 * OpenRouter API client.
 * Provides access to many models (Anthropic, OpenAI, Google, Meta, etc.) via a single API.
 * Implements the IModelProvider contract for use with the Agent Core.
 */

const DEFAULT_OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'anthropic/claude-3.5-sonnet';

/** List available models from OpenRouter. */
async function listModels(apiKey) {
  if (!apiKey) return getDefaultModels();
  try {
    const res = await fetch(`${DEFAULT_OPENROUTER_URL}/models`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) return getDefaultModels();
    const data = await res.json();
    return (data.data || [])
      .filter(m => m.id && m.architecture?.modality === 'text')
      .map(m => m.id)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return getDefaultModels();
  }
}

function getDefaultModels() {
  return [
    'anthropic/claude-3.5-sonnet',
    'anthropic/claude-3.5-haiku',
    'anthropic/claude-3-opus',
    'openai/gpt-4o',
    'openai/gpt-4o-mini',
    'openai/o1-preview',
    'openai/o1-mini',
    'google/gemini-pro-1.5',
    'google/gemini-flash-1.5',
    'meta-llama/llama-3.1-405b-instruct',
    'meta-llama/llama-3.1-70b-instruct',
    'mistralai/mistral-large',
    'cohere/command-r-plus',
  ];
}

/** Model details for the picker UI. */
async function listModelDetails(apiKey) {
  if (!apiKey) {
    const models = getDefaultModels();
    return models.map(name => ({ name, size: null, parameterSize: null, family: getFamily(name), quantization: null, capabilities: getCapabilities(name), modifiedAt: null }));
  }
  try {
    const res = await fetch(`${DEFAULT_OPENROUTER_URL}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!res.ok) return listModelDetails(null);
    const data = await res.json();
    return (data.data || [])
      .filter(m => m.id && m.architecture?.modality === 'text')
      .map(m => ({
        name: m.id,
        size: null,
        parameterSize: m.architecture?.parameter_count || null,
        family: getFamily(m.id),
        quantization: m.architecture?.quantization || null,
        capabilities: getCapabilities(m.id, m),
        modifiedAt: m.created ? new Date(m.created * 1000).toISOString() : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return listModelDetails(null);
  }
}

function getFamily(name) {
  if (name.startsWith('anthropic/')) return 'claude';
  if (name.startsWith('openai/')) return name.includes('o1') ? 'o1' : 'gpt';
  if (name.startsWith('google/')) return 'gemini';
  if (name.startsWith('meta-llama/')) return 'llama';
  if (name.startsWith('mistralai/')) return 'mistral';
  if (name.startsWith('cohere/')) return 'command';
  return 'unknown';
}

function getCapabilities(name, modelInfo = {}) {
  const caps = ['tools'];
  const ctx = modelInfo.architecture?.context_length;
  if (ctx && ctx >= 100000) caps.push('vision');
  if (name.includes('o1') || name.includes('claude-3.5') || name.includes('opus')) caps.push('thinking');
  return caps;
}

/** Check API reachability. */
async function health(apiKey) {
  if (!apiKey) return { reachable: false, error: 'No API key configured.' };
  try {
    const res = await fetch(`${DEFAULT_OPENROUTER_URL}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (res.ok) {
      return { reachable: true, models: await listModels(apiKey) };
    }
    const body = await res.text().catch(() => '');
    return { reachable: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  } catch (e) {
    return { reachable: false, error: e.message };
  }
}

/** Model capabilities. */
async function modelCapabilities(apiKey) {
  const models = await listModels(apiKey);
  const map = {};
  for (const name of models) {
    map[name] = new Set(getCapabilities(name));
  }
  return map;
}

/** Show model details. */
async function showModel(name, apiKey) {
  const details = await listModelDetails(apiKey);
  const model = details.find(m => m.name === name);
  if (!model) throw new Error(`Model ${name} not found.`);
  const caps = model.capabilities;
  return {
    name,
    contextLength: model.parameterSize ? 128000 : 32768,
    capabilities: caps,
    tools: caps.includes('tools'),
    thinking: caps.includes('thinking'),
    vision: caps.includes('vision'),
    family: model.family,
    parameterSize: model.parameterSize,
    quantization: model.quantization,
    size: model.size,
  };
}

/** Non-streaming chat completion (OpenAI-compatible). */
async function chat({ model, messages, tools, think, signal, apiKey }) {
  const payload = {
    model,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    })),
    ...(tools && tools.length ? { tools } : {}),
    max_tokens: 8192,
  };

  const res = await fetch(`${DEFAULT_OPENROUTER_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://local-code-agent.dev',
      'X-Title': 'Local Code Agent',
    },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenRouter API error (${res.status}): ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error('No response from OpenRouter');

  const msg = choice.message || {};
  return {
    role: 'assistant',
    content: msg.content || '',
    tool_calls: msg.tool_calls?.map(tc => ({
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    })),
  };
}

/** Streaming chat completion (OpenAI-compatible). */
async function chatStream({ model, messages, tools, think, onDelta, signal, apiKey }) {
  const payload = {
    model,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    })),
    stream: true,
    ...(tools && tools.length ? { tools } : {}),
    max_tokens: 8192,
  };

  const res = await fetch(`${DEFAULT_OPENROUTER_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://local-code-agent.dev',
      'X-Title': 'Local Code Agent',
    },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenRouter API error (${res.status}): ${body.slice(0, 500)}`);
  }

  let content = '';
  let toolCalls = [];
  let streamedContent = false;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line || !line.startsWith('data: ')) continue;
      if (line === 'data: [DONE]') break;

      try {
        const event = JSON.parse(line.slice(6));
        const delta = event.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          content += delta.content;
          if (!streamedContent) streamedContent = true;
          onDelta({ type: 'assistant', content: delta.content });
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) toolCalls[idx] = { function: { name: '', arguments: '' } };
            if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  return {
    streamedContent,
    message: {
      role: 'assistant',
      content,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    },
  };
}

module.exports = {
  DEFAULT_OPENROUTER_URL,
  DEFAULT_MODEL,
  listModels,
  listModelDetails,
  health,
  modelCapabilities,
  showModel,
  chat,
  chatStream,
};