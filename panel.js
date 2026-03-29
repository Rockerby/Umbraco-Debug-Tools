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
  let port = connectPort();

  function connectPort() {
    const p = chrome.runtime.connect({ name: `devtools-${tabId}` });
    p.onMessage.addListener(handleMessage);
    p.onDisconnect.addListener(() => {
      port = connectPort();
    });
    return p;
  }

  // ── Message handler ──────────────────────────────────────────────────────
  function handleMessage(msg) {
    internalLog('[UmbDevTools panel] Received message:', msg.type, msg);
    switch (msg.type) {

      // Response to detect-umbraco
      case 'detect-umbraco-response':
        internalLog("received detected callback...", msg);
        setStatus(msg.detected ? 'detected' : 'not-detected');
        if (msg.detected) {
          clearInterval(detectionTask);
          detectionTask = -1;
        }
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
        //btnRefresh.disabled = false;
        btnClear.disabled = false;
        setLoading(true);
        showEmpty(false);
        break;

      // Structured context data from <umb-debug-ext>
      case 'ext-context-data':
        setLoading(false);
        hideError();
        lastOutput = { _ext: true, contexts: msg.contexts };
        renderUmbExtContexts(msg.contexts);
        break;

      // umb-debug-ext failed to produce data within the timeout
      case 'ext-context-error':
        setLoading(false);
        showError(msg.error);
        break;

      // Response to refresh-output
      case 'refresh-response':
        setLoading(false);
        if (msg.contexts) {
          hideError();
          lastOutput = { _ext: true, contexts: msg.contexts };
          renderUmbExtContexts(msg.contexts);
        } else {
          showError('No context data yet — the element may still be rendering.');
        }
        break;

      case 'get-context-info':
        internalLog("[get-context-info] We got a message back...", msg);
        
        break;

      case 'contextData':
        internalLog("[ContextData] Arrived in panel", msg);
        if (msg.contextData) {
          var id = 'ctx-parent_' + msg.alias;
          var div = document.getElementById(id);
          div.innerHTML = '';
          const html = contextJsonToHtml(msg.contextData);
          div.appendChild(html);
        }
        break;
    }
  }

  function sendToContent(msg) {
    internalLog('[UmbDevTools panel] sendToContent →', msg.type, port);
    try {
      port.postMessage(msg);
    } catch (err) {
      internalLog("PORT FAILED, reconnecting:", err);
      port = connectPort();
      port.postMessage(msg);
    }
  }

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const statusBadge = $('status-badge');
  const statusText = $('status-text');
  const btnPick = $('btn-pick');
  const btnClear = $('btn-clear');
  const btnCopy = $('btn-copy');
  const breadcrumb = $('breadcrumb');
  const bcContent = $('bc-content');
  const emptyState = $('empty-state');
  const emptyMessage = $('empty-message');
  const outputPanel = $('output-panel');
  const loadingBar = $('loading-bar');
  const bannerError = $('banner-error');
  const bannerErrText = $('banner-error-text');
  const bannerInfo = $('banner-info');
  const bannerInfoTxt = $('banner-info-text');
  const treeView = $('tree-view');
  const rawHtml = $('raw-html');
  const tabBtns = document.querySelectorAll('.tab-btn[data-tab]');

  let detectionTask = -1;

  // ── State ────────────────────────────────────────────────────────────────
  let isUmbraco = false;
  let isPicking = false;
  let lastOutput = null;     // raw output object from content script

  // ── Init ─────────────────────────────────────────────────────────────────
  detectUmbraco();

  // Re-detect when the user navigates to a new page
  chrome.devtools.network.onNavigated.addListener(() => {
    internalLog("navigated HEY");
    reset();
    detectUmbraco();
  });

  // ── Detection ────────────────────────────────────────────────────────────
  function detectUmbraco() {
    if (detectionTask > 0) {
      clearInterval(detectionTask);
    }
    setStatus('checking');
    isUmbraco = false;

    // Retry until the content script responds (it may not be ready yet after a navigation)
    let attempts = 0;
    detectionTask = setInterval(() => {
      if (isUmbraco || attempts++ > 20) {
        clearInterval(detectionTask);
        detectionTask = -1;
        return;
      }
      sendToContent({ type: 'detect-umbraco' });
    }, 500);

    // Send immediately too
    sendToContent({ type: 'detect-umbraco' });
  }

  function setStatus(state) {
    statusBadge.className = 'btn';
    if (state === 'checking') {
      statusText.textContent = 'Checking…';
      emptyMessage.innerHTML = 'Currently looking for your Umbraco instance...';
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

  function contextJsonToHtml(data, depth = 0) {
  const indent = (depth + 1) * 16;

  if (data === null) return makeContextSpan('json-null', 'null');
  if (data === undefined) return makeContextSpan('json-undefined', 'undefined');

  switch (typeof data) {
    case 'boolean':
      return makeContextSpan('json-boolean', String(data));
    case 'number':
      return makeContextSpan('json-number', String(data));
    case 'string':
      return makeContextSpan('json-string', `"${escapeHtml(data)}"`);
    case 'object':
      if (Array.isArray(data)) {
        if (data.length === 0) return makeContextSpan('json-bracket', '[]');
        return makeContextCollapsible('[ ]', data.length, data.map((item, i) => {
          const row = document.createElement('div');
          row.className = 'ctx-prop-row';
          row.appendChild(contextJsonToHtml(item, depth + 1));
          if (i < data.length - 1) row.appendChild(makeContextSpan('json-comma', ','));
          return row;
        }), indent);
      } else {
        const keys = Object.keys(data);
        if (keys.length === 0) return makeContextSpan('json-bracket', '{}');
        let propName = depth == 0 ? "Properties" : "{ }";
        return makeContextCollapsible(propName, keys.length, keys.map((key, i) => {
          const row = document.createElement('div');
          row.className = 'ctx-prop-row';

          const keyEl = makeContextSpan('ctx-prop-key', key);
          const eq = makeContextSpan('ctx-prop-eq', '=');
          const val = contextJsonToHtml(data[key], depth + 1);

          row.appendChild(keyEl);
          row.appendChild(eq);
          row.appendChild(val);
          if (i < keys.length - 1) row.appendChild(makeContextSpan('json-comma', ','));
          return row;
        }), indent);
      }
    default:
      return makeContextSpan('json-unknown', escapeHtml(String(data)));
  }
}

function makeContextCollapsible(title, count, rows, indent) {
  const wrap = document.createElement('div');
  wrap.className = 'ctx-subsection';

  const header = document.createElement('div');
  header.className = 'ctx-subsection-header';

  const toggle = makeContextSpan('ctx-toggle', '▸');
  const titleEl = makeContextSpan('ctx-subsection-title', title);
  const countEl = makeContextSpan('ctx-count', `(${count})`);

  header.appendChild(toggle);
  header.appendChild(titleEl);
  header.appendChild(countEl);

  const body = document.createElement('div');
  body.className = 'ctx-subsection-body collapsed';
  //body.style.paddingLeft = `${indent}px`;

  rows.forEach(row => body.appendChild(row));

  header.addEventListener('click', () => {
    body.classList.toggle('collapsed');
    toggle.textContent = body.classList.contains('collapsed') ? '▸' : '▾';
  });

  wrap.appendChild(header);
  wrap.appendChild(body);
  return wrap;
}

function makeContextSpan(className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}




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
    if (el.id) html += `<span class="bc-id">#${el.id}</span>`;
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
    isUmbraco = false;
    breadcrumb.classList.add('hidden');
    emptyState.classList.remove('hidden');
    outputPanel.classList.add('hidden');
    //btnRefresh.disabled = true;
    btnClear.disabled = true;
    setLoading(false);
    hideError();
    hideInfo();
    resetPickButton();
    treeView.innerHTML = '';
    rawHtml.textContent = '';
  }

  // ── Umbraco ext context rendering ────────────────────────────────────────

  /**
   * Render structured context data from <umb-debug-ext> — mirrors the layout
   * of the Umbraco context debugger modal: one collapsible section per context,
   * each with Methods (collapsed) and Properties (expanded) subsections.
   *
   * @param {Array<{alias, type, methods?, properties?, value?}>} contexts
   */
  function renderUmbExtContexts(contexts) {
    internalLog('[UmbDevTools panel] renderUmbExtContexts — count:', contexts?.length, contexts);
    showEmpty(false);
    outputPanel.classList.remove('hidden');
    treeView.innerHTML = '';

    // Raw tab shows JSON for easy copying
    rawHtml.textContent = JSON.stringify(contexts, null, 2);

    if (!contexts || !contexts.length) {
      treeView.innerHTML =
        '<div style="padding:16px 12px;color:var(--text-muted)">No contexts found on this element.</div>';
      return;
    }

    contexts.forEach(({ alias, type, methods, properties, value }) => {
      const section = document.createElement('div');
      section.className = 'ctx-section';

      const header = document.createElement('div');
      header.className = 'ctx-section-header';

      header.dataset.alias = alias;

      header.innerHTML =
        `<span class="ctx-toggle">▸</span>` +
        `<span class="ctx-name">${escHtml(alias)}</span>` +
        `<span class="ctx-type-badge">${escHtml(type)}</span>`;

      const body = document.createElement('div');
      body.className = 'ctx-section-body collapsed';

      if (type === 'function') {
        const label = document.createElement('div');
        label.className = 'ctx-callable';
        label.textContent = 'Callable Function';
        body.appendChild(label);
      } else if (type === 'primitive') {
        const row = document.createElement('div');
        row.className = 'ctx-primitive';
        row.appendChild(makeValueSpan(value, typeof value));
        body.appendChild(row);
      } else if (type === 'object') {

        if (methods && methods.length) {
          body.appendChild(buildMethodsSection(methods));
        }

        body.appendChild(buildInstanceSection(alias));
        

        if (!methods?.length && !properties?.length) {
          const empty = document.createElement('div');
          empty.className = 'ctx-callable';
          empty.textContent = 'No methods or properties.';
          body.appendChild(empty);
        }
      }

      header.addEventListener('click', () => {
        body.classList.toggle('collapsed');
        const isOpen = !body.classList.contains('collapsed');

        if (isOpen) {
          // Auto-fetch and expand properties when the section is opened
          sendToContent({ type: 'get-context-info', alias });
          const propsBody = body.querySelector(`[data-context-alias="${alias}"]`);
          if (propsBody) {
            propsBody.classList.remove('collapsed');
            const propsToggle = propsBody.previousElementSibling?.querySelector('.ctx-toggle');
            if (propsToggle) propsToggle.textContent = '▾';
          }
        }

        header.querySelector('.ctx-toggle').textContent =
          body.classList.contains('collapsed') ? '▸' : '▾';
      });

      section.appendChild(header);
      section.appendChild(body);
      treeView.appendChild(section);
    });
  }

  function buildMethodsSection(methods) {
    const section = document.createElement('div');
    section.className = 'ctx-subsection';

    const header = document.createElement('div');
    header.className = 'ctx-subsection-header';
    header.innerHTML =
      `<span class="ctx-toggle">▸</span>` +
      `<span class="ctx-subsection-title">Methods</span>` +
      `<span class="ctx-count">(${methods.length})</span>`;

    const body = document.createElement('div');
    body.className = 'ctx-subsection-body collapsed';

    methods.forEach((name) => {
      const row = document.createElement('div');
      row.className = 'ctx-method-row';
      row.innerHTML =
        `<span class="ctx-method-name">${escHtml(name)}</span>` +
        `<span class="ctx-method-parens">()</span>`;
      body.appendChild(row);
    });

    header.addEventListener('click', () => {
      body.classList.toggle('collapsed');
      header.querySelector('.ctx-toggle').textContent =
        body.classList.contains('collapsed') ? '▸' : '▾';
    });

    section.appendChild(header);
    section.appendChild(body);
    return section;
  }

  function buildInstanceSection(alias) {
    const section = document.createElement('div');
    section.className = 'ctx-subsection';

    const header = document.createElement('div');
    header.className = 'ctx-subsection-header';
      //`<span class="ctx-count">(expand)</span>`;

    const body = document.createElement('div');
    body.className = 'ctx-subsection-body collapsed';
    body.id = 'ctx-parent_' + alias;
    body.dataset.contextAlias = alias;

    header.addEventListener('click', () => {
      body.classList.toggle('collapsed');
      header.querySelector('.ctx-toggle').textContent =
        body.classList.contains('collapsed') ? '▸' : '▾';
    });

    //section.appendChild(header);
    section.appendChild(body);

    return section;
  }

  /** Return a colored <span> for a primitive value. */
  function makeValueSpan(value, type) {
    if (value === null) return makeSpan('null', 'tree-null');
    if (type === 'boolean') return makeSpan(String(value), 'tree-bool');
    if (type === 'number') return makeSpan(String(value), 'tree-num');
    if (type === 'string') return makeSpan(`"${escHtml(String(value))}"`, 'tree-str');
    // fallback
    return makeSpan(escHtml(String(value)), 'tree-str');
  }

  function makeSpan(html, cls) {
    const s = document.createElement('span');
    s.className = cls;
    s.innerHTML = html;
    return s;
  }

  // ── Utilities ────────────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildCopyText(output) {
    return JSON.stringify(output.contexts, null, 2);
  }

  
  
  function internalLog(...args) {
    //console.log(...args);
  }
})();
