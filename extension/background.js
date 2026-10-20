// Background service worker for the Local Code Agent extension.
//
// Opens the side panel (right side, like Claude's extension) when the user
// clicks the toolbar icon. The panel talks to the local agent server directly
// over HTTP (see host_permissions in manifest.json).
//
// It also adds the two right-click entries that Claude in Chrome is known
// for: ask the agent about the selected text, or about the whole page.

try {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} catch (e) {
  // sidePanel API not available in very old Chrome versions.
}

// Context menus are cleared whenever the extension reloads, so they are
// (re)created every time the service worker starts.
const MENUS = [
  {
    id: 'myagent-ask-selection',
    title: 'Ask the agent about "%s"',
    contexts: ['selection'],
  },
  {
    id: 'myagent-ask-page',
    title: 'Ask the agent about this page',
    contexts: ['page'],
  },
];

function ensureMenus() {
  for (const menu of MENUS) {
    try {
      chrome.contextMenus.create(menu);
    } catch (e) {
      // Already exists (duplicate id) — nothing to do.
    }
  }
}

ensureMenus();
if (chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(ensureMenus);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const selection = (info.selectionText || '').trim();
  const payload = {
    text: selection,
    url: (info.pageUrl || (tab && tab.url) || '').trim(),
    title: (tab && tab.title) || '',
    at: Date.now(),
  };
  // The panel may not be open yet, so the request is parked in session
  // storage and picked up when the panel starts.
  try {
    await chrome.storage.session.set({ pendingAsk: payload });
  } catch (e) {
    // storage.session is unavailable in very old Chrome — ignore.
  }
  if (tab && tab.id != null) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (e) {
      // The panel may already be open, or the gesture was consumed.
    }
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'ping') {
    sendResponse({ ok: true });
  }
  return false;
});
