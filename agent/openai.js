/**
 * OpenAI (ChatGPT) API client.
 * Implements the IModelProvider contract for use with the Agent Core.
 */

const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-2024-08-06';

/** List available models. */
async function listModels(apiKey) {
  if (!apiKey) return [];
  try {
    const res = await fetch(`${DEFAULT_OPENAI_URL}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!res.ok) return getDefaultModels();
    const data = await res.json();
    return (data.data || [])
      .filter(m => m.id && /^(gpt|o1)/.test(m.id))
      .map(m => m.id)
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return getDefaultModels();
  }
}

function getDefaultModels() {
  return [
    'gpt-4o-2024-08-06',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4-turbo',
    'gpt-4',
    'o1-preview',
    'o1-mini',
    'gpt-3.5-turbo',
  ];
}

/** Model details for the picker UI. */
async function listModelDetails(apiKey) {
  const models = await listModels(apiKey);
  return models.map(name => ({
    name,
    size: null,
    parameterSize: null,
    family: name.startsWith('o1') ? 'o1' : 'gpt',
    quantization: null,
    capabilities: getCapabilities(name),
    modifiedAt: null,
  }));
}

function getCapabilities(name) {
  const caps = ['tools'];
  if (name.startsWith('o1') || name.includes('4o')) caps.push('vision');
  if (name.startsWith('o1')) caps.push('thinking');
  return caps;
}

/** Check API reachability. */
async function health(apiKey) {
  if (!apiKey) return { reachable: false, error: 'No API key configured.' };
  try {
    const res = await fetch(`${DEFAULT_OPENAI_URL}/models`, {
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
    contextLength: name.startsWith('o1') ? 128000 : name.includes('4o') ? 128000 : 8192,
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

/** Non-streaming chat completion. */
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
    ...(think && !model.startsWith('o1') ? { reasoning_effort: 'medium' } : {}),
  };

  const res = await fetch(`${DEFAULT_OPENAI_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI API error (${res.status}): ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error('No response from OpenAI');

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

/** Streaming chat completion. */
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
    ...(think && !model.startsWith('o1') ? { reasoning_effort: 'medium' } : {}),
  };

  const res = await fetch(`${DEFAULT_OPENAI_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI API error (${res.status}): ${body.slice(0, 500)}`);
  }

  let content = '';
  let toolCalls = [];
  let streamedContent = false;
  let currentToolCall = null;

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
  DEFAULT_OPENAI_URL,
  DEFAULT_MODEL,
  listModels,
  listModelDetails,
  health,
  modelCapabilities,
  showModel,
  chat,
  chatStream,
};