/**
 * Google Gemini API client.
 * Implements the IModelProvider contract for use with the Agent Core.
 */

const DEFAULT_GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-1.5-pro';

/** List available models. */
async function listModels(apiKey) {
  if (!apiKey) return getDefaultModels();
  try {
    const res = await fetch(`${DEFAULT_GEMINI_URL}/models?key=${apiKey}`);
    if (!res.ok) return getDefaultModels();
    const data = await res.json();
    return (data.models || [])
      .filter(m => m.name && m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name.replace('models/', ''))
      .filter(name => /^gemini/.test(name))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return getDefaultModels();
  }
}

function getDefaultModels() {
  return [
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'gemini-1.5-pro-latest',
    'gemini-1.5-flash-latest',
    'gemini-1.0-pro',
  ];
}

/** Model details for the picker UI. */
async function listModelDetails(apiKey) {
  const models = await listModels(apiKey);
  return models.map(name => ({
    name,
    size: null,
    parameterSize: null,
    family: 'gemini',
    quantization: null,
    capabilities: getCapabilities(name),
    modifiedAt: null,
  }));
}

function getCapabilities(name) {
  const caps = ['tools'];
  if (name.includes('1.5')) caps.push('vision');
  return caps;
}

/** Check API reachability. */
async function health(apiKey) {
  if (!apiKey) return { reachable: false, error: 'No API key configured.' };
  try {
    const res = await fetch(`${DEFAULT_GEMINI_URL}/models?key=${apiKey}`);
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
    contextLength: name.includes('1.5') ? 1000000 : 32768,
    capabilities: caps,
    tools: caps.includes('tools'),
    thinking: false,
    vision: caps.includes('vision'),
    family: model.family,
    parameterSize: model.parameterSize,
    quantization: model.quantization,
    size: model.size,
  };
}

/** Convert messages to Gemini format. */
function toGeminiMessages(messages) {
  const systemMessages = messages.filter(m => m.role === 'system');
  const userAssistantMessages = messages.filter(m => m.role !== 'system');

  let systemInstruction = null;
  if (systemMessages.length) {
    systemInstruction = {
      parts: [{ text: systemMessages.map(m => m.content).join('\n\n') }],
    };
  }

  const contents = userAssistantMessages.map(m => {
    if (m.role === 'tool') {
      return {
        role: 'function',
        parts: [{ functionResponse: { name: m.name, response: { content: m.content } } }],
      };
    }
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    };
  });

  // Ensure at least one user message
  if (!contents.some(c => c.role === 'user')) {
    contents.push({ role: 'user', parts: [{ text: 'Continue.' }] });
  }

  return { systemInstruction, contents };
}

/** Convert tools to Gemini format. */
function toGeminiTools(tools) {
  if (!tools || !tools.length) return undefined;
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.function.name,
      description: t.function.description || '',
      parameters: t.function.parameters || { type: 'object', properties: {} },
    })),
  }];
}

/** Non-streaming chat completion. */
async function chat({ model, messages, tools, think, signal, apiKey }) {
  const { systemInstruction, contents } = toGeminiMessages(messages);
  const payload = {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(tools && tools.length ? { tools: toGeminiTools(tools) } : {}),
    generationConfig: {
      maxOutputTokens: 8192,
      temperature: 0.7,
    },
  };

  const url = `${DEFAULT_GEMINI_URL}/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini API error (${res.status}): ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  if (!candidate) throw new Error('No response from Gemini');

  let content = '';
  let toolCalls = [];

  for (const part of candidate.content?.parts || []) {
    if (part.text) content += part.text;
    if (part.functionCall) {
      toolCalls.push({
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args),
        },
      });
    }
  }

  return {
    role: 'assistant',
    content,
    tool_calls: toolCalls.length ? toolCalls : undefined,
  };
}

/** Streaming chat completion. */
async function chatStream({ model, messages, tools, think, onDelta, signal, apiKey }) {
  const { systemInstruction, contents } = toGeminiMessages(messages);
  const payload = {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(tools && tools.length ? { tools: toGeminiTools(tools) } : {}),
    generationConfig: {
      maxOutputTokens: 8192,
      temperature: 0.7,
    },
  };

  const url = `${DEFAULT_GEMINI_URL}/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini API error (${res.status}): ${body.slice(0, 500)}`);
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

      try {
        const event = JSON.parse(line.slice(6));
        const candidate = event.candidates?.[0];
        if (!candidate) continue;

        for (const part of candidate.content?.parts || []) {
          if (part.text) {
            content += part.text;
            if (!streamedContent) streamedContent = true;
            onDelta({ type: 'assistant', content: part.text });
          }
          if (part.functionCall) {
            toolCalls.push({
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args),
              },
            });
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
  DEFAULT_GEMINI_URL,
  DEFAULT_MODEL,
  listModels,
  listModelDetails,
  health,
  modelCapabilities,
  showModel,
  chat,
  chatStream,
  toGeminiMessages,
  toGeminiTools,
};