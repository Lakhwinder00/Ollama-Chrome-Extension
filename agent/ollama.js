/**
 * Minimal client for the local Ollama HTTP API.
 * Ollama listens on http://127.0.0.1:11434 by default.
 */

const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

/**
 * Context window sent with each request. Ollama's default (4096) is too small
 * for an agent: when the prompt overflows, the server silently drops the
 * oldest messages — often the user's question — and the qwen renderers then
 * reject the request with 500 "no user query found in messages". A larger
 * num_ctx keeps the whole transcript (system prompt + tools + history).
 */
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 8192;

/**
 * Shape the message list the way Ollama's renderers require: exactly one
 * leading system message and at least one user turn anywhere in the history
 * (tool-loop continuations alone are rejected with 500).
 */
function prepareMessages(messages) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && typeof m === 'object');
  const systems = list.filter((m) => m.role === 'system');
  const rest = list.filter((m) => m.role !== 'system');
  const out = [...systems.slice(0, 1), ...rest];
  if (!out.some((m) => m.role === 'user')) {
    out.push({ role: 'user', content: 'Continue from the results above and answer the original request.' });
  }
  return out;
}

async function ollamaFetch(pathname, options = {}) {
  const res = await fetch(DEFAULT_OLLAMA_URL + pathname, options);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Ollama ${pathname} failed (${res.status} ${res.statusText}): ${body.slice(0, 500)}`
    );
  }
  return res;
}

/** List installed models. */
async function listModels() {
  const res = await ollamaFetch('/api/tags');
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

/**
 * Normalize Ollama /api/tags model entries into picker-friendly details:
 * name, disk size, parameter count, family, quantization, and capabilities.
 */
function mapModelDetails(models) {
  return (Array.isArray(models) ? models : []).map((m) => ({
    name: m.name,
    size: typeof m.size === 'number' ? m.size : null,
    parameterSize: (m.details && m.details.parameter_size) || null,
    family: (m.details && m.details.family) || null,
    quantization: (m.details && m.details.quantization_level) || null,
    capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
    modifiedAt: m.modified_at || null,
  }));
}

/** Details for every installed model (what the extension's picker shows). */
async function listModelDetails() {
  const res = await ollamaFetch('/api/tags');
  const data = await res.json();
  return mapModelDetails(data.models || []);
}

/** Check whether Ollama is reachable and which models are installed. */
async function health() {
  try {
    const res = await ollamaFetch('/api/tags');
    const data = await res.json();
    return { reachable: true, models: (data.models || []).map((m) => m.name) };
  } catch (e) {
    return { reachable: false, error: e.message };
  }
}

/**
 * One non-streaming chat completion.
 * `tools` is the Ollama tools array (OpenAI-style function definitions).
 */
async function chat({ model, messages, tools, think = false, signal }) {
  const payload = { model, messages: prepareMessages(messages), stream: false, options: { num_ctx: NUM_CTX } };
  if (tools && tools.length) payload.tools = tools;
  if (think) payload.think = true;
  const res = await ollamaFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });
  return res.json();
}

/** Map of model name -> Set of capabilities (e.g. 'thinking', 'tools'). */
async function modelCapabilities() {
  const res = await ollamaFetch('/api/tags');
  const data = await res.json();
  const map = {};
  for (const m of data.models || []) {
    map[m.name] = new Set(m.capabilities || []);
  }
  return map;
}

module.exports = {
  DEFAULT_OLLAMA_URL,
  NUM_CTX,
  prepareMessages,
  listModels,
  listModelDetails,
  mapModelDetails,
  health,
  chat,
  chatStream,
  modelCapabilities,
};

/** Strip special tokens some models leak into their visible output. */
function sanitizeText(text) {
  if (!text) return text;
  return String(text)
    .replace(/<\|channel>thought/gi, '')
    .replace(/<\|channel>final/gi, '')
    .replace(/<\|channel>/gi, '')
    .replace(/<\|thinking\|>/gi, '')
    .replace(/<\|im_start\|>/gi, '')
    .replace(/<\|im_end\|>/gi, '')
    .replace(/<\|endoftext\|>/gi, '');
}

/** Accumulate streaming tool-call chunks into `acc` (arguments are appended). */
function mergeToolCalls(acc, chunkCalls) {
  for (const tc of chunkCalls || []) {
    const fn = tc.function || {};
    const idx = typeof tc.index === 'number' ? tc.index : acc.length;
    if (!acc[idx]) acc[idx] = { function: { name: '', arguments: '' } };
    if (fn.name) acc[idx].function.name = fn.name;
    const args = fn.arguments;
    if (typeof args === 'string') acc[idx].function.arguments += args;
    else if (args && typeof args === 'object') acc[idx].function.arguments = JSON.stringify(args);
  }
}

/**
 * Streaming chat. Emits `thinking` deltas live and `assistant` content deltas
 * live (unless the content looks like a JSON tool call, which is buffered).
 * Returns the assembled message plus whether content was streamed.
 */
async function chatStream({ model, messages, tools, think = false, onDelta = () => {}, signal }) {
  const payload = { model, messages: prepareMessages(messages), stream: true, options: { num_ctx: NUM_CTX } };
  if (tools && tools.length) payload.tools = tools;
  if (think) payload.think = true;

  const res = await ollamaFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });

  let content = '';
  let thinking = '';
  let toolCalls = [];
  let streamedContent = false;
  let contentBuffered = false;

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
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const m = obj.message || {};

      if (m.thinking) {
        thinking += m.thinking;
        onDelta({ type: 'thinking', content: sanitizeText(m.thinking) });
      }

      if (m.content) {
        content += m.content;
        if (!contentBuffered) {
          const t = content.trimStart();
          if (t && (t[0] === '{' || t[0] === '[' || t[0] === '`')) {
            contentBuffered = true; // looks like a JSON tool call — don't stream
          } else if (t) {
            streamedContent = true;
            onDelta({ type: 'assistant', content: sanitizeText(m.content) });
          }
        }
      }

      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        if (obj.done) {
          toolCalls = m.tool_calls.map((tc) => ({
            function: {
              name: (tc.function && tc.function.name) || '',
              arguments:
                typeof tc.function.arguments === 'string'
                  ? tc.function.arguments
                  : JSON.stringify((tc.function && tc.function.arguments) || {}),
            },
          }));
        } else {
          mergeToolCalls(toolCalls, m.tool_calls);
        }
      }
    }
  }

  return {
    streamedContent,
    message: {
      role: 'assistant',
      content: sanitizeText(content),
      thinking: sanitizeText(thinking),
      tool_calls: toolCalls,
    },
  };
}
