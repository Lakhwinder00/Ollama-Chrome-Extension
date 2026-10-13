/**
 * Two-scope routing: decides whether a prompt should operate on the current
 * page or run as external research, then restricts tools and builds the
 * appropriate system prompt.
 */

const PAGE_ACTION_RE =
  /\b(update|edit|fix|fill|correct|change|add|remove|delete|save|submit|type|write|rewrite|improve|replace|set)\b/i;

// Tools allowed in each scope
const TOOLS_BY_SCOPE = {
  page: [
    'get_dom', 'get_page', 'screenshot', 'scroll', 'click', 'type', 'key',
    'edit_element', 'add_element', 'delete_element', 'navigate', 'search',
  ],
  research: [
    'web_search', 'find_best_link', 'fetch_url', 'search', 'navigate',
    'get_dom', 'get_page', 'screenshot', 'scroll',
  ],
  both: 'all',
};

/**
 * Route the scope based on the prompt and toggle state.
 * @param {string} userPrompt - The user's request
 * @param {object} pageInfo - { title, url, text } from the active tab
 * @param {boolean} toggleOn - Whether "current page" mode is enabled
 * @returns {Promise<string>} - 'page' | 'research' | 'both'
 */
async function routeScope(userPrompt, pageInfo, toggleOn) {
  if (!toggleOn) return 'research';

  // No readable page → research only
  if (!pageInfo || !pageInfo.url) return 'research';

  // Restricted pages (chrome://, edge://, about:, extension pages)
  if (/^(chrome|edge|about|chrome-extension):/.test(pageInfo.url)) {
    return 'research';
  }

  const prompt = (userPrompt || '').toLowerCase().trim();
  if (!prompt) return 'page';

  // Strong page references → page scope
  const pageReferences =
    /\b(this|here|current|active|the)\s+(page|tab|site|form|profile|post|article|document)\b/.test(prompt) ||
    /\b(my\s+(profile|account|page|site|dashboard|settings))\b/.test(prompt) ||
    /\b(fill|edit|update|fix|change|correct|improve|summarize|read|describe)\s+(this|it|that|the\s+page|the\s+form)\b/.test(prompt) ||
    /\bthis\s+page\s+(says|shows|contains|has)\b/.test(prompt);

  // External references → research scope
  const externalReferences =
    /\b(search|google|look\s+up|find|research|latest|current\s+news|web)\b/.test(prompt) &&
    !/\b(this|here|current|active)\s+(page|tab|site)\b/.test(prompt);

  // Page edit actions without external cues → page scope
  const isPageAction =
    PAGE_ACTION_RE.test(prompt) &&
    !/\b(web|internet|online|search|google|other\s+sites?)\b/.test(prompt);

  // Question about page content → page scope
  const isPageQuestion =
    /\?/.test(prompt) &&
    (/\b(this|here|current|active)\b/.test(prompt) ||
      /\b(what|who|when|where|why|how)\s+(does|is|are|was|were|says|shows)\b/.test(prompt));

  if (pageReferences && externalReferences) return 'both';
  if (pageReferences) return 'page';
  if (externalReferences) return 'research';
  if (isPageAction) return 'page';
  if (isPageQuestion) return 'page';

  // Default: if page has substantial content, lean page; else research
  return (pageInfo.text || '').length > 500 ? 'page' : 'research';
}

/**
 * Filter tools based on scope.
 * @param {Array} allTools - Full TOOL_DEFINITIONS array
 * @param {string} scope - 'page' | 'research' | 'both'
 * @returns {Array} - Filtered tools
 */
function pickTools(allTools, scope) {
  if (scope === 'both') return allTools;
  const allowed = new Set(TOOLS_BY_SCOPE[scope] || []);
  return allTools.filter((t) => t && t.function && allowed.has(t.function.name));
}

/**
 * Build a scope-specific system prompt.
 * @param {string} scope - 'page' | 'research' | 'both'
 * @param {object} page - { tabId, url, title, text } or null
 * @param {string} mode - Autonomy mode: 'auto' | 'ask' | 'manual'
 * @param {string} task - The user's task
 * @returns {string} - The system prompt
 */
function buildScopePrompt(scope, page, mode, task) {
  const modeLine =
    mode === 'auto'
      ? 'You are in FULL AUTO mode: act immediately without asking for approval.'
      : mode === 'ask'
        ? 'You are in ASK mode: confirm before each significant change.'
        : 'You are in MANUAL mode: describe what you would do, but do not execute.';

  if (scope === 'page') {
    const tabLine = page && page.tabId ? ` (tabId ${page.tabId})` : '';
    return [
      `You are a browser agent focused ONLY on the user's current tab${tabLine}.`,
      '',
      '1. The page content below is your main source of truth. Read it fully,',
      '   scroll and re-read for lazy-loaded sections before acting.',
      '2. Use the page\'s own information (names, history, fields, text) to',
      '   decide what to change. Do not ask the user for details you can see.',
      '3. Make the changes on this tab, then verify with a fresh get_dom.',
      '4. Do not open other tabs or search the web unless the page lacks info you',
      '   truly need. If so, say so in one line and do one targeted search.',
      `5. ${modeLine} Show old -> new text for edits.`,
      '6. Finish with a short summary of what changed.',
      '',
      page ? `PAGE: ${page.title || 'Untitled'} | ${page.url || ''}` : 'PAGE: (unavailable)',
      page && page.text ? `PAGE CONTENT:\n${page.text.slice(0, 8000)}` : '',
      `TASK: ${task}`,
    ]
      .filter((l) => l !== '')
      .join('\n');
  }

  if (scope === 'research') {
    return [
      'You are a research and action agent. The task does not depend on the',
      'current tab, so ignore it.',
      '',
      '1. Break the task into steps. Search the web, open the most relevant',
      '   sources, and read them (get_dom / fetch_url), not just the snippets.',
      '2. Cross-check at least 2 sources for important facts.',
      '3. Complete the task fully: produce the result, fill the form, or take',
      '   the action requested. Do not stop at a list of links.',
      '4. Never ask for details you can reasonably assume. State assumptions in',
      '   one line.',
      `5. ${modeLine} Close tabs you opened when done.`,
      '6. Finish with the result plus the sources you used.',
      '',
      `TASK: ${task}`,
    ].join('\n');
  }

  // both
  const pagePrompt = buildScopePrompt('page', page, mode, task);
  return (
    pagePrompt +
    '\n\nYou may research externally to improve the changes, then apply them to the current tab.'
  );
}

module.exports = {
  routeScope,
  pickTools,
  buildScopePrompt,
  TOOLS_BY_SCOPE,
};
