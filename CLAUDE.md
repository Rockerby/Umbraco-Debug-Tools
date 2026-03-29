# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a browser DevTools extension (Manifest V3) for inspecting Umbraco Backoffice element contexts. It injects `<umb-debug>` custom elements into selected page elements and renders the resulting context data as a collapsible JSON tree in a DevTools panel.

Supports both Umbraco 14+ (Bellissima/Lit web components) and Umbraco 9–13 (AngularJS-based).

Works in Chrome (using `manifest.json`) and Firefox 109+ (using `manifest_firefox.json` — copy it to `manifest.json` before loading in Firefox).

## Setup

Generate icons (only needed if `icons/` PNGs are missing):
```bash
python3 generate-icons.py
```

Load the extension in Chrome:
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this directory

Load the extension in Firefox:
1. Copy `manifest_firefox.json` to `manifest.json` (Firefox always reads `manifest.json`)
2. Open `about:debugging` → **This Firefox**
3. Click **Load Temporary Add-on…** and select `manifest.json`

There is no build step, no package manager, no transpilation — this is plain JavaScript loaded directly by Chrome.

## Architecture

Three-tier message-passing architecture:

```
DevTools Panel (panel.js)
    ↕ chrome.runtime.connect (persistent port)
Background Service Worker (background.js)
    ↕ chrome.tabs.sendMessage / sendResponse
Content Script (content.js)
    ↕ DOM manipulation on the inspected page
```

**background.js** — Service worker that bridges messages between the DevTools panel and content script. Maintains a `Map<tabId, port>` of open DevTools connections.

**content.js** — Injected into every page. Handles:
- Umbraco detection (4 strategies: `<umb-app>`/`<umb-backoffice>` elements, `umb-` prefixed elements, `[ng-app="umbraco"]`, global variables)
- Element pick mode (highlights elements, captures click, injects `<umb-debug>`)
- Output reading (polls; tries shadow DOM → light DOM children → text content → Lit/Umbraco internal state)
- Sanitization of non-serializable values before postMessage transfer

**devtools.js / devtools.html** — Minimal DevTools page that registers the "Umbraco Debug" panel tab.

**panel.js** — All DevTools panel UI logic:
- Connects to background via `chrome.runtime.connect()`
- Sends commands (pick mode, refresh, clear) to content script
- Renders debug output: parses HTML from `<umb-debug>`, extracts JSON contexts, builds interactive collapsible tree
- JSON tree renderer handles depth limiting (5 levels), array/object truncation (200 items max)

**panel.html / panel.css** — Panel UI with dark VS Code-like theme. Tab-based layout: Contexts (JSON tree) and Raw HTML.

## Key Implementation Details

- **Data sanitization**: `content.js` strips non-serializable values (functions, DOM nodes, circular refs) and enforces depth limits before sending across the extension message boundary.
- **Output reading is async/polled**: `<umb-debug>` renders asynchronously; content script polls until output appears.
- **Multiple context extraction strategies**: Shadow DOM traversal for Lit components; element property introspection (`_contexts`, `contexts`, `_contextData`) for when shadow DOM is closed.
- **JSON tree color scheme** (panel.css): keys `#9cdcfe`, strings `#ce9178`, numbers `#b5cea8`, booleans `#4ec9b0`, null `#569cd6`.

## Testing

Manual testing only — no test framework exists. Test by loading the extension unpacked and exercising it against a real Umbraco backoffice instance. Verify on both Umbraco 9–13 (AngularJS) and 14+ (Lit/web components).

When iterating on the extension, reload it at `chrome://extensions` after changes to `background.js` or `content.js`. Changes to `panel.js`/`panel.html`/`panel.css` take effect on next DevTools panel open without a full reload.
