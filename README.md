# Umbraco Debug Tools — Chrome Extension

A Chrome DevTools extension for inspecting **Umbraco Backoffice** element contexts.

## What it does

1. **Detects** whether the current page is running an Umbraco Backoffice (v9–v14+).
2. **Element picker** — click *Select Element* then click any element in the page.
3. **Injects `<umb-debug>`** as the first child of the selected element, placing it inside the element's Umbraco context tree.
4. **Reads and displays** the context data rendered by `<umb-debug>` inside the DevTools panel, as a collapsible JSON tree and raw HTML view.

Works with:
- **Umbraco 14 / Bellissima** (Lit web-component back office)

## Installation

1. Clone / download this repository.
2. Run `python3 generate-icons.py` to create the icons (or use the pre-generated ones in `icons/`).
3. Open Chrome → `chrome://extensions`.
4. Enable **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select this folder.
6. Open any Umbraco back office, open Chrome DevTools (`F12`), and go to the **Umbraco Debug** tab.

## Usage

| Action | Description |
|---|---|
| **Select Element** | Activates crosshair picker; click an element in the page |
| **Escape** | Cancel pick mode |
| **Refresh** | Re-read output from the injected `<umb-debug>` element |
| **Clear** | Remove the injected element and reset the panel |
| **Copy** | Copy the context data to the clipboard |

The **Contexts** tab shows a collapsible JSON tree of all Umbraco context providers visible to the selected element.
The **Raw HTML** tab shows the raw markup rendered by `<umb-debug>`.

## How it works

```
┌─────────────────────────────────────────────┐
│  DevTools Panel (panel.html / panel.js)     │
│   • UI, JSON tree, tab switching            │
└──────────────┬──────────────────────────────┘
               │  chrome.runtime.connect (port)
┌──────────────▼──────────────────────────────┐
│  Background Service Worker (background.js)  │
│   • Routes messages between panel ↔ page    │
└──────────────┬──────────────────────────────┘
               │  chrome.tabs.sendMessage
┌──────────────▼──────────────────────────────┐
│  Content Script (content.js)                │
│   • Detects Umbraco                         │
│   • Handles element picker (hover/click)    │
│   • Injects <umb-debug data-umb-devtools>   │
│   • Polls shadowRoot for rendered output    │
│   • Sends data back to panel                │
└─────────────────────────────────────────────┘
```

## File structure

```
manifest.json        MV3 manifest
devtools.html        DevTools entry page
devtools.js          Creates the DevTools panel tab
background.js        Service worker (message bridge)
content.js           Injected into every page
panel.html           DevTools panel markup
panel.css            Panel styles (dark theme)
panel.js             Panel logic & JSON tree renderer
generate-icons.py    Script to regenerate icons from source
icons/               icon16/32/48/128.png
```
