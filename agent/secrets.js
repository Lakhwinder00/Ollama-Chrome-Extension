/**
 * Persistent provider credential store.
 *
 * Provider API keys (Anthropic, OpenAI, Gemini, OpenRouter) and the OpenCode
 * password used to live only in the server's memory, so every restart forced
 * the user to re-type them. They now live in ~/.myagent/providers.json next to
 * the permissions file, written with 0600 permissions on POSIX.
 *
 * The file is never served over HTTP and never leaves the machine.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function storeFile() {
  // MYAGENT_HOME lets tests (and users) relocate the store away from the home dir.
  const base = process.env.MYAGENT_HOME || os.homedir();
  return path.join(base, '.myagent', 'providers.json');
}

/** Load every stored credential: { apiKeys: {provider: key}, opencode: auth }. */
function loadStore() {
  const empty = { apiKeys: {}, opencode: null };
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    if (!data || typeof data !== 'object') return empty;
    const apiKeys = {};
    if (data.apiKeys && typeof data.apiKeys === 'object') {
      for (const [provider, key] of Object.entries(data.apiKeys)) {
        if (typeof key === 'string' && key) apiKeys[provider] = key;
      }
    }
    const opencode =
      data.opencode && typeof data.opencode === 'object' && typeof data.opencode.type === 'string'
        ? data.opencode
        : null;
    return { apiKeys, opencode };
  } catch {
    return empty;
  }
}

function saveStore(store) {
  try {
    const file = storeFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // chmod is not supported on every platform (Windows) — ignore.
    }
  } catch {
    // best-effort; a read-only home directory must not break the agent
  }
}

/** The stored API key for a provider, or null. */
function getApiKey(provider) {
  const store = loadStore();
  return store.apiKeys[provider] || null;
}

/** Store (or clear, when key is falsy) the API key for a provider. */
function setApiKey(provider, key) {
  const store = loadStore();
  if (key) store.apiKeys[provider] = key;
  else delete store.apiKeys[provider];
  saveStore(store);
}

/** Remove the stored API key for a provider. */
function clearApiKey(provider) {
  setApiKey(provider, null);
}

/** The stored OpenCode auth ({ type: 'basic'|'bearer', password|token }) or null. */
function getOpencodeAuth() {
  return loadStore().opencode;
}

/** Store (or clear, when auth is null) the OpenCode auth. */
function setOpencodeAuth(auth) {
  const store = loadStore();
  store.opencode = auth || null;
  saveStore(store);
}

module.exports = {
  loadStore,
  getApiKey,
  setApiKey,
  clearApiKey,
  getOpencodeAuth,
  setOpencodeAuth,
};
