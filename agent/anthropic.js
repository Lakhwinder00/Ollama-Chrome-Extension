/**
 * Anthropic (Claude) API client.
 * Implements the IModelProvider contract for use with the Agent Core.
 */

const DEFAULT_ANTHROPIC_URL = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-3-5-sonnet-20241022';
const ANTHROPIC_VERSION = '2023-06-01';

/** List available models (static list since Anthropic doesn't have a list endpoint). */
async function listModels() {
  return [
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022',
    'claude-3-opus-20240229',
    'claude-3-sonnet-20240229',
    'claude-3-haiku-20240307',
  ];
}

/** Model details for the picker UI. */
async function listModelDetails() {
  const models = await listModels();
  return models.map(name => ({
    name,
    size: null,
    parameterSize: null,
    family: 'claude',
    quantization: null,
    capabilities: ['tools', 'thinking', 'vision'],
    modifiedAt: null,
  }));
}

/** Check API reachability. */
async function health(apiKey) {
  if (!apiKey) return { reachable: false, error: 'No API key configured.' };
  try {
    const res = await fetch(`${DEFAULT_ANTHROPIC_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    if (res.ok || res.status === 400) {
      return { reachable: true, models: await listModels() };
    }
    const body = await res.text().catch(() => '');
    return { reachable: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  } catch (e) {
    return { reachable: false, error: e.message };
  }
}

/** Model capabilities (all Anthropic models support tools, thinking, vision). */
async function modelCapabilities() {
  const models = await listModels();
  const map = {};
  for (const name of models) {
    map[name] = new Set(['tools', 'thinking', 'vision']);
  }
  return map;
}

/** Show model details. */
async function showModel(name) {
  const details = await listModelDetails();
  const model = details.find(m => m.name === name);
  if (!model) throw new Error(`Model ${name} not found.`);
  return {
    name,
    contextLength: 200000,
    capabilities: model.capabilities,
    tools: true,
    thinking: true,
    vision: true,
    family: model.family,
    parameterSize: model.parameterSize,
    quantization: model.quantization,
    size: model.size,
  };
}

/** Convert messages to Anthropic format. */
function toAnthropicMessages(messages) {
  const systemMessages = messages.filter(m => m.role === 'system');
  const userAssistantMessages = messages.filter(m => m.role !== 'system');

  let system = '';
  if (systemMessages.length) {
    system = systemMessages.map(m => m.content).join('\n\n');
  }

  const messagesOut = userAssistantMessages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));

  // Ensure at least one user message
  if (!messagesOut.some(m => m.role === 'user')) {
    messagesOut.push({ role: 'user', content: 'Continue.' });
  }

  return { system, messages: messagesOut };
}

/** Convert tools to Anthropic format. */
function toAnthropicTools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: t.function.parameters || { type: 'object', properties: {} },
  }));
}

/** Non-streaming chat completion. */
async function chat({ model, messages, tools, think, signal, apiKey }) {
  const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
  const payload = {
    model,
    max_tokens: 8192,
    messages: anthropicMessages,
    ...(system ? { system } : {}),
    ...(tools && tools.length ? { tools: toAnthropicTools(tools) } : {}),
    ...(think ? { thinking: { type: 'enabled', budget_tokens: 2048 } } : {}),
  };

  const res = await fetch(`${DEFAULT_ANTHROPIC_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API error (${res.status}): ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  let content = '';
  let toolCalls = [];
  let thinking = '';

  for (const block of data.content || []) {
    if (block.type === 'text') content += block.text;
    else if (block.type === 'thinking') thinking += block.thinking;
    else if (block.type === 'tool_use') {
      toolCalls.push({
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  return {
    role: 'assistant',
    content,
    thinking,
    tool_calls: toolCalls.length ? toolCalls : undefined,
  };
}

/** Streaming chat completion. */
async function chatStream({ model, messages, tools, think, onDelta, signal, apiKey }) {
  const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
  const payload = {
    model,
    max_tokens: 8192,
    messages: anthropicMessages,
    stream: true,
    ...(system ? { system } : {}),
    ...(tools && tools.length ? { tools: toAnthropicTools(tools) } : {}),
    ...(think ? { thinking: { type: 'enabled', budget_tokens: 2048 } } : {}),
  };

  const res = await fetch(`${DEFAULT_ANTHROPIC_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API error (${res.status}): ${body.slice(0, 500)}`);
  }

  let content = '';
  let thinking = '';
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

      try {
        const event = JSON.parse(line.slice(6));
        switch (event.type) {
          case 'content_block_start':
            if (event.content_block?.type === 'tool_use') {
              currentToolCall = {
                function: {
                  name: event.content_block.name,
                  arguments: '',
                },
              };
              toolCalls.push(currentToolCall);
            }
            break;
          case 'content_block_delta':
            if (event.delta?.type === 'text_delta') {
              content += event.delta.text;
              if (!streamedContent) {
                streamedContent = true;
              }
              onDelta({ type: 'assistant', content: event.delta.text });
            } else if (event.delta?.type === 'thinking_delta') {
              thinking += event.delta.thinking;
              onDelta({ type: 'thinking', content: event.delta.thinking });
            } else if (event.delta?.type === 'input_json_delta' && currentToolCall) {
              currentToolCall.function.arguments += event.delta.partial_json;
            }
            break;
          case 'content_block_stop':
            currentToolCall = null;
            break;
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
      thinking,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    },
  };
}

module.exports = {
  DEFAULT_ANTHROPIC_URL,
  DEFAULT_MODEL,
  ANTHROPIC_VERSION,
  listModels,
  listModelDetails,
  health,
  modelCapabilities,
  showModel,
  chat,
  chatStream,
  toAnthropicMessages,
  toAnthropicTools,
};