// Background service worker for the Local Code Agent extension.
//
// Opens the side panel (right side, like Claude's extension) when the user
// clicks the toolbar icon. The panel talks to the local agent server directly
// over HTTP (see host_permissions in manifest.json).

try {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} catch (e) {
  // sidePanel API not available in very old Chrome versions.
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'ping') {
    sendResponse({ ok: true });
  }
  return false;
});
