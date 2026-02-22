/**
 * Content script — runs inside the inspected page.
 *
 * Responsibilities:
 *  1. Detect whether the page is running the Umbraco Backoffice.
 *  2. Handle "pick element" mode (highlight on hover, select on click).
 *  3. Inject <umb-debug> into the selected element and read its output.
 *  4. Stream debug output back to the DevTools panel via the background.
 */

(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────────
  let isPicking = false;
  let hoveredEl = null;
  let injectedDebugEl = null;
  let pollTimer = null;
  let tooltip = null;
  // Tracks every root (document or ShadowRoot) where the pick-mode cursor
  // style has been injected, so they can all be cleaned up on stop.
  const pickCursorRoots = new Set();

  // ── umb-debug-ext element injection ──────────────────────────────────────

  let umbDebugExtInjected = false;

  /**
   * Inject umb-debug-ext.js as a <script type="module"> into the page.
   * The script uses the page's import map to resolve @umbraco-cms/* modules,
   * so it must run in the main page world (not the content script's isolated world).
   * Guarded so it only happens once per page load.
   */
  function injectUmbDebugExt() {
    if (umbDebugExtInjected) return;
    umbDebugExtInjected = true;

    const script = document.createElement('script');
    script.type = 'module';
    script.src = chrome.runtime.getURL('umb-debug-ext.js');
    (document.head || document.documentElement).appendChild(script);
  }

  // ── Umbraco Detection ────────────────────────────────────────────────────

  function detectUmbraco() {
    // Umbraco 14+ (Bellissima) — Lit-based web components
    if (document.querySelector('umb-app, umb-backoffice')) return true;

    // Any custom element with umb- prefix rendered in the page
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.tagName && node.tagName.toLowerCase().startsWith('umb-')) return true;
    }

    // Umbraco 9–13 (AngularJS-based) — check ng-app attribute
    const ngRoot = document.querySelector('[ng-app]');
    if (ngRoot) {
      const app = ngRoot.getAttribute('ng-app') || '';
      if (app.toLowerCase().includes('umbraco')) return true;
    }

    // Global variables set by Umbraco
    if (
      typeof window.Umbraco !== 'undefined' ||
      typeof window.umbApp !== 'undefined' ||
      typeof window._umb !== 'undefined'
    ) {
      return true;
    }

    return false;
  }

  // ── Tooltip helper ───────────────────────────────────────────────────────

  function createTooltip() {
    tooltip = document.createElement('div');
    tooltip.id = '__umb_devtools_tooltip__';
    Object.assign(tooltip.style, {
      position: 'fixed',
      zIndex: '2147483647',
      background: '#1a2e4a',
      color: '#fff',
      fontSize: '11px',
      fontFamily: 'monospace',
      padding: '3px 8px',
      borderRadius: '3px',
      pointerEvents: 'none',
      display: 'none',
      maxWidth: '300px',
      boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
    });
    document.body.appendChild(tooltip);
  }

  function updateTooltip(el, e) {
    if (!tooltip) return;
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    tooltip.textContent = `${tag}${id}${cls}`;
    tooltip.style.display = 'block';
    tooltip.style.left = Math.min(e.clientX + 12, window.innerWidth - 310) + 'px';
    tooltip.style.top = (e.clientY + 18) + 'px';
  }

  function removeTooltip() {
    if (tooltip) {
      tooltip.remove();
      tooltip = null;
    }
  }

  // ── Shadow-DOM-aware element picking ─────────────────────────────────────

  /**
   * Like document.elementFromPoint but recursively pierces open shadow roots
   * so that elements nested deep in the shadow DOM can be selected.
   */
  function deepElementFromPoint(x, y, root) {
    const el = (root || document).elementFromPoint(x, y);
    if (!el) return null;
    // Only recurse if the element has a shadow root that is different from the
    // root we just searched. When a shadow root's elementFromPoint returns its
    // own host element, el.shadowRoot === root and recursing would loop forever.
    if (el.shadowRoot && el.shadowRoot !== root) {
      return deepElementFromPoint(x, y, el.shadowRoot) || el;
    }
    return el;
  }

  /**
   * Inject `* { cursor: crosshair !important }` into a root node so the
   * crosshair cursor appears even on shadow-DOM elements that have their own
   * cursor styles (e.g. Umbraco's uui-button sets cursor:pointer).
   * Called once for document at pick-mode start, then lazily for each
   * shadow root the mouse enters.
   */
  function injectPickCursor(root) {
    if (pickCursorRoots.has(root)) return;
    pickCursorRoots.add(root);
    const container = root === document ? document.head : root;
    const style = document.createElement('style');
    style.id = '__umb_devtools_cursor__';
    style.textContent = '* { cursor: crosshair !important; }';
    container.appendChild(style);
  }

  function removePickCursors() {
    for (const root of pickCursorRoots) {
      const container = root === document ? document.head : root;
      const s = container.querySelector('#__umb_devtools_cursor__');
      if (s) s.remove();
    }
    pickCursorRoots.clear();
  }

  // ── Highlight helpers ────────────────────────────────────────────────────

  function highlightElement(el) {
    clearHighlight();
    hoveredEl = el;
    // Use inline styles so the highlight works inside shadow roots
    // (a stylesheet injected into document.head cannot pierce shadow DOM).
    el._umbOrigOutline = el.style.outline;
    el._umbOrigOutlineOffset = el.style.outlineOffset;
    el.style.outline = '2px solid #0085ff';
    el.style.outlineOffset = '2px';
  }

  function clearHighlight() {
    if (hoveredEl) {
      hoveredEl.style.outline = hoveredEl._umbOrigOutline || '';
      hoveredEl.style.outlineOffset = hoveredEl._umbOrigOutlineOffset || '';
      delete hoveredEl._umbOrigOutline;
      delete hoveredEl._umbOrigOutlineOffset;
      hoveredEl = null;
    }
  }

  // ── Pick-mode event handlers ─────────────────────────────────────────────

  function onMouseMove(e) {
    const el = deepElementFromPoint(e.clientX, e.clientY);
    if (!el || el === tooltip || el.hasAttribute?.('data-umb-devtools-debug')) return;
    // Lazily inject the crosshair cursor style into any new shadow root we enter.
    let root = el.getRootNode();
    while (root instanceof ShadowRoot) {
      injectPickCursor(root);
      root = root.host.getRootNode();
    }
    highlightElement(el);
    updateTooltip(el, e);
  }

  function onMouseLeave() {
    clearHighlight();
    if (tooltip) tooltip.style.display = 'none';
  }

  function onClick(e) {
    e.preventDefault();
    e.stopImmediatePropagation();

    // hoveredEl is already resolved via deepElementFromPoint in onMouseMove.
    // Fall back to composedPath()[0] rather than e.target, since e.target is
    // retargeted to the shadow host when the click lands inside a shadow root.
    const el = hoveredEl
      || e.composedPath().find(n => n instanceof Element)
      || e.target;
    clearHighlight();
    stopPickMode();
    removeTooltip();
    injectDebug(el);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      stopPickMode();
      removeTooltip();
      sendToPanel({ type: 'pick-cancelled' });
    }
  }

  // ── Pick mode ────────────────────────────────────────────────────────────

  function startPickMode() {
    if (isPicking) return;
    isPicking = true;
    injectPickCursor(document);
    createTooltip();
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseleave', onMouseLeave, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
  }

  function stopPickMode() {
    if (!isPicking) return;
    isPicking = false;
    removePickCursors();
    clearHighlight();
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('mouseleave', onMouseLeave, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
  }

  // ── umb-debug injection ──────────────────────────────────────────────────

  function removeExistingDebug() {
    clearPollTimer();
    document.querySelectorAll('[data-umb-devtools-debug]').forEach((el) => el.remove());
    injectedDebugEl = null;
  }

  function injectDebug(targetEl) {
    removeExistingDebug();

    const debugEl = document.createElement('umb-debug');
    debugEl.setAttribute('dialog', '');
    debugEl.setAttribute('visible', '');
    debugEl.setAttribute('data-umb-devtools-debug', 'true');

    // Make it invisible in the page itself — output only goes to DevTools panel.
    // Using visibility:hidden keeps it in the layout / shadow tree so Umbraco
    // can still resolve its context providers.
    Object.assign(debugEl.style, {
      position: 'absolute',
      width: '0',
      height: '0',
      overflow: 'hidden',
      opacity: '0',
      pointerEvents: 'none',
    });

    // Insert as the first child so it sits inside the element's context tree.
    targetEl.insertBefore(debugEl, targetEl.firstChild);
    injectedDebugEl = debugEl;

    const info = elementInfo(targetEl);
    sendToPanel({ type: 'element-selected', element: info });

    // Begin polling for rendered output
    startPolling(debugEl);
  }

  function elementInfo(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id || null;
    const classes = typeof el.className === 'string'
      ? el.className.trim().split(/\s+/).filter(Boolean)
      : [];
    const attrs = {};
    for (const a of el.attributes) {
      if (!['style', 'class', 'id'].includes(a.name)) {
        attrs[a.name] = a.value;
      }
    }
    return { tag, id, classes, attrs };
  }

  // ── Poll for umb-debug output ────────────────────────────────────────────

  function startPolling(debugEl) {
    let attempts = 0;
    const maxAttempts = 60; // 30 s at 500 ms intervals
    let lastContent = null;

    pollTimer = setInterval(() => {
      attempts++;

      const output = readDebugOutput(debugEl);

      if (output !== null && output !== lastContent) {
        lastContent = output;
        sendToPanel({ type: 'debug-output', output });
      }

      if (attempts >= maxAttempts) {
        clearPollTimer();
        if (lastContent === null) {
          sendToPanel({
            type: 'debug-output',
            output: null,
            error: 'umb-debug produced no output. Make sure this element is inside an Umbraco context tree.',
          });
        }
      }
    }, 500);
  }

  function clearPollTimer() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /**
   * Try multiple strategies to read what umb-debug has rendered.
   * Returns a structured result object or null if nothing is available yet.
   */
  function readDebugOutput(debugEl) {
    // Strategy 1: open shadow root (Umbraco 14+ Lit components)
    if (debugEl.shadowRoot) {
      const raw = debugEl.shadowRoot.innerHTML;
      if (raw && raw.trim() && raw !== '<slot></slot>') {
        return { source: 'shadow', html: raw, contexts: extractContexts(debugEl.shadowRoot) };
      }
    }

    // Strategy 2: light DOM children added by Umbraco (older or polyfilled)
    if (debugEl.childElementCount > 0) {
      return { source: 'light', html: debugEl.innerHTML, contexts: null };
    }

    // Strategy 3: text content
    const text = debugEl.textContent && debugEl.textContent.trim();
    if (text) {
      return { source: 'text', html: null, text, contexts: null };
    }

    // Strategy 4: introspect internal Lit/Umbraco state
    const ctxData = extractContextsFromElement(debugEl);
    if (ctxData) {
      return { source: 'api', html: null, contexts: ctxData };
    }

    return null;
  }

  /**
   * Walk a shadow root's DOM tree to pull out any rendered context blocks.
   * umb-debug typically renders each context as a labelled section.
   */
  function extractContexts(shadowRoot) {
    try {
      const result = {};
      // Common pattern: headings + pre/code blocks
      const headings = shadowRoot.querySelectorAll('h3, h4, [class*="context-name"], [class*="label"]');
      headings.forEach((h) => {
        const key = h.textContent.trim();
        const sibling = h.nextElementSibling;
        if (sibling) {
          const val = sibling.textContent.trim();
          try { result[key] = JSON.parse(val); } catch { result[key] = val; }
        }
      });
      return Object.keys(result).length ? result : null;
    } catch {
      return null;
    }
  }

  /**
   * Attempt to read Umbraco's internal context data from the element's
   * JavaScript state (works when the custom element exposes its controller).
   */
  function extractContextsFromElement(el) {
    try {
      // Lit elements store their reactive properties on the instance
      const possibleKeys = [
        '_contexts', '__contexts', 'contexts',
        '_contextData', 'contextData',
        '_data', 'data',
      ];
      for (const key of possibleKeys) {
        if (el[key] && typeof el[key] === 'object') {
          return sanitizeForTransfer(el[key]);
        }
      }
    } catch {
      // Ignore cross-origin or proxy errors
    }
    return null;
  }

  /**
   * Make an object safe to pass through chrome.runtime.sendMessage
   * (removes non-serialisable values).
   */
  function sanitizeForTransfer(obj, depth = 0) {
    if (depth > 5) return '[nested]';
    if (obj === null || obj === undefined) return obj;
    const type = typeof obj;
    if (type === 'function') return '[Function]';
    if (type === 'symbol') return '[Symbol]';
    if (type !== 'object') return obj;
    if (obj instanceof Error) return { message: obj.message };
    if (Array.isArray(obj)) return obj.slice(0, 50).map((v) => sanitizeForTransfer(v, depth + 1));

    const result = {};
    let count = 0;
    for (const key of Object.keys(obj)) {
      if (count++ > 100) { result['__truncated__'] = true; break; }
      try { result[key] = sanitizeForTransfer(obj[key], depth + 1); } catch { result[key] = '[Error reading]'; }
    }
    return result;
  }

  // ── Messaging ────────────────────────────────────────────────────────────

  function sendToPanel(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch {
      // Extension context may have been invalidated
    }
  }

  // ── Message listener ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'detect-umbraco': {
        const detected = detectUmbraco();
        if (detected) injectUmbDebugExt();
        sendResponse({ detected });
        break;
      }

      case 'start-pick':
        startPickMode();
        sendResponse({ ok: true });
        break;

      case 'stop-pick':
        stopPickMode();
        removeTooltip();
        sendResponse({ ok: true });
        break;

      case 'clear-debug':
        removeExistingDebug();
        sendResponse({ ok: true });
        break;

      case 'refresh-output':
        if (injectedDebugEl) {
          const output = readDebugOutput(injectedDebugEl);
          sendResponse({ output });
        } else {
          sendResponse({ output: null });
        }
        break;

      default:
        sendResponse({});
    }

    // Return true to keep the channel open for async responses
    return true;
  });
})();
