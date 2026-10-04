#!/usr/bin/env node
/**
 * Local AI Coding Agent — CLI interface.
 * Reuses the shared Agent Core (agent/agent.js, agent/tools.js, agent/ollama.js).
 * No agent logic is duplicated here.
 *
 * Usage:
 *   node cli/myagent.js                              # interactive (cwd = project root)
 *   node cli/myagent.js "Fix the login bug"          # one-shot
 *   node cli/myagent.js -p C:\proj -m qwen2.5-coder:14b -y "Refactor X"
 */

const readline = require('readline');
const { runAgent } = require('../agent/agent');
const { setProjectRoot, TOOL_DEFINITIONS, BROWSER_TOOLS } = require('../agent/tools');
const { OllamaProvider } = require('../agent/provider');
const { loadAlwaysAllowed, allowAlways } = require('../agent/permissions');

const provider = new OllamaProvider();
let model = process.env.OLLAMA_MODEL || provider.defaultModel;
let projectRoot = process.cwd();
let oneShot = null;
let autoApprove = false;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-p' || a === '--project') projectRoot = argv[++i];
  else if (a === '-m' || a === '--model') model = argv[++i];
  else if (a === '-y' || a === '--yes') autoApprove = true;
  else if (a === '-h' || a === '--help') {
    printHelp();
    process.exit(0);
  } else oneShot = a;
}

// The CLI has no Chrome, so expose only non-browser tools.
const cliTools = TOOL_DEFINITIONS.filter((t) => !BROWSER_TOOLS.has(t.function.name));

const isTTY = process.stdout.isTTY;
const paint = (code, s) => (isTTY ? code + s + '\x1b[0m' : s);
const DIM = '\x1b[2m',
  BOLD = '\x1b[1m',
  CYAN = '\x1b[36m',
  GREEN = '\x1b[32m',
  RED = '\x1b[31m',
  YELLOW = '\x1b[33m';

function printHelp() {
  console.log('Local AI Coding Agent (CLI)');
  console.log('  node cli/myagent.js [options] ["one-shot prompt"]');
  console.log('  -p, --project <dir>   project root (default: current directory)');
  console.log('  -m, --model <name>    Ollama model (default: qwen2.5-coder:14b)');
  console.log('  -y, --yes             auto-approve writes and commands');
  console.log('  Commands: /models, /clear, /exit');
}

function onEvent(e) {
  switch (e.type) {
    case 'status':
      process.stdout.write('\n  ' + paint(DIM, e.message) + '\n');
      break;
    case 'assistant':
      process.stdout.write(e.content);
      break;
    case 'thinking':
      process.stdout.write('\n  \u{1F4AD} ' + paint(DIM, e.content));
      break;
    case 'tool':
      process.stdout.write(
        '\n  \u2699 ' + paint(CYAN, e.name) + ' ' + paint(DIM, JSON.stringify(e.arguments)) + '\n'
      );
      break;
    case 'tool_result':
      process.stdout.write(
        '     ' +
          paint(e.ok ? GREEN : RED, e.ok ? '\u2713' : '\u2717') +
          ' ' +
          paint(DIM, e.summary || e.error || '') +
          '\n'
      );
      break;
    case 'tool_denied':
      process.stdout.write('     ' + paint(YELLOW, '\u26D4 ' + e.name + ' denied') + '\n');
      break;
    case 'error':
      process.stdout.write('\n  ' + paint(RED, '\u2716 ' + (e.message || 'error')) + '\n');
      break;
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const question = (q) => new Promise((resolve) => rl.question(q, resolve));

async function requestApproval(name, args) {
  const ans = await question(
    '\n  \u26A0 Allow ' + name + ' ' + JSON.stringify(args) + '? [y=once / s=session / a=always / N=deny] '
  );
  const a = ans.trim().toLowerCase();
  if (a === 's') return { allowed: true, scope: 'session' };
  if (a === 'a') {
    allowAlways(name);
    return { allowed: true, scope: 'always' };
  }
  if (a === 'y') return { allowed: true, scope: 'once' };
  return { allowed: false };
}

let history = [];
let currentController = null;

process.on('SIGINT', () => {
  if (currentController) currentController.abort();
  else {
    console.log('\nBye.');
    process.exit(0);
  }
});

async function ask(msg) {
  const ac = new AbortController();
  currentController = ac;
  try {
    const result = await runAgent({
      model,
      messages: history.concat([{ role: 'user', content: msg }]),
      tools: cliTools,
      autoApprove,
      requestApproval,
      signal: ac.signal,
      provider,
      preApproved: loadAlwaysAllowed(),
      onEvent,
    });
    history = result.history;
    process.stdout.write('\n');
  } finally {
    currentController = null;
  }
}

async function repl() {
  console.log(paint(BOLD, 'Local AI Coding Agent'));
  console.log('  Model:   Ollama / ' + model);
  console.log('  Project: ' + projectRoot);
  console.log('  Commands: /models, /clear, /exit\n');
  while (true) {
    const line = await question(paint(CYAN, 'You> '));
    const input = line.trim();
    if (!input) continue;
    if (input === '/exit' || input === '/quit') break;
    if (input === '/clear') {
      history = [];
      console.log('  (history cleared)');
      continue;
    }
    if (input === '/models') {
      try {
        const ms = await provider.listModels();
        console.log('  ' + ms.join('\n  '));
      } catch (e) {
        console.log('  ' + paint(RED, 'Could not reach Ollama: ' + e.message));
      }
      continue;
    }
    await ask(input);
  }
}

(async () => {
  try {
    setProjectRoot(projectRoot);
  } catch (e) {
    console.error(paint(RED, 'Error: ' + e.message));
    process.exit(1);
  }
  if (oneShot) {
    await ask(oneShot);
  } else {
    await repl();
  }
  rl.close();
})();
