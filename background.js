/**
 * Background service worker — bridges messages between the DevTools panel
 * and the content script running in the inspected tab.
 *
 * Flow:
 *   DevTools panel  <—port—>  background  <—tabs.sendMessage—>  content script
 */

// Map of tabId -> chrome.runtime.Port (the devtools panel's connection)
const panelConnections = new Map();

chrome.runtime.onConnect.addListener((port) => {
  // Ports are named "devtools-<tabId>"
  if (!port.name.startsWith('devtools-')) return;

  const tabId = parseInt(port.name.replace('devtools-', ''), 10);
  panelConnections.set(tabId, port);

  // Forward panel messages to the content script in the inspected tab
  port.onMessage.addListener((msg) => {
    chrome.tabs.sendMessage(tabId, msg).catch(() => {
      // Content script may not be ready yet — ignore
    });
  });

  port.onDisconnect.addListener(() => {
    panelConnections.delete(tabId);
  });
});

// Forward content script messages back to the correct DevTools panel
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab) return;
  const port = panelConnections.get(sender.tab.id);
  if (port) {
    port.postMessage(msg);
  }
});
