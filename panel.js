/**
 * DevTools panel script.
 *
 * Communicates with the background service worker (which relays messages
 * to/from the content script in the inspected tab).
 *
 * Message flow:
 *   panel → port.postMessage() → background → chrome.tabs.sendMessage() → content
 *   content → chrome.runtime.sendMessage() → background → port.postMessage() → panel
 */

(function () {
  'use strict';

  // ── Connect to background ────────────────────────────────────────────────
  const tabId = chrome.devtools.inspectedWindow.tabId;
  const port  = chrome.runtime.connect({ name: `devtools-${tabId}` });

  function sendToContent(msg) {
    port.postMessage(msg);
  }

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const $  = (id) => document.getElementById(id);

  const statusBadge   = $('status-badge');
  const statusText    = $('status-text');
  const btnPick       = $('btn-pick');
  const btnRefresh    = $('btn-refresh');
  const btnClear      = $('btn-clear');
  const btnCopy       = $('btn-copy');
  const breadcrumb    = $('breadcrumb');
  const bcContent     = $('bc-content');
  const emptyState    = $('empty-state');
  const emptyMessage  = $('empty-message');
  const outputPanel   = $('output-panel');
  const loadingBar    = $('loading-bar');
  const bannerError   = $('banner-error');
  const bannerErrText = $('banner-error-text');
  const bannerInfo    = $('banner-info');
  const bannerInfoTxt = $('banner-info-text');
  const treeView      = $('tree-view');
  const rawHtml       = $('raw-html');
  const tabBtns       = document.querySelectorAll('.tab-btn[data-tab]');

  // ── State ────────────────────────────────────────────────────────────────
  let isUmbraco   = false;
  let isPicking   = false;
  let lastOutput  = null;     // raw output object from content script

  // ── Init ─────────────────────────────────────────────────────────────────
  detectUmbraco();

  // Re-detect when the user navigates to a new page
  chrome.devtools.network.onNavigated.addListener(() => {
    reset();
    detectUmbraco();
  });

  // ── Detection ────────────────────────────────────────────────────────────
  function detectUmbraco() {
    setStatus('checking');
    sendToContent({ type: 'detect-umbraco' });
  }

  function setStatus(state) {
    statusBadge.className = '';
    if (state === 'checking') {
      statusText.textContent = 'Checking…';
    } else if (state === 'detected') {
      statusBadge.classList.add('detected');
      statusText.textContent = 'Umbraco Detected';
      isUmbraco = true;
      btnPick.disabled = false;
      emptyMessage.innerHTML =
        'Click <strong>Select Element</strong> then click any element in the page<br>' +
        'to inspect its Umbraco context data.';
    } else {
      statusBadge.classList.add('not-detected');
      statusText.textContent = 'No Umbraco Found';
      isUmbraco = false;
      btnPick.disabled = true;
      emptyMessage.innerHTML =
        'No Umbraco Backoffice was detected on this page.<br>' +
        'Navigate to the Umbraco back office and re-open the panel.';
    }
  }

  // ── Pick mode ────────────────────────────────────────────────────────────
  btnPick.addEventListener('click', () => {
    if (isPicking) {
      cancelPick();
    } else {
      startPick();
    }
  });

  function startPick() {
    isPicking = true;
    btnPick.classList.add('picking');
    btnPick.querySelector('svg').innerHTML =
      '<path d="M3 3l10 10M3 13L13 3"/>';   // ✕ icon while picking
    btnPick.childNodes[btnPick.childNodes.length - 1].textContent = ' Cancel';
    showInfo('Click any element on the page — press Esc to cancel.');
    sendToContent({ type: 'start-pick' });
  }

  function cancelPick() {
    isPicking = false;
    resetPickButton();
    hideInfo();
    sendToContent({ type: 'stop-pick' });
  }

  function resetPickButton() {
    isPicking = false;
    btnPick.classList.remove('picking');
    btnPick.querySelector('svg').innerHTML =
      '<path d="M1 1l5.5 13 2-5.5L14 6.5z"/>';
    // Reset button text
    btnPick.childNodes[btnPick.childNodes.length - 1].textContent = ' Select Element';
  }

  // ── Toolbar actions ──────────────────────────────────────────────────────
  btnRefresh.addEventListener('click', () => {
    setLoading(true);
    sendToContent({ type: 'refresh-output' });
  });

  btnClear.addEventListener('click', () => {
    sendToContent({ type: 'clear-debug' });
    reset();
  });

  btnCopy.addEventListener('click', () => {
    if (!lastOutput) return;
    const text = buildCopyText(lastOutput);
    navigator.clipboard.writeText(text).then(() => {
      const orig = btnCopy.childNodes[btnCopy.childNodes.length - 1].textContent;
      btnCopy.childNodes[btnCopy.childNodes.length - 1].textContent = ' Copied!';
      setTimeout(() => {
        btnCopy.childNodes[btnCopy.childNodes.length - 1].textContent = orig;
      }, 1500);
    });
  });

  // ── Tab switching ────────────────────────────────────────────────────────
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
      $(`pane-${btn.dataset.tab}`).classList.add('active');
    });
  });

  // ── Message handler ──────────────────────────────────────────────────────
  port.onMessage.addListener((msg) => {
    switch (msg.type) {

      // Response to detect-umbraco
      case 'detect-umbraco-response':
        setStatus(msg.detected ? 'detected' : 'not-detected');
        break;

      // Cancellation via Esc in the page
      case 'pick-cancelled':
        resetPickButton();
        hideInfo();
        break;

      // An element was clicked in pick mode
      case 'element-selected':
        resetPickButton();
        hideInfo();
        showBreadcrumb(msg.element);
        btnRefresh.disabled = false;
        btnClear.disabled   = false;
        setLoading(true);
        showEmpty(false);
        break;

      // umb-debug output received (may be called multiple times as content renders)
      case 'debug-output':
        setLoading(false);
        if (msg.error) {
          showError(msg.error);
        } else if (msg.output) {
          hideError();
          lastOutput = msg.output;
          renderOutput(msg.output);
        }
        break;

      // Response to refresh-output
      case 'refresh-response':
        setLoading(false);
        if (msg.output) {
          hideError();
          lastOutput = msg.output;
          renderOutput(msg.output);
        } else {
          showError('No output yet — the umb-debug element may still be rendering.');
        }
        break;
    }
  });

  // Handle responses that come back synchronously (sendMessage responses
  // are delivered as separate messages in our port-based architecture, but
  // we also use chrome.devtools.inspectedWindow.eval for the initial detect).
  chrome.devtools.inspectedWindow.eval(
    `(function(){
      try {
        // Umbraco 14+ (Bellissima)
        if (document.querySelector('umb-app,umb-backoffice')) return true;
        // umb- prefixed elements anywhere
        var all = document.querySelectorAll('*');
        for (var i=0;i<all.length;i++){
          if (all[i].tagName && all[i].tagName.toLowerCase().startsWith('umb-')) return true;
        }
        // AngularJS-based (Umbraco 9–13)
        var ng = document.querySelector('[ng-app]');
        if (ng && (ng.getAttribute('ng-app')||'').toLowerCase().includes('umbraco')) return true;
        // Globals
        if (typeof Umbraco!=='undefined'||typeof umbApp!=='undefined') return true;
        return false;
      } catch(e){ return false; }
    })()`,
    { useContentScriptContext: false },
    (result, err) => {
      if (err) return;
      setStatus(result ? 'detected' : 'not-detected');
    }
  );

  // ── UI helpers ───────────────────────────────────────────────────────────
  function setLoading(on) {
    loadingBar.classList.toggle('hidden', !on);
  }

  function showEmpty(show) {
    emptyState.classList.toggle('hidden', !show);
    outputPanel.classList.toggle('hidden', show);
  }

  function showBreadcrumb(el) {
    breadcrumb.classList.remove('hidden');
    let html = `<span class="bc-tag">&lt;${el.tag}</span>`;
    if (el.id)    html += `<span class="bc-id">#${el.id}</span>`;
    if (el.classes && el.classes.length)
      html += `<span class="bc-cls">.${el.classes.slice(0, 3).join('.')}</span>`;
    const attrKeys = Object.keys(el.attrs || {}).slice(0, 4);
    attrKeys.forEach((k) => {
      html += `<span class="bc-attr"> ${k}="${el.attrs[k]}"</span>`;
    });
    html += `<span class="bc-tag">&gt;</span>`;
    bcContent.innerHTML = html;
  }

  function showError(msg) {
    bannerErrText.textContent = msg;
    bannerError.classList.remove('hidden');
  }

  function hideError() {
    bannerError.classList.add('hidden');
  }

  function showInfo(msg) {
    bannerInfoTxt.textContent = msg;
    bannerInfo.classList.remove('hidden');
  }

  function hideInfo() {
    bannerInfo.classList.add('hidden');
  }

  function reset() {
    lastOutput = null;
    breadcrumb.classList.add('hidden');
    emptyState.classList.remove('hidden');
    outputPanel.classList.add('hidden');
    btnRefresh.disabled = true;
    btnClear.disabled   = true;
    setLoading(false);
    hideError();
    hideInfo();
    resetPickButton();
    treeView.innerHTML = '';
    rawHtml.textContent = '';
  }

  // ── Output rendering ─────────────────────────────────────────────────────

  function renderOutput(output) {
    showEmpty(false);
    outputPanel.classList.remove('hidden');

    // -- Raw HTML tab --
    if (output.html) {
      rawHtml.textContent = formatHtml(output.html);
    } else if (output.text) {
      rawHtml.textContent = output.text;
    } else {
      rawHtml.textContent = '(no HTML output)';
    }

    // -- Tree tab --
    treeView.innerHTML = '';

    if (output.contexts && typeof output.contexts === 'object') {
      // Structured context map: { "ContextName": {...data} }
      renderContextMap(output.contexts);
    } else if (output.html) {
      // Parse context data out of the HTML
      const parsed = parseContextsFromHtml(output.html);
      if (parsed && Object.keys(parsed).length) {
        renderContextMap(parsed);
      } else {
        // Fall back: show the HTML as a plain tree
        const wrapper = { 'umb-debug output': { _html: output.html } };
        renderContextMap(wrapper);
      }
    } else if (output.text) {
      // Try to parse text as JSON
      try {
        const obj = JSON.parse(output.text);
        renderContextMap(typeof obj === 'object' ? obj : { value: obj });
      } catch {
        treeView.innerHTML = `<div style="padding:8px 12px;color:var(--text-muted)">${escHtml(output.text)}</div>`;
      }
    } else {
      treeView.innerHTML =
        '<div style="padding:8px 12px;color:var(--text-muted)">No structured context data found.</div>';
    }
  }

  /**
   * Parse umb-debug's rendered HTML to extract context names and their JSON data.
   * Umbraco's umb-debug typically renders each context with a heading and
   * a <pre> or <code> block containing JSON.
   */
  function parseContextsFromHtml(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const result = {};

      // Pattern 1: heading followed by pre/code
      const headings = doc.querySelectorAll('h1,h2,h3,h4,h5,label,[class*="name"],[class*="title"]');
      headings.forEach((h) => {
        const key = h.textContent.trim();
        if (!key) return;
        let next = h.nextElementSibling;
        while (next) {
          const text = next.textContent.trim();
          if (text) {
            try { result[key] = JSON.parse(text); }
            catch { result[key] = text; }
            break;
          }
          next = next.nextElementSibling;
        }
      });

      if (Object.keys(result).length) return result;

      // Pattern 2: definition lists
      const dts = doc.querySelectorAll('dt');
      dts.forEach((dt) => {
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === 'DD') {
          const key = dt.textContent.trim();
          const val = dd.textContent.trim();
          try { result[key] = JSON.parse(val); }
          catch { result[key] = val; }
        }
      });

      if (Object.keys(result).length) return result;

      // Pattern 3: try parsing the entire text as JSON
      const allText = doc.body.textContent.trim();
      if (allText) {
        const parsed = JSON.parse(allText);
        return typeof parsed === 'object' ? parsed : { data: parsed };
      }
    } catch {
      // Ignore parse errors
    }
    return null;
  }

  /**
   * Render a map of context name → data as collapsible sections, each with
   * a JSON tree inside.
   */
  function renderContextMap(ctxMap) {
    treeView.innerHTML = '';

    if (!ctxMap || !Object.keys(ctxMap).length) {
      treeView.innerHTML =
        '<div style="padding:8px 12px;color:var(--text-muted)">No contexts found.</div>';
      return;
    }

    Object.keys(ctxMap).forEach((ctxName) => {
      const section    = document.createElement('div');
      section.className = 'ctx-section';

      const header = document.createElement('div');
      header.className = 'ctx-section-header';
      header.innerHTML =
        `<span class="ctx-toggle">▾</span>` +
        `<span class="ctx-name">${escHtml(ctxName)}</span>`;

      const body = document.createElement('div');
      body.className = 'ctx-section-body';

      // Build JSON tree for the value
      const valueNode = buildTreeNode(ctxMap[ctxName], null, 0);
      body.appendChild(valueNode);

      header.addEventListener('click', () => {
        body.classList.toggle('collapsed');
        header.querySelector('.ctx-toggle').textContent =
          body.classList.contains('collapsed') ? '▸' : '▾';
      });

      section.appendChild(header);
      section.appendChild(body);
      treeView.appendChild(section);
    });
  }

  /**
   * Build a collapsible JSON tree node.
   */
  function buildTreeNode(value, key, depth) {
    const container = document.createElement('div');
    container.className = 'tree-node';

    if (value === null) {
      container.appendChild(makeRow(key, makeSpan('null', 'tree-null'), depth, false));
    } else if (typeof value === 'boolean') {
      container.appendChild(makeRow(key, makeSpan(String(value), 'tree-bool'), depth, false));
    } else if (typeof value === 'number') {
      container.appendChild(makeRow(key, makeSpan(String(value), 'tree-num'), depth, false));
    } else if (typeof value === 'string') {
      container.appendChild(makeRow(key, makeSpan(`"${escHtml(value)}"`, 'tree-str'), depth, false));
    } else if (Array.isArray(value)) {
      const toggle   = makeToggle();
      const count    = makeSpan(` [${value.length}]`, 'tree-count');
      const row      = makeRow(key, count, depth, true, toggle);
      const children = document.createElement('div');
      children.className = 'tree-children';

      value.slice(0, 200).forEach((v, i) => {
        children.appendChild(buildTreeNode(v, String(i), depth + 1));
      });
      if (value.length > 200) {
        const more = document.createElement('div');
        more.className = 'tree-row';
        more.style.color = 'var(--text-muted)';
        more.style.paddingLeft = `${8 + (depth + 1) * 16}px`;
        more.textContent = `… ${value.length - 200} more items`;
        children.appendChild(more);
      }

      wireToggle(toggle, children);
      container.appendChild(row);
      container.appendChild(children);
    } else if (typeof value === 'object') {
      const keys   = Object.keys(value);
      const toggle = makeToggle();
      const count  = makeSpan(` {${keys.length}}`, 'tree-count');
      const row    = makeRow(key, count, depth, true, toggle);
      const children = document.createElement('div');
      children.className = 'tree-children';

      keys.slice(0, 200).forEach((k) => {
        children.appendChild(buildTreeNode(value[k], k, depth + 1));
      });
      if (keys.length > 200) {
        const more = document.createElement('div');
        more.className = 'tree-row';
        more.style.color = 'var(--text-muted)';
        more.style.paddingLeft = `${8 + (depth + 1) * 16}px`;
        more.textContent = `… ${keys.length - 200} more keys`;
        children.appendChild(more);
      }

      wireToggle(toggle, children);
      container.appendChild(row);
      container.appendChild(children);
    } else {
      container.appendChild(
        makeRow(key, makeSpan(escHtml(String(value)), 'tree-str'), depth, false)
      );
    }

    return container;
  }

  function makeRow(key, valueEl, depth, collapsible, toggle) {
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.style.paddingLeft = `${8 + depth * 16}px`;

    if (toggle) row.appendChild(toggle);
    else {
      const spacer = document.createElement('span');
      spacer.className = 'toggle';
      row.appendChild(spacer);
    }

    if (key !== null) {
      const keyEl = document.createElement('span');
      keyEl.className = 'tree-key';
      keyEl.textContent = key;
      row.appendChild(keyEl);

      const colon = document.createElement('span');
      colon.className = 'tree-colon';
      colon.textContent = ':';
      row.appendChild(colon);
    }

    row.appendChild(valueEl);
    return row;
  }

  function makeSpan(html, cls) {
    const s = document.createElement('span');
    s.className = cls;
    s.innerHTML = html;
    return s;
  }

  function makeToggle() {
    const t = document.createElement('span');
    t.className = 'toggle';
    t.textContent = '▾';
    return t;
  }

  function wireToggle(toggle, children) {
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      children.classList.toggle('collapsed');
      toggle.textContent = children.classList.contains('collapsed') ? '▸' : '▾';
    });
    // Also allow clicking the row to collapse
    toggle.closest && toggle.closest('.tree-row') &&
      toggle.closest('.tree-row').addEventListener('click', () => {
        children.classList.toggle('collapsed');
        toggle.textContent = children.classList.contains('collapsed') ? '▸' : '▾';
      });
  }

  // ── Utilities ────────────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatHtml(html) {
    // Basic indentation of HTML for the raw tab
    let indent = 0;
    return html
      .replace(/></g, '>\n<')
      .split('\n')
      .map((line) => {
        line = line.trim();
        if (!line) return '';
        if (line.startsWith('</')) indent = Math.max(0, indent - 1);
        const result = '  '.repeat(indent) + line;
        if (!line.startsWith('</') && !line.startsWith('</')
            && !line.endsWith('/>') && line.startsWith('<')
            && !line.includes('</')) {
          indent++;
        }
        return result;
      })
      .filter(Boolean)
      .join('\n');
  }

  function buildCopyText(output) {
    const parts = [];
    if (output.contexts) {
      parts.push(JSON.stringify(output.contexts, null, 2));
    }
    if (output.html) {
      parts.push('\n--- Raw HTML ---\n' + output.html);
    }
    if (output.text) {
      parts.push(output.text);
    }
    return parts.join('\n') || JSON.stringify(output, null, 2);
  }
})();
