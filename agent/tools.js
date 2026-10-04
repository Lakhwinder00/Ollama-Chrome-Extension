/**
 * The agent's "hands": filesystem and shell access, strictly scoped to a
 * project root that the user selects. No path can escape the project root.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const { fetchPageText } = require('./web');

const MAX_READ_LINES = 2000;
const MAX_SEARCH_FILES = 1500;
const MAX_SEARCH_RESULTS = 100;
const MAX_COMMAND_OUTPUT = 8000;

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage',
  '__pycache__', '.venv', 'venv', 'env', '.tox', 'bin', 'obj', '.gradle', 'target',
]);

const TEXT_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.html', '.htm', '.css',
  '.scss', '.sass', '.less', '.md', '.markdown', '.txt', '.py', '.java', '.c', '.h',
  '.cpp', '.hpp', '.cc', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.bash', '.bat',
  '.ps1', '.yml', '.yaml', '.xml', '.sql', '.vue', '.svelte', '.graphql', '.gql',
  '.toml', '.ini', '.cfg', '.conf', '.env', '.gitignore', '.csv', '.log', '.lock',
]);

let projectRoot = null;

function setProjectRoot(root) {
  if (typeof root !== 'string' || !root.trim()) {
    throw new Error('Project root must be a non-empty path.');
  }
  const resolved = path.resolve(root.trim());
  if (!fs.existsSync(resolved)) throw new Error(`Project root does not exist: ${resolved}`);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`Project root is not a directory: ${resolved}`);
  projectRoot = resolved;
  return projectRoot;
}

function getProjectRoot() {
  return projectRoot;
}

function relativePath(abs) {
  if (!projectRoot) return abs;
  const rel = path.relative(path.resolve(projectRoot), abs);
  return rel || '.';
}

/** Resolve a user-supplied path and guarantee it stays inside the project root. */
function resolveSafe(relPath) {
  if (!projectRoot) {
    throw new Error('No project selected. Set a project root before using file tools.');
  }
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw new Error('path must be a non-empty string.');
  }
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Access denied: "${relPath}" resolves outside the project root.`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------
async function read_file(args) {
  const filePath = resolveSafe(args.path);
  const stat = await fsp.stat(filePath);
  if (stat.isDirectory()) throw new Error(`"${relativePath(filePath)}" is a directory, not a file.`);
  const raw = await fsp.readFile(filePath, 'utf8');
  const lines = raw.split('\n');
  let start = args.start_line != null ? Math.max(1, Number(args.start_line)) : 1;
  let end = args.end_line != null ? Math.min(lines.length, Number(args.end_line)) : lines.length;
  if (end < start) end = start;
  let truncated = false;
  if (end - start + 1 > MAX_READ_LINES) {
    end = start + MAX_READ_LINES - 1;
    truncated = true;
  }
  const selected = lines.slice(start - 1, end);
  const numbered = selected.map((line, i) => `${String(start + i).padStart(5)}| ${line}`).join('\n');
  return {
    path: relativePath(filePath),
    lines: { total: lines.length, start, end, truncated },
    content: numbered,
  };
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------
async function write_file(args) {
  if (typeof args.content !== 'string') throw new Error('write_file requires "content" (string).');
  const filePath = resolveSafe(args.path);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, args.content, 'utf8');
  const bytes = Buffer.byteLength(args.content, 'utf8');
  return { path: relativePath(filePath), bytesWritten: bytes };
}

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------
async function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  try {
    const fd = await fsp.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fd.read(buf, 0, 8192, 0);
      return !buf.subarray(0, bytesRead).includes(0);
    } finally {
      await fd.close();
    }
  } catch {
    return false;
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function search_files(args) {
  const query = args.query;
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('search_files requires a "query".');
  }
  const base = args.path ? resolveSafe(args.path) : path.resolve(projectRoot);
  let regex;
  try {
    regex = new RegExp(query, 'i');
  } catch {
    regex = new RegExp(escapeRegex(query), 'i');
  }

  const results = [];
  const state = { filesVisited: 0 };

  async function walk(dir) {
    if (results.length >= MAX_SEARCH_RESULTS || state.filesVisited >= MAX_SEARCH_FILES) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_SEARCH_RESULTS || state.filesVisited >= MAX_SEARCH_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      state.filesVisited++;
      const rel = relativePath(full);
      if (regex.test(entry.name)) {
        results.push({ type: 'filename', file: rel });
        if (results.length >= MAX_SEARCH_RESULTS) return;
      }
      if (!(await isTextFile(full))) continue;
      try {
        const content = await fsp.readFile(full, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= MAX_SEARCH_RESULTS) return;
          if (regex.test(lines[i])) {
            results.push({
              type: 'content',
              file: rel,
              line: i + 1,
              text: lines[i].trim().slice(0, 240),
            });
          }
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  await walk(base);
  return { query, matches: results.length, results };
}

// ---------------------------------------------------------------------------
// run_command
// ---------------------------------------------------------------------------
async function run_command(args) {
  if (!projectRoot) throw new Error('No project selected. Set a project root before running commands.');
  if (typeof args.command !== 'string' || !args.command.trim()) {
    throw new Error('run_command requires a "command".');
  }
  const cwd = args.path ? resolveSafe(args.path) : path.resolve(projectRoot);
  const timeout = Math.min(Math.max(Number(args.timeout) || 30000, 5000), 120000);
  try {
    const { stdout, stderr } = await execAsync(args.command, {
      cwd,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      command: args.command,
      cwd: relativePath(cwd),
      exitCode: 0,
      stdout: stdout.slice(-MAX_COMMAND_OUTPUT),
      stderr: stderr.slice(-MAX_COMMAND_OUTPUT),
    };
  } catch (err) {
    return {
      command: args.command,
      cwd: relativePath(cwd),
      exitCode: err.code != null ? err.code : 1,
      stdout: (err.stdout || '').slice(-MAX_COMMAND_OUTPUT),
      stderr: (err.stderr || err.message || '').slice(-MAX_COMMAND_OUTPUT),
    };
  }
}

// ---------------------------------------------------------------------------
// web_search — fetch real search results so the model never has to guess.
// ---------------------------------------------------------------------------
function htmlDecode(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function web_search(args) {
  const query = String((args && args.query) || '').trim();
  if (!query) throw new Error('web_search requires a "query".');

  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`Search request failed (HTTP ${res.status}).`);
  const html = await res.text();

  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const links = [];
  const snippets = [];
  let m;
  while ((m = linkRe.exec(html))) {
    links.push({ href: m[1], title: htmlDecode(m[2]) });
  }
  while ((m = snippetRe.exec(html))) {
    snippets.push(htmlDecode(m[1]));
  }

  const results = [];
  for (let i = 0; i < Math.min(links.length, 8); i++) {
    let real = links[i].href;
    try {
      const u = new URL(links[i].href, 'https://html.duckduckgo.com');
      const uddg = u.searchParams.get('uddg');
      if (uddg) real = decodeURIComponent(uddg);
    } catch {}
    results.push({ title: links[i].title, url: real, snippet: snippets[i] || '' });
  }

  if (!results.length) throw new Error('No search results found.');
  return { query, source: 'DuckDuckGo', results };
}

async function fetch_url(args) {
  const url = String((args && args.url) || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('fetch_url requires a valid http(s) URL.');
  const content = await fetchPageText(url);
  return { url, content };
}

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------
async function list_directory(args) {
  const dir = args.path ? resolveSafe(args.path) : path.resolve(projectRoot);
  const stat = await fsp.stat(dir);
  if (!stat.isDirectory()) throw new Error(`"${relativePath(dir)}" is not a directory.`);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const items = entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }));
  return { path: relativePath(dir), entries: items };
}

// ---------------------------------------------------------------------------
// edit_file — targeted string replacement inside a file
// ---------------------------------------------------------------------------
async function edit_file(args) {
  if (typeof args.old_string !== 'string' || !args.old_string) {
    throw new Error('edit_file requires "old_string".');
  }
  if (typeof args.new_string !== 'string') throw new Error('edit_file requires "new_string".');
  const filePath = resolveSafe(args.path);
  const original = await fsp.readFile(filePath, 'utf8');
  const re = new RegExp(escapeRegex(args.old_string), 'g');
  const matches = original.match(re) || [];
  if (!matches.length) throw new Error(`old_string not found in ${relativePath(filePath)}.`);
  if (matches.length > 1 && !args.replace_all) {
    throw new Error(
      `old_string occurs ${matches.length} times in ${relativePath(filePath)}. Pass replace_all: true to replace all.`
    );
  }
  const updated = args.replace_all ? original.replace(re, args.new_string) : original.replace(args.old_string, args.new_string);
  await fsp.writeFile(filePath, updated, 'utf8');
  return { path: relativePath(filePath), replacedOccurrences: args.replace_all ? matches.length : 1 };
}

// ---------------------------------------------------------------------------
// delete_file
// ---------------------------------------------------------------------------
async function delete_file(args) {
  const filePath = resolveSafe(args.path);
  const stat = await fsp.stat(filePath);
  if (stat.isDirectory()) throw new Error('delete_file only removes files, not directories.');
  await fsp.unlink(filePath);
  return { path: relativePath(filePath), deleted: true };
}

// ---------------------------------------------------------------------------
// Git tools (read-only; they surface git's own output, incl. "not a repo")
// ---------------------------------------------------------------------------
async function runGit(command) {
  if (!projectRoot) throw new Error('No project selected. Set a project root before using git tools.');
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: path.resolve(projectRoot),
      timeout: 30000,
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
    });
    return (stdout + (stderr ? '\n' + stderr : '')).trim();
  } catch (err) {
    return ((err.stdout || '') + (err.stderr || err.message || '')).trim();
  }
}

async function git_status() {
  const output = await runGit('git status --short');
  return { command: 'git status --short', output: output || '(clean working tree)' };
}

async function git_diff() {
  const stat = await runGit('git diff --stat');
  const diff = (await runGit('git diff')).slice(0, 8000);
  return { command: 'git diff', stat: stat || '(no changes)', diff };
}

async function git_log(args) {
  const n = Math.min(Math.max(Number(args && args.n) || 10, 1), 50);
  const output = await runGit('git log --oneline -n ' + n);
  return { command: 'git log --oneline -n ' + n, output };
}

async function git_branch() {
  const output = await runGit('git branch --all');
  return { command: 'git branch --all', output };
}

// ---------------------------------------------------------------------------
// Registry + Ollama tool definitions
// ---------------------------------------------------------------------------
const TOOL_FUNCTIONS = {
  read_file,
  write_file,
  search_files,
  run_command,
  web_search,
  fetch_url,
  list_directory,
  edit_file,
  delete_file,
  git_status,
  git_diff,
  git_log,
  git_branch,
};

// Browser tools are declared here but executed by the Chrome extension: the
// server routes the call to the extension, which runs it in the active tab.
const BROWSER_TOOLS = new Set(['get_page', 'get_dom', 'click', 'type', 'scroll', 'screenshot', 'navigate', 'search']);

async function execute(name, args) {
  const fn = TOOL_FUNCTIONS[name];
  if (!fn) throw new Error(`Unknown tool: ${name}`);
  return fn(args || {});
}

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a text file from the project. Returns the content with line numbers. Use start_line/end_line to read a specific range instead of the whole file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root, e.g. "src/login.js".' },
          start_line: { type: 'integer', description: 'Optional first line to read (1-based, inclusive).' },
          end_line: { type: 'integer', description: 'Optional last line to read (1-based, inclusive).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite a file inside the project. Parent directories are created automatically. Pass the complete new file content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
          content: { type: 'string', description: 'The complete file content to write.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description:
        'Search the project for a query. Matches file names and file contents (case-insensitive regex). Returns matching files and lines.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text or regex to search for, e.g. "handleLogin" or "TODO|FIXME".' },
          path: { type: 'string', description: 'Optional subdirectory to search, relative to the project root.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command inside the project root (Windows cmd). Use for git, npm, tests, builds, or inspecting state. Prefer non-interactive commands that finish on their own.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to run, e.g. "git status" or "npm test".' },
          path: { type: 'string', description: 'Optional working directory relative to the project root.' },
          timeout: { type: 'integer', description: 'Optional timeout in milliseconds (max 120000).' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web (DuckDuckGo) and return the top results with titles, URLs, and snippets. Use this whenever you do not know the answer or need current information.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description:
        'Fetch a web page and return its readable text. Use after web_search to read a specific result page for accurate details.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL to fetch, e.g. "https://en.wikipedia.org/wiki/X".' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List the files and folders inside a directory of the project.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory relative to the project root (default: project root).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Make a targeted edit: replace an exact string in a file. Safer than rewriting the whole file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
          old_string: { type: 'string', description: 'Exact text to replace.' },
          new_string: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace all occurrences (default false, errors if more than one).' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a single file inside the project (requires approval).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Show changed/untracked files in the git working tree.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Show the current uncommitted diff (stat + full diff).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_log',
      description: 'Show recent commit history (one line per commit).',
      parameters: {
        type: 'object',
        properties: {
          n: { type: 'integer', description: 'Number of commits (default 10).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_branch',
      description: 'List git branches.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_page',
      description:
        "Read the active browser tab's URL, title, and full page text. It auto-scrolls through the page to collect content below the fold. Use this to see what page the user is on.",
      parameters: {
        type: 'object',
        properties: {
          max_chars: { type: 'integer', description: 'Maximum characters of page text to return (default 15000).' },
          max_scrolls: { type: 'integer', description: 'Maximum number of scroll steps (default 20).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_dom',
      description:
        'List interactive elements (links, buttons, inputs) on the active tab, to find the right element to click or type into.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Optional CSS selector to scope the search (default: all interactive elements).' },
          max_items: { type: 'integer', description: 'Maximum number of elements to return (default 100).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description:
        'Click an element on the active browser tab, found by CSS selector or by matching visible text.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the element, e.g. "#submit" or "button.login".' },
          text: { type: 'string', description: 'Visible text of the element to click (case-insensitive substring match).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type',
      description:
        'Type text into an input, textarea, or select on the active browser tab, found by CSS selector or by placeholder/name/aria-label text.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the field, e.g. "#email".' },
          text: { type: 'string', description: 'Placeholder, name, or aria-label of the field to find.' },
          value: { type: 'string', description: 'The text to type into the field.' },
        },
        required: ['value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description:
        'Scroll the active browser tab down or up (or scroll an element into view) so you can read more of the page before acting.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['down', 'up'], description: 'Direction to scroll (default down).' },
          amount: { type: 'integer', description: 'Pixels to scroll (default ~80% of the viewport).' },
          selector: { type: 'string', description: 'Optional CSS selector of an element to scroll into view.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description:
        'Capture a screenshot of the currently active browser tab. Use this to verify what the page looks like after clicking or typing.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate',
      description:
        'Open a URL in the active browser tab. Use this to visit a page or search engine when you need information you do not already have.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL to open, e.g. "https://www.google.com/search?q=upwork" or "https://en.wikipedia.org/wiki/X".' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search',
      description:
        'Search Google for a query (opens the results in the active tab). Use this when you do not know the answer; then use get_page to read the results.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' },
        },
        required: ['query'],
      },
    },
  },
];

module.exports = {
  setProjectRoot,
  getProjectRoot,
  execute,
  TOOL_FUNCTIONS,
  TOOL_DEFINITIONS,
  BROWSER_TOOLS,
};
