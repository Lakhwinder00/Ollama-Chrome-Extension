/**
 * Origin + host policy for the local agent server.
 *
 * The server can read and write files inside the project root and run shell
 * commands, so it must not be reachable from an arbitrary web page. Two kinds
 * of clients are allowed:
 *
 *   - the Chrome extension (Origin: chrome-extension://<id>)
 *   - non-browser clients that send no Origin header at all
 *     (the CLI, the WPF desktop app, curl, PowerShell)
 *
 * Everything else — a normal website, a sandboxed iframe ("null"), a
 * data:/file: page — is rejected, so a malicious page cannot turn the local
 * agent into a remote shell for the user's files.
 *
 * The Host header is checked too: a browser that resolves an attacker-owned
 * name to 127.0.0.1 (DNS rebinding) would otherwise reach the server with a
 * foreign Host header.
 */

const ALLOWED_METHODS = 'GET, POST, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization';

// Unpacked and Web Store extension ids are 32 [a-p] characters; be a little
// lenient so development builds with a custom id still work.
const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-z0-9_-]{8,64}$/i;

// Only loopback names may be used in the Host header.
const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

/**
 * True when a request carrying this Origin header may be served.
 * A missing Origin means the client is not a browser (CLI, desktop app).
 */
function isOriginAllowed(origin) {
  if (origin === undefined || origin === null || origin === '') return true;
  if (typeof origin !== 'string') return false;
  return EXTENSION_ORIGIN_RE.test(origin.trim());
}

/**
 * CORS headers for a request. Returns an empty object for a rejected origin
 * so the browser blocks the response.
 */
function corsHeadersFor(origin) {
  if (!isOriginAllowed(origin)) return {};
  const headers = {
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  return headers;
}

/** True when the Host header points at the loopback interface. */
function isLoopbackHost(host) {
  if (!host) return false;
  return LOOPBACK_HOST_RE.test(String(host).trim());
}

module.exports = { isOriginAllowed, corsHeadersFor, isLoopbackHost, ALLOWED_METHODS };
