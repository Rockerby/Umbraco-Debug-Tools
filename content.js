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
  let tooltip = null;
  let extObserver = null;
  let extFallbackTimer = null;

  let previousElement = null;

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

    const url = chrome.runtime.getURL('umb-debug-ext.js');
    console.log('[UmbDevTools] Injecting umb-debug-ext.js as module script:', url);

    const script = document.createElement('script');
    script.type = 'module';
    script.src = url;
    script.addEventListener('load', () => console.log('[UmbDevTools] umb-debug-ext.js loaded OK'));
    script.addEventListener('error', (e) => console.error('[UmbDevTools] umb-debug-ext.js FAILED to load', e));
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
    clearExtWatcher();
    if (injectedDebugEl) injectedDebugEl.remove();
    document.querySelectorAll('[data-umb-devtools-debug]').forEach((el) => el.remove());
    injectedDebugEl = null;
  }

  function clearExtWatcher() {
    if (extObserver) { extObserver.disconnect(); extObserver = null; }
    if (extFallbackTimer) { clearTimeout(extFallbackTimer); extFallbackTimer = null; }
  }

  function injectDebug(targetEl) {
    removeExistingDebug();

    const info = elementInfo(targetEl);
    sendToPanel({ type: 'element-selected', element: info });

    // Inject <umb-debug-ext> first — it gives structured context data via the
    // data-umb-debug-contexts attribute once the page world upgrades it.
    // Fall back to the legacy <umb-debug> approach after a timeout.
    injectExtDebug(targetEl);
  }

  const HIDDEN_STYLE = {
    position: 'absolute',
    width: '0',
    height: '0',
    overflow: 'hidden',
    opacity: '0',
    pointerEvents: 'none',
  };

  function injectExtDebug(targetEl) {
    console.log('[UmbDevTools] injectExtDebug — target:', targetEl.tagName, targetEl.id || '(no id)');

    const extEl = document.createElement('umb-debug-ext');
    extEl.setAttribute('data-umb-devtools-debug', 'true');
    Object.assign(extEl.style, HIDDEN_STYLE);
    targetEl.insertBefore(extEl, targetEl.firstChild);

    previousElement = targetEl.firstChild;

    injectedDebugEl = extEl;

    console.log('[UmbDevTools] <umb-debug-ext> inserted into DOM. Constructor tag:', extEl.constructor?.name ?? '(unknown — not yet upgraded)');
    console.log('[UmbDevTools] Has data-umb-debug-contexts immediately?', extEl.hasAttribute('data-umb-debug-contexts'));

    // The page world upgrades the element and its constructor calls #update()
    // which sets data-umb-debug-contexts once contexts are collected.
    // Check immediately in case upgrade was synchronous.
    if (extEl.hasAttribute('data-umb-debug-contexts')) {
      console.log('[UmbDevTools] Attribute already present — reading immediately');
      sendExtContextData(extEl);
      return;
    }

    // Watch for the attribute via MutationObserver (works across the
    // content-script/page-world boundary since the DOM is shared).
    extObserver = new MutationObserver((mutations) => {
      console.log('[UmbDevTools] MutationObserver fired, mutations:', mutations.map(m => `${m.attributeName}=${extEl.getAttribute(m.attributeName)?.slice(0, 40)}`));
      if (extEl.hasAttribute('data-umb-debug-contexts')) {
        clearExtWatcher();
        sendExtContextData(extEl);
      }
    });
    extObserver.observe(extEl, { attributes: true, attributeFilter: ['data-umb-debug-contexts'] });
    console.log('[UmbDevTools] MutationObserver watching for data-umb-debug-contexts');

    // If umb-debug-ext never sets the attribute (e.g. module failed to load,
    // or element is outside an Umbraco context tree), report an error.
    extFallbackTimer = setTimeout(() => {
      const hasAttr = extEl.hasAttribute('data-umb-debug-contexts');
      const ctorName = extEl.constructor?.name ?? '(unknown)';
      console.warn('[UmbDevTools] Timeout — no data-umb-debug-contexts after 5s. Has attribute:', hasAttr, '| Element constructor:', ctorName);
      clearExtWatcher();
      if (!hasAttr) {
        sendToPanel({ type: 'ext-context-error', error: `umb-debug-ext produced no data (element constructor: ${ctorName}). Check the page console for errors.` });
      }
    }, 5000);
  }

  function sendExtContextData(extEl) {
    const raw = extEl.getAttribute('data-umb-debug-contexts');
    console.log('[UmbDevTools] sendExtContextData — raw attribute length:', raw?.length, 'preview:', raw?.slice(0, 100));
    try {
      const contexts = JSON.parse(raw);
      console.log('[UmbDevTools] Parsed', contexts.length, 'contexts:', contexts.map(c => c.alias));
      sendToPanel({ type: 'ext-context-data', contexts });
    } catch (e) {
      console.error('[UmbDevTools] Failed to parse context data:', e);
      sendToPanel({ type: 'ext-context-error', error: 'Failed to parse context data from umb-debug-ext.' });
    }
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


  // ── Messaging ────────────────────────────────────────────────────────────

  function sendToPanel(msg) {
    console.log('[UmbDevTools] sendToPanel:', msg.type, msg);
    try {
      chrome.runtime.sendMessage(msg);
    } catch (e) {
      console.error('[UmbDevTools] sendToPanel failed (extension context invalidated?):', e);
    }
  }

  // ── Message listener ─────────────────────────────────────────────────────

  // List for messages through the DOM, so we can pass them through to the panel
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'contextData') {
      console.log("Received message on window message bus", event);

      sendToPanel({ type: 'contextData', alias: event.data.data.alias, contextData: event.data.data.props });
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'detect-umbraco': {
        const detected = detectUmbraco();
        console.log('[UmbDevTools] detect-umbraco result:', detected);
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
        if (injectedDebugEl && injectedDebugEl.hasAttribute('data-umb-debug-contexts')) {
          try {
            const contexts = JSON.parse(injectedDebugEl.getAttribute('data-umb-debug-contexts'));
            sendResponse({ contexts });
          } catch {
            sendResponse({ contexts: null });
          }
        } else {
          sendResponse({ contexts: null });
        }
        break;

      case 'get-context-info':
        console.log('hoveredEl', { msgAlias: msg.alias, previousElement });
        // Due to the way that the content runs in isolation we don't have the benefit of being able
        // to call functions on the web component directly, so we do it through attribute watching
        previousElement.setAttribute('data-umb-command', JSON.stringify({ method: 'test', args: [msg.alias] }));

        // setTimeout(function () {
        //   // var contextInfo = injectedDebugEl.getAttribute('data-umb-context-data');
        //   const contextData = JSON.parse(injectedDebugEl.getAttribute('data-umb-context-data'));
        //   console.log("sending a response", contextData);

        //   sendToPanel({ type: 'get-context-info', alias: msg.alias, contextData });

        //   sendResponse({ ok: true });
        // }, 1000);


        // const observer = new MutationObserver((mutations) => {
        //   mutations.forEach(mutation => {
        //     if (mutation.type === 'attributes') {
        //       console.log(`Attribute "${mutation.attributeName}" changed to:`, el.getAttribute(mutation.attributeName));
        //     }
        //   });
        // });

        // observer.observe(el, {
        //   attributes: true,
        //   attributeFilter: ['data-umb-command'] // optional - limit to specific attributes
        // });
        break;

      default:
        sendResponse({});
    }

    // Return true to keep the channel open for async responses
    return true;
  });
})();
