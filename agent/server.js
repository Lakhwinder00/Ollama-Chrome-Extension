/**
 * Local Code Agent Server
 *
 *   Chrome Extension  ──►  this server (:8787)  ──►  Ollama (:11434)
 *                                     │
 *                                     └─► project files / shell
 *
 * Zero external dependencies — runs on Node 18+.
 */

const http = require('http');
const { URL } = require('url');
const {
  OllamaProvider,
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  OpenRouterProvider,
  createProvider,
  getProviderInfo,
  getProviderNames,
} = require('./provider');
const { loadAlwaysAllowed, allowAlways } = require('./permissions');
const {
  setProjectRoot,
  getProjectRoot,
  TOOL_DEFINITIONS,
  setSearchProvider,
  indexProject,
  getProjectIndex,
} = require('./tools');
const { runAgent } = require('./agent');
const { routeScope, pickTools, buildScopePrompt } = require('./scope');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';

// Provider management
const providers = new Map();
function getProvider(name) {
  if (!providers.has(name)) {
    let options = {};
    if (name === 'opencode') {
      options = { opencodeUrl, opencodeAuth };
    }
    providers.set(name, createProvider(name, options));
  }
  return providers.get(name);
}

// Default provider (backward compatibility)
const defaultProvider = new OllamaProvider();
const DEFAULT_MODEL = defaultProvider.defaultModel;

let capabilitiesCache = new Map();

async function getCapabilities(provider) {
  if (!capabilitiesCache.has(provider.name)) {
    try {
      capabilitiesCache.set(provider.name, await provider.modelCapabilities());
    } catch {
      capabilitiesCache.set(provider.name, {});
    }
  }
  return capabilitiesCache.get(provider.name);
}

// ---------------------------------------------------------------------------
// Sessions: keep the full conversation (including tool results) so a chat can
// continue across requests, exactly like a terminal coding agent.
// ---------------------------------------------------------------------------
const sessions = new Map();

function ensureSession(sessionId) {
  if (sessionId && sessions.has(sessionId)) return sessions.get(sessionId);
  const id =
    sessionId || `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const session = { id, model: DEFAULT_MODEL, messages: [], approvedTools: new Set() };
  sessions.set(id, session);
  return session;
}

// Active chat runs (sessionId -> AbortController) so /stop can cancel them.
const activeRuns = new Map();

// Provider API key storage (in-memory, persisted via /providers endpoints)
const providerApiKeys = new Map();

// OpenCode configuration
let opencodeUrl = process.env.OPENCODE_URL || 'http://127.0.0.1:4096';
let opencodeAuth = null; // { type: 'basic', password } or { type: 'bearer', token }

// Session provider mapping
const sessionProviders = new Map();

function getSessionProvider(session) {
  const providerName = sessionProviders.get(session.id) || 'ollama';
  const provider = getProvider(providerName);
  const apiKey = providerApiKeys.get(providerName);
  if (apiKey && provider.setApiKey) {
    provider.setApiKey(apiKey);
  }
  return provider;
}

// ---------------------------------------------------------------------------
// Approvals: the agent pauses and asks the user before write_file / run_command.
// ---------------------------------------------------------------------------
const pendingApprovals = new Map();
let approvalSeq = 0;

function requestApprovalFactory(emit, session) {
  return (name, args) =>
    new Promise((resolve) => {
      const id = `a${++approvalSeq}`;
      const timer = setTimeout(() => {
        pendingApprovals.delete(id);
        resolve({ allowed: false });
      }, 5 * 60 * 1000);
      pendingApprovals.set(id, { resolve, timer, name, session });
      emit('approve_request', { id, name, arguments: args });
    });
}

// ---------------------------------------------------------------------------
// Browser tools: the agent asks the extension (via SSE) to run a tool in the
// active tab; the extension posts the result back to /browser/result.
// ---------------------------------------------------------------------------
const pendingBrowsers = new Map();
let browserSeq = 0;

function requestBrowserFactory(emit) {
  return (name, args) =>
    new Promise((resolve, reject) => {
      const id = `b${++browserSeq}`;
      const timer = setTimeout(() => {
        pendingBrowsers.delete(id);
        reject(new Error(`Browser tool "${name}" timed out. Keep the extension popup open.`));
      }, 60 * 1000);
      pendingBrowsers.set(id, { resolve, reject, timer });
      emit('browser_request', { id, name, arguments: args });
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...CORS,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 20 * 1024 * 1024) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
async function handleProject(req, res) {
  const body = await readJson(req);
  try {
    setProjectRoot(body.root);
    // Kick off the lightweight scan that drives the extension's connection
    // pill ("Indexing" → "Connected (N files)"). Failures stay in the status
    // object; they never fail the connect itself.
    indexProject().catch(() => {});
    sendJson(res, 200, { ok: true, ...getProjectIndex() });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message });
  }
}

async function handleProjectIndex(req, res) {
  try {
    if (!getProjectRoot()) {
      sendJson(res, 400, { ok: false, error: 'No project connected. POST /project first.' });
      return;
    }
    // Respond immediately; the client polls GET /project for progress.
    indexProject().catch(() => {});
    sendJson(res, 200, { ok: true, ...getProjectIndex() });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

async function handleModelInfo(req, res, url) {
  const name = url.searchParams.get('name');
  const providerName = url.searchParams.get('provider') || 'ollama';
  if (!name) {
    sendJson(res, 400, { ok: false, error: 'Missing ?name= query parameter.' });
    return;
  }
  const provider = getProvider(providerName);
  const apiKey = providerApiKeys.get(providerName);
  if (apiKey && provider.setApiKey) provider.setApiKey(apiKey);
  
  let info = null;
  try {
    info = await provider.showModel(name);
  } catch {
    info = null;
  }
  const caps = await getCapabilities(provider);
  const capSet = caps[name];
  const capabilities = info && info.capabilities.length ? info.capabilities : capSet ? [...capSet] : [];
  const capabilitiesKnown = capabilities.length > 0;
  sendJson(res, 200, {
    ok: true,
    name,
    provider: providerName,
    contextLength: info ? info.contextLength : null,
    capabilities,
    tools: capabilities.includes('tools') ? true : capabilitiesKnown ? false : null,
    thinking: capabilities.includes('thinking') ? true : capabilitiesKnown ? false : null,
    vision: capabilities.includes('vision') ? true : capabilitiesKnown ? false : null,
    family: info ? info.family : null,
    parameterSize: info ? info.parameterSize : null,
    quantization: info ? info.quantization : null,
    size: info ? info.size : null,
  });
}

async function handleChat(req, res) {
  const body = await readJson(req);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...CORS,
  });

  let closed = false;
  req.on('close', () => {
    closed = true;
  });
  const emit = (event, data) => {
    if (closed || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const session = ensureSession(body.sessionId);
  if (body.model) session.model = body.model;
  if (body.provider) sessionProviders.set(session.id, body.provider);
  if (body.searchProvider) setSearchProvider(body.searchProvider);

  const provider = getSessionProvider(session);

  const userMessage =
    typeof body.message === 'string' && body.message.trim() ? body.message : null;
  if (!userMessage) {
    emit('error', { message: 'No message provided.' });
    res.end();
    return;
  }

  // Regenerate: the client rewinds the transcript and sends the history it
  // wants the retry conditioned on, so the old answer is not part of the
  // context for the replacement.
  if (Array.isArray(body.messages)) {
    session.messages = body.messages.filter(
      (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
    );
  }

  session.messages.push({ role: 'user', content: userMessage });

  const caps = await getCapabilities(provider);
  const think = !!(caps[session.model] && caps[session.model].has('thinking'));
  const vision = !!(caps[session.model] && caps[session.model].has('vision'));

  // Two-scope routing: decide whether this is a current-page task or research
  const currentPageOnly = body.currentPageOnly !== false; // default ON
  const pageInfo = body.pageInfo || null;
  let scope = 'research';
  if (currentPageOnly && pageInfo) {
    try {
      scope = await routeScope(userMessage, pageInfo, true);
    } catch {
      scope = 'research';
    }
  }
  emit('scope', { scope, pageInfo: pageInfo ? { title: pageInfo.title, url: pageInfo.url } : null });

  // Honest tool support: gate on what the provider reports for this model, never on
  // the model's name. `null` means the install is too old to report
  // capabilities at all — then we send the tools and let the provider decide.
  const modelCaps = caps[session.model];
  const capabilitiesKnown = Object.values(caps).some((s) => s && s.size > 0);
  const toolsSupported = capabilitiesKnown ? !!(modelCaps && modelCaps.has('tools')) : null;

  // "Find best link" is optional: some models get lost in ranked lists, so
  // the client can turn it off and keep the plain web_search tool only.
  let tools = TOOL_DEFINITIONS;
  if (body.findBestLink === false) {
    tools = tools.filter((t) => t && t.function && t.function.name !== 'find_best_link');
  }
  if (toolsSupported === false) tools = [];

  // Restrict tools by scope
  tools = pickTools(tools, scope);

  const ac = new AbortController();
  activeRuns.set(session.id, ac);

  try {
    emit('start', {
      sessionId: session.id,
      model: session.model,
      provider: provider.name,
      project: getProjectRoot(),
      tools: tools.length ? toolsSupported : false,
      scope,
    });
    const result = await runAgent({
      model: session.model,
      messages: session.messages,
      tools,
      scope,
      scopePrompt: buildScopePrompt(scope, pageInfo, body.mode || 'auto', userMessage),
      autoApprove: !!body.autoApprove,
      think,
      vision,
      planFirst: !think,
      requestApproval: requestApprovalFactory(emit, session),
      requestBrowser: requestBrowserFactory(emit),
      signal: ac.signal,
      provider,
      preApproved: [...new Set([...loadAlwaysAllowed(), ...session.approvedTools])],
      onEvent: (payload) => emit(payload && payload.type, payload),
    });
    session.messages = result.history;
    if (result.stopped) emit('stopped', { sessionId: session.id });
    else emit('done', { sessionId: session.id });
  } catch (e) {
    emit('error', { message: String((e && e.message) || e) });
  } finally {
    activeRuns.delete(session.id);
    if (!closed && !res.destroyed) res.end();
  }
}

async function handleApprove(req, res) {
  const body = await readJson(req);
  const pending = pendingApprovals.get(body.id);
  if (!pending) {
    sendJson(res, 404, { ok: false, error: 'No pending approval with that id (it may have timed out).' });
    return;
  }
  clearTimeout(pending.timer);
  pendingApprovals.delete(body.id);
  const allowed = !!body.allowed;
  const scope = typeof body.scope === 'string' ? body.scope : 'once';
  if (allowed) {
    if (scope === 'always') {
      allowAlways(pending.name);
      pending.session.approvedTools.add(pending.name);
    } else if (scope === 'session') {
      pending.session.approvedTools.add(pending.name);
    }
  }
  pending.resolve({ allowed, scope });
  sendJson(res, 200, { ok: true, approved: allowed });
}

async function handleBrowserResult(req, res) {
  const body = await readJson(req);
  const pending = pendingBrowsers.get(body.id);
  if (!pending) {
    sendJson(res, 404, { ok: false, error: 'No pending browser request with that id (it may have timed out).' });
    return;
  }
  clearTimeout(pending.timer);
  pendingBrowsers.delete(body.id);
  if (body.error) pending.reject(new Error(body.error));
  else pending.resolve(body.result);
  sendJson(res, 200, { ok: true });
}

async function handleStop(req, res) {
  const body = await readJson(req);
  const ac = activeRuns.get(body.sessionId);
  if (ac) ac.abort();
  sendJson(res, 200, { ok: true, stopped: !!ac });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function route(req, res, pathname) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const providerName = url.searchParams.get('provider') || 'ollama';
    const p = getProvider(providerName);
    const apiKey = providerApiKeys.get(providerName);
    if (apiKey && p.setApiKey) p.setApiKey(apiKey);
    const h = await p.health();
    const project = getProjectIndex();
    sendJson(res, 200, {
      ok: h.reachable,
      provider: providerName,
      endpoint: p.endpoint,
      ...h,
      project: getProjectRoot(),
      projectStatus: project.status,
      projectFiles: project.fileCount,
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/models') {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const providerName = url.searchParams.get('provider') || 'ollama';
    const p = getProvider(providerName);
    const apiKey = providerApiKeys.get(providerName);
    if (apiKey && p.setApiKey) p.setApiKey(apiKey);
    try {
      let details = [];
      try {
        details = await p.listModelDetails();
      } catch {
        details = []; // older providers may not expose details
      }
      const models = details.length ? details.map((d) => d.name) : await p.listModels();
      capabilitiesCache.delete(p.name); // re-read capabilities on next chat
      sendJson(res, 200, { ok: true, provider: providerName, models, details });
    } catch (e) {
      sendJson(res, 502, { ok: false, error: e.message });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/model_info') {
    await handleModelInfo(req, res, new URL(req.url, `http://${req.headers.host || 'localhost'}`));
    return;
  }

  if (req.method === 'GET' && pathname === '/project') {
    sendJson(res, 200, { ok: true, ...getProjectIndex() });
    return;
  }

  // Provider endpoints
  if (req.method === 'GET' && pathname === '/providers') {
    const info = getProviderInfo().map(p => ({
      ...p,
      hasApiKey: !!providerApiKeys.get(p.id),
    }));
    sendJson(res, 200, { ok: true, providers: info });
    return;
  }

  if (req.method === 'POST' && pathname === '/providers/api-key') {
    const body = await readJson(req);
    const { provider, apiKey } = body;
    if (!provider || !apiKey) {
      sendJson(res, 400, { ok: false, error: 'Missing provider or apiKey.' });
      return;
    }
    const p = getProvider(provider);
    if (p.setApiKey) {
      p.setApiKey(apiKey);
      providerApiKeys.set(provider, apiKey);
      // Test the key
      const health = await p.health();
      sendJson(res, 200, { ok: true, ...health });
    } else {
      sendJson(res, 400, { ok: false, error: 'Provider does not support API keys.' });
    }
    return;
  }

  if (req.method === 'DELETE' && pathname === '/providers/api-key') {
    const body = await readJson(req);
    const { provider } = body;
    if (!provider) {
      sendJson(res, 400, { ok: false, error: 'Missing provider.' });
      return;
    }
    const p = getProvider(provider);
    if (p.setApiKey) {
      p.setApiKey(null);
      providerApiKeys.delete(provider);
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 400, { ok: false, error: 'Provider does not support API keys.' });
    }
    return;
  }

  // OpenCode URL endpoint
  if (req.method === 'POST' && pathname === '/providers/opencode-url') {
    const body = await readJson(req);
    const { url } = body;
    if (!url) {
      sendJson(res, 400, { ok: false, error: 'Missing url.' });
      return;
    }
    opencodeUrl = url;
    // Update the provider if it exists
    if (providers.has('opencode')) {
      const p = providers.get('opencode');
      if (p && p.endpoint) {
        // Re-create the provider with new URL
        providers.delete('opencode');
      }
    }
    sendJson(res, 200, { ok: true, url: opencodeUrl });
    return;
  }

  if (req.method === 'GET' && pathname === '/providers/opencode-url') {
    sendJson(res, 200, { ok: true, url: opencodeUrl });
    return;
  }

  // OpenCode auth endpoint
  if (req.method === 'POST' && pathname === '/providers/opencode-auth') {
    const body = await readJson(req);
    const { auth } = body;
    // Allow null to clear auth
    if (auth === null || auth === undefined) {
      opencodeAuth = null;
      if (providers.has('opencode')) {
        providers.delete('opencode');
      }
      sendJson(res, 200, { ok: true, auth: null });
      return;
    }
    if (!auth.type || (auth.type !== 'basic' && auth.type !== 'bearer')) {
      sendJson(res, 400, { ok: false, error: 'Missing or invalid auth. Expected { type: "basic", password } or { type: "bearer", token }' });
      return;
    }
    if (auth.type === 'basic' && !auth.password) {
      sendJson(res, 400, { ok: false, error: 'Missing password for basic auth' });
      return;
    }
    if (auth.type === 'bearer' && !auth.token) {
      sendJson(res, 400, { ok: false, error: 'Missing token for bearer auth' });
      return;
    }
    opencodeAuth = auth;
    // Re-create the provider with new auth
    if (providers.has('opencode')) {
      providers.delete('opencode');
    }
    sendJson(res, 200, { ok: true, auth: { type: auth.type } });
    return;
  }

  if (req.method === 'GET' && pathname === '/providers/opencode-auth') {
    sendJson(res, 200, { ok: true, auth: opencodeAuth ? { type: opencodeAuth.type } : null });
    return;
  }

  if (req.method === 'GET' && pathname === '/providers/models') {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const providerName = url.searchParams.get('provider') || 'ollama';
    const provider = getProvider(providerName);
    const apiKey = providerApiKeys.get(providerName);
    if (apiKey && provider.setApiKey) provider.setApiKey(apiKey);
    try {
      let details = [];
      try {
        details = await provider.listModelDetails();
      } catch {
        details = [];
      }
      const models = details.length ? details.map((d) => d.name) : await provider.listModels();
      capabilitiesCache.delete(provider.name); // re-read capabilities on next chat
      sendJson(res, 200, { ok: true, provider: providerName, models, details });
    } catch (e) {
      sendJson(res, 502, { ok: false, error: e.message });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/project') {
    await handleProject(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/project/index') {
    await handleProjectIndex(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/chat') {
    await handleChat(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/approve') {
    await handleApprove(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/browser/result') {
    await handleBrowserResult(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/stop') {
    await handleStop(req, res);
    return;
  }

  if (req.method === 'GET' && pathname === '/') {
    sendJson(res, 200, {
      name: 'Local Code Agent Server',
      endpoints: [
        'GET  /health',
        'GET  /models',
        'GET  /model_info?name=<model>',
        'GET  /project',
        'POST /project       { root }',
        'POST /project/index',
        'POST /chat      { sessionId?, message, model?, autoApprove?, messages?, searchProvider?, findBestLink? }  (Server-Sent Events)',
        'POST /approve   { id, allowed, scope? }   scope: once|session|always',
        'POST /browser/result { id, result | error }',
        'POST /stop      { sessionId }',
      ],
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found.' });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    await route(req, res, pathname);
  } catch (e) {
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Local Code Agent Server');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  Listening on  http://${HOST}:${PORT}`);
  console.log(`  Default provider: Ollama`);
  console.log(`  Endpoint        ${defaultProvider.endpoint}`);
  console.log(`  Default model   ${DEFAULT_MODEL}`);
  console.log(`  Available providers: ${getProviderNames().join(', ')}`);
  console.log(`  Project root    ${getProjectRoot() || '(not set — use POST /project)'}`);
  console.log('');
});
