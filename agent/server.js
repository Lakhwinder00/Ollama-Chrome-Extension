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
const { OllamaProvider } = require('./provider');
const { loadAlwaysAllowed, allowAlways } = require('./permissions');
const { setProjectRoot, getProjectRoot, TOOL_DEFINITIONS } = require('./tools');
const { runAgent } = require('./agent');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';

const provider = new OllamaProvider();
const DEFAULT_MODEL = provider.defaultModel;

let capabilitiesCache = null;

async function getCapabilities() {
  if (!capabilitiesCache) {
    try {
      capabilitiesCache = await provider.modelCapabilities();
    } catch {
      capabilitiesCache = {};
    }
  }
  return capabilitiesCache;
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
    const root = setProjectRoot(body.root);
    sendJson(res, 200, { ok: true, root });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message });
  }
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

  const userMessage =
    typeof body.message === 'string' && body.message.trim() ? body.message : null;
  if (!userMessage) {
    emit('error', { message: 'No message provided.' });
    res.end();
    return;
  }

  session.messages.push({ role: 'user', content: userMessage });

  const caps = await getCapabilities();
  const think = !!(caps[session.model] && caps[session.model].has('thinking'));
  const vision = !!(caps[session.model] && caps[session.model].has('vision'));

  const ac = new AbortController();
  activeRuns.set(session.id, ac);

  try {
    emit('start', { sessionId: session.id, model: session.model, project: getProjectRoot() });
    const result = await runAgent({
      model: session.model,
      messages: session.messages,
      tools: TOOL_DEFINITIONS,
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
    const h = await provider.health();
    sendJson(res, 200, { ok: h.reachable, ollama: provider.endpoint, ...h, project: getProjectRoot() });
    return;
  }

  if (req.method === 'GET' && pathname === '/models') {
    try {
      let details = [];
      try {
        details = await provider.listModelDetails();
      } catch {
        details = []; // older providers may not expose details
      }
      const models = details.length ? details.map((d) => d.name) : await provider.listModels();
      capabilitiesCache = null; // re-read capabilities on next chat
      sendJson(res, 200, { ok: true, models, details });
    } catch (e) {
      sendJson(res, 502, { ok: false, error: e.message });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/project') {
    sendJson(res, 200, { ok: true, root: getProjectRoot() });
    return;
  }

  if (req.method === 'POST' && pathname === '/project') {
    await handleProject(req, res);
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
        'GET  /project',
        'POST /project   { root }',
        'POST /chat      { sessionId?, message, model?, autoApprove? }  (Server-Sent Events)',
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
  console.log(`  Provider      ${provider.name}`);
  console.log(`  Endpoint      ${provider.endpoint}`);
  console.log(`  Default model ${DEFAULT_MODEL}`);
  console.log(`  Project root  ${getProjectRoot() || '(not set — use POST /project)'}`);
  console.log('');
});
