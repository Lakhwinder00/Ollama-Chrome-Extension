/* Local Code Agent — request intent.
 *
 * Small, pure helpers that decide what the user means: do they want the PAGE
 * changed, is the wording ambiguous about which page, and is this a request
 * that should trigger a web search right away?
 *
 * They live in their own file (instead of popup.js) so they can be unit
 * tested — popup.js needs a DOM and cannot be required from Node.
 */

(function (global) {
  'use strict';

  // Verbs that mean "change the page". Word boundaries matter: "add" must not
  // match "address", "post" must not match "post-mortem".
  const PAGE_EDIT_VERBS =
    /\b(update|edit|change|modify|fix|correct|replace|rewrite|refactor|rename|clear|delete|remove|insert|fill|save|submit|publish|write|apply|add|toggle|improve|customize|upload)\b/i;

  // The same verbs, but only meaningful together with a reference to the page
  // that is open ("make the current tab dark", "check the box on this page").
  const PAGE_TARGETED_VERBS =
    /\b(make|set|check|mark|select|enable|disable|turn\s+on|turn\s+off|hide|show|switch)\b/i;

  const PAGE_REFERENCE =
    /\b(current|active|open|this|that)\s+(page|tab|window|site|form|profile|post|article)\b/i;

  /**
   * True when the user wants the PAGE changed ("update my profile", "fix the
   * headline") rather than answered ("what does this page say?"). Those
   * prompts must tell the model to edit the active tab instead of writing an
   * analysis.
   */
  function looksLikePageEditRequest(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    const question =
      t.includes('?') ||
      /^\s*(what|who|when|where|why|how|which|is|are|was|were|does|did|do|can|could|will|would|should|explain|describe|summar\w*|tell me|list|find|show me|compare|review)\b/i.test(
        t
      );
    if (question) return false;

    if (PAGE_EDIT_VERBS.test(t)) return true;

    // "…the current page" together with a change word.
    if (PAGE_TARGETED_VERBS.test(t) && PAGE_REFERENCE.test(t)) return true;
    return false;
  }

  /**
   * The wording may point at "the current page" while the user actually means
   * another tab, a URL, or a section of the page. When that is likely, a
   * short note asks the agent to confirm — the request is still sent, so the
   * user always gets an answer instead of a dead end.
   */
  function pageAmbiguityNote(text) {
    const t = String(text || '').trim();
    if (!t) return null;

    const currentPagePatterns = [
      /\b(current|active|open)\s+(page|tab|window)\b/i,
      /\b(this|that)\s+(page|tab|window)\s+(is|isn'?t|seems|looks|has|hasn'?t|does|was|works?)\b/i,
      /\bwhat(?:'s| is)\s+(on|with|about)\s+(the\s+)?(current|active|this|that)\s+(page|tab)\b/i,
      /\bthe\s+page\s+(i|we)\s*(am|are|'m|'re)\s+(on|looking at|viewing|at)\b/i,
    ];

    for (const pattern of currentPagePatterns) {
      if (pattern.test(t)) {
        return '[The request may refer to another tab, a specific URL, or a section of the page. If it is ambiguous, ask which one before acting — otherwise use the active tab.]';
      }
    }

    return null;
  }

  /**
   * Smarter auto-search: instead of firing a browser search for every message,
   * only two conditions trigger it up front —
   *   1. an explicit research request ("look up", "research", "google X"),
   *   2. a request for current information ("latest", "today", "news", …).
   * Anything else is left to the model's own judgment (it researches by
   * itself when it cannot answer confidently).
   */
  function shouldAutoSearch(text) {
    const t = String(text || '').trim();
    if (!t) return { ok: false, reason: 'empty' };
    if (looksLikePageEditRequest(t)) return { ok: false, reason: 'page-edit' };
    if (
      /\b(look\s*up|research|google|web\s*search|search\s+(?:the\s+)?(?:web|online|internet|google|duckduckgo|bing|news)|find\s+me\s|dig\s*up|hunt\s*down)\b/i.test(
        t
      )
    ) {
      return { ok: true, reason: 'explicit-research' };
    }
    if (
      /\b(latest|breaking|today|tonight|yesterday|this\s+(?:week|month|year)|currently|right\s+now|as\s+of|recent(?:ly)?|news|score[sd]?|weather|stock|price[sd]?|release\s+(?:date|notes)|who\s+(?:won|is\s+leading)|what(?:'s| is)\s+the\s+(?:latest|current)|20(?:2[5-9]|[3-9]\d))\b/i.test(
        t
      )
    ) {
      return { ok: true, reason: 'current-info' };
    }
    return { ok: false, reason: 'model-decides' };
  }

  const api = { looksLikePageEditRequest, pageAmbiguityNote, shouldAutoSearch };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) {
    global.looksLikePageEditRequest = looksLikePageEditRequest;
    global.pageAmbiguityNote = pageAmbiguityNote;
    global.shouldAutoSearch = shouldAutoSearch;
  }
})(typeof window !== 'undefined' ? window : null);
