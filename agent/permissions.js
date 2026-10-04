/**
 * Persistent "Always Allow" permission store.
 *
 * Holds the list of tool names the user has permanently allowed, shared by all
 * three interfaces. Stored in ~/.myagent/permissions.json so it survives
 * restarts and applies across projects and sessions.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function permissionsFile() {
  // MYAGENT_HOME lets tests (and users) relocate the store away from the home dir.
  const base = process.env.MYAGENT_HOME || os.homedir();
  return path.join(base, '.myagent', 'permissions.json');
}

/** Load the permanently-allowed tool names (empty array when missing/invalid). */
function loadAlwaysAllowed() {
  try {
    const data = JSON.parse(fs.readFileSync(permissionsFile(), 'utf8'));
    return Array.isArray(data.allowedTools) ? data.allowedTools.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** Persist the permanently-allowed tool names. */
function saveAlwaysAllowed(tools) {
  try {
    const dir = path.dirname(permissionsFile());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(permissionsFile(), JSON.stringify({ allowedTools: [...new Set(tools)] }, null, 2) + '\n');
  } catch {
    // best-effort; a read-only home directory must not break the agent
  }
}

/** Add one tool to the always-allowed list (idempotent). */
function allowAlways(toolName) {
  const tools = new Set(loadAlwaysAllowed());
  tools.add(toolName);
  saveAlwaysAllowed(tools);
}

module.exports = { loadAlwaysAllowed, saveAlwaysAllowed, allowAlways };
