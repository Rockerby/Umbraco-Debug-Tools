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
  console.log("[background.js] Listening with Port ", port);
  if (!port.name.startsWith('devtools-')) return;

  const tabId = parseInt(port.name.replace('devtools-', ''), 10);
  panelConnections.set(tabId, port);

  // Forward panel messages to the content script in the inspected tab
  port.onMessage.addListener((msg) => {
    chrome.tabs.sendMessage(tabId, msg).then((response) => {
      if (response) port.postMessage(response);
    }).catch((err) => {
      // "Receiving end does not exist" is expected when the content script
      // hasn't loaded yet (e.g. page still loading, or non-Umbraco page).
      if (!err.message?.includes('Receiving end does not exist')) {
        console.log("[background.js] Error sending message ", err);
      }
    });
  });

  port.onDisconnect.addListener(() => {
    panelConnections.delete(tabId);
  });
});

// Forward content script messages back to the correct DevTools panel
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab) return false;
  const port = panelConnections.get(sender.tab.id);
  if (port) {
    port.postMessage(msg);
  }
  return false;
});
