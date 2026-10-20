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
const fs = require('fs');
const path = require('path');
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
const { isOriginAllowed, corsHeadersFor, isLoopbackHost } = require('./http-security');
const {
  loadStore,
  setApiKey,
  clearApiKey,
  getOpencodeAuth,
  setOpencodeAuth,
} = require('./secrets');
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

// Sessions live in memory only. They are dropped after two hours of silence
// and the total is capped, so a long-running server cannot grow without bound.
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 50;

function ensureSession(sessionId) {
  pruneSessions();
  if (sessionId && sessions.has(sessionId)) {
    const existing = sessions.get(sessionId);
    existing.lastUsed = Date.now();
    return existing;
  }
  const id =
    sessionId || `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const session = {
    id,
    model: DEFAULT_MODEL,
    messages: [],
    approvedTools: new Set(),
    lastUsed: Date.now(),
  };
  sessions.set(id, session);
  return session;
}

/** Forget expired sessions and evict the oldest ones past the cap. */
function pruneSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - (s.lastUsed || 0) > SESSION_TTL_MS) {
      sessions.delete(id);
      sessionProviders.delete(id);
    }
  }
  while (sessions.size > MAX_SESSIONS) {
    let oldestId = null;
    let oldest = Infinity;
    for (const [id, s] of sessions) {
      if ((s.lastUsed || 0) < oldest) {
        oldest = s.lastUsed || 0;
        oldestId = id;
      }
    }
    if (!oldestId) break;
    sessions.delete(oldestId);
    sessionProviders.delete(oldestId);
  }
}

/** Drop a session and abort a run in flight ("New chat" / "Clear history"). */
function deleteSession(sessionId) {
  if (!sessionId) return false;
  const existed = sessions.delete(sessionId);
  sessionProviders.delete(sessionId);
  const ac = activeRuns.get(sessionId);
  if (ac) {
    ac.abort();
    activeRuns.delete(sessionId);
  }
  return existed;
}

// Active chat runs (sessionId -> AbortController) so /stop can cancel them.
const activeRuns = new Map();

// Provider API key storage. Persisted in ~/.myagent/providers.json so the keys
// survive a server restart instead of having to be re-typed every time.
const providerApiKeys = new Map(Object.entries(loadStore().apiKeys));

// OpenCode configuration
let opencodeUrl = process.env.OPENCODE_URL || 'http://127.0.0.1:4096';
let opencodeAuth = getOpencodeAuth(); // { type: 'basic', password } or { type: 'bearer', token }

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
// Attachments: a document sent by the user is stored in the project, so the
// agent can read the whole file with read_file instead of only the excerpt
// that travelled in the message.
// ---------------------------------------------------------------------------
const MAX_IMAGES = 4;

/** Save the text of an attached document inside the project. */
function saveAttachment(name, text) {
  const root = getProjectRoot();
  if (!root || !text) return null;
  try {
    const dir = path.join(root, '.myagent', 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    const safe =
      String(name || 'attachment')
        .replace(/[^\w.\- ]+/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 80) || 'attachment';
    const file = path.join(dir, safe.toLowerCase().endsWith('.txt') ? safe : `${safe}.txt`);
    fs.writeFileSync(file, text, 'utf8');
    return path.relative(root, file).split(path.sep).join('/');
  } catch {
    return null;
  }
}

/**
 * Build the user turn: the request (the client already put the document text
 * in it), a pointer to the saved copies, and the pictures for a vision model.
 */
function buildUserTurn({ message, attachments, images, vision }) {
  const docs = (Array.isArray(attachments) ? attachments : [])
    .filter((a) => a && typeof a.text === 'string' && a.text.trim())
    .slice(0, 5);

  const saved = [];
  for (const doc of docs) {
    const rel = saveAttachment(doc.name, doc.text);
    if (rel) saved.push(`${doc.name} → ${rel}`);
  }

  const pictures = (Array.isArray(images) ? images : [])
    .filter((i) => typeof i === 'string' && /^data:image\//.test(i))
    .slice(0, MAX_IMAGES);

  let content = message;
  if (saved.length) {
    content +=
      `\n\n[The attached document(s) are also saved in the project: ${saved.join(', ')} — ` +
      'read them with read_file when you need more than the excerpt above.]';
  }
  if (pictures.length && !vision) {
    content +=
      '\n\n[An image was attached, but this model cannot look at images — describe what you need instead.]';
  }

  const turn = { role: 'user', content };
  if (pictures.length && vision) {
    // The data URL is kept: every provider strips what it does not need.
    turn.images = pictures;
  }
  return { turn, saved, pictureCount: pictures.length };
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
// CORS is per request (res.corsHeaders, set by the request handler): only the
// Chrome extension and origin-less clients (CLI, desktop app) are allowed, so
// a random web page can never drive this server. See http-security.js.

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...(res.corsHeaders || {}),
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
    ...(res.corsHeaders || {}),
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

  const caps = await getCapabilities(provider);
  const think = !!(caps[session.model] && caps[session.model].has('thinking'));
  const vision = !!(caps[session.model] && caps[session.model].has('vision'));

  // The user may attach documents and pictures: the documents travel in the
  // message (and are saved in the project), the pictures go to a vision model.
  const { turn, saved, pictureCount } = buildUserTurn({
    message: userMessage,
    attachments: body.attachments,
    images: body.images,
    vision,
  });
  session.messages.push(turn);
  if (saved.length) {
    emit('status', { message: `📎 Saved ${saved.length} attachment(s) in the project.` });
  }
  if (pictureCount && !vision) {
    emit('status', { message: '⚠ This model cannot look at images — the picture was not sent.' });
  }

  // Two-scope routing: decide whether this is a current-page task or research.
  // The client may send a composed message (page frame + instructions); the
  // routing must run on the user's own words, otherwise page text that
  // happens to contain "latest" or "search" flips an edit into a research task.
  const currentPageOnly = body.currentPageOnly !== false; // default ON
  const pageInfo = body.pageInfo || null;
  const userRequest =
    typeof body.userRequest === 'string' && body.userRequest.trim()
      ? body.userRequest
      : userMessage;
  let scope = 'research';
  if (currentPageOnly && pageInfo) {
    try {
      scope = await routeScope(userRequest, pageInfo, true);
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
      // The extension only sends verification screenshots when the model can
      // actually look at them.
      vision: !!vision,
      scope,
    });
    const result = await runAgent({
      model: session.model,
      messages: session.messages,
      tools,
      scope,
      scopePrompt: buildScopePrompt(scope, pageInfo, body.mode || 'auto', userRequest),
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
    res.writeHead(204, res.corsHeaders || {});
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
      setApiKey(provider, apiKey); // persist so a restart does not lose the key
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
      clearApiKey(provider);
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
      setOpencodeAuth(null);
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
    setOpencodeAuth(auth);
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

  if (req.method === 'DELETE' && pathname === '/session') {
    const body = await readJson(req);
    const deleted = deleteSession(body.sessionId);
    sendJson(res, 200, { ok: true, deleted });
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
        'DELETE /session { sessionId }',
      ],
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found.' });
}

// The server is meant for the local machine only. When it is bound to a
// loopback address the Host header must be a loopback name too, which stops
// DNS-rebinding tricks (a browser resolving an attacker name to 127.0.0.1).
const LOOPBACK_BIND = /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(HOST);

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  res.corsHeaders = corsHeadersFor(origin);

  // Only the extension and origin-less clients (CLI, desktop app) may talk
  // to this server — a web page must not be able to drive the local agent.
  if (!isOriginAllowed(origin)) {
    sendJson(res, 403, { ok: false, error: 'Origin not allowed.' });
    return;
  }
  if (LOOPBACK_BIND && !isLoopbackHost(req.headers.host)) {
    sendJson(res, 403, { ok: false, error: 'Host not allowed.' });
    return;
  }

  let pathname;
  try {
    pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  } catch {
    sendJson(res, 400, { ok: false, error: 'Bad request URL.' });
    return;
  }

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
  if (!LOOPBACK_BIND) {
    console.log('');
    console.log('  ⚠ HOST is not a loopback address — the agent is reachable from the');
    console.log('    network. Web pages are still blocked, but keep this on a trusted LAN.');
  }
  console.log('');
});
