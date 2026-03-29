/**
 * Plain-JavaScript version of umb-debug-src.js for Chrome extension injection.
 *
 * Injected as a <script type="module"> into the Umbraco backoffice page so it
 * can use the page's import map to resolve @umbraco-cms/backoffice/* modules.
 * Defines the <umb-debug-ext> custom element using the same logic as the
 * Umbraco source, but without TypeScript decorators or the modal dialog feature.
 */

import { css, html, map, nothing, when } from '@umbraco-cms/backoffice/external/lit';
import { contextData, UmbContextDebugRequest } from '@umbraco-cms/backoffice/context-api';
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element';
import { firstValueFrom } from '@umbraco-cms/backoffice/external/rxjs';

class UmbDebugElementExt extends UmbLitElement {
  static properties = {
    visible: { type: Boolean },
    dialog: { type: Boolean },
    _contexts: { state: true },
    _debugPaneOpen: { state: true },
  };

  callbackTimeoutId = -1;

  constructor() {

    super();
    this.visible = false;
    this.dialog = false;
    this._contexts = new Map();
    this._debugPaneOpen = false;

    this.#update();
  }

  connectedCallback() {
    super.connectedCallback();
    this.#internalLog("connected callback");
    this.#update();

  }

  static get observedAttributes() {
    return ['data-umb-command'];
  }

  attributeChangedCallback(name, oldValue, newValue) {
    super.attributeChangedCallback?.(name, oldValue, newValue);
    if (name === 'data-umb-command' && newValue) {
      const { method, args } = JSON.parse(newValue);
      if (typeof this[method] === 'function') {
        this[method](...(args || []));
      }
      // Clear it so the same command can be re-triggered later
      this.removeAttribute('data-umb-command');
    }
  }


  test(ins) {
    this.#getContextInfo(ins);
  }

  #update() {
    this.#internalLog("update called");
    this.dispatchEvent(
      new UmbContextDebugRequest((contexts) => {
        this.#internalLog("callback with context...", contexts);
        this._contexts = contexts;
        this.#exportContexts(contexts);

        //this.#getContextInfo('UmbSectionSidebarContext');

      }),
    );
  }

  #getContextInfo(contextAlias) {
    var contextProps = { alias: contextAlias, props: {} };

    this.consumeContext(contextAlias, (contextBack) => {
      this.#internalLog("Context kickback", {contextAlias, contextBack});
      if(!contextBack){
        return;
      }
      
      const props = [
        ...Object.keys(contextBack),
        ...Object.keys(Object.getPrototypeOf(contextBack))
      ];

      props.forEach(key => {
        const val = contextBack[key];

        if (val && typeof val.subscribe === 'function') {
          this.#internalLog(`[Observable found] ${key}`);
          this.observe(val, (value) => {
            this.#internalLog("I'm observing!", {key, value});
            contextProps.props[key] = this.#safeValue(value, 0);
            this.#updateContextAttribute(contextProps);
          });
        } else if (typeof val !== 'function') {
          // Capture plain non-function values immediately
          contextProps.props[key] = this.#safeValue(val, 0);
          this.#updateContextAttribute(contextProps);
        }
      });
    });
  }

  #updateContextAttribute(contextProps) {
    this.#internalLog("Check the data out and push", contextProps);
    try {

      clearTimeout(this.callbackTimeoutId);
      this.callbackTimeoutId = setTimeout(()=>{
        // Send the data from here to the content.js -> panel.js
        window.postMessage({ type: 'contextData', data: contextProps }, '*');
      }, 50);
      // this.setAttribute('data-umb-context-data', JSON.stringify(contextProps));
    } catch (e) {
      console.warn('[Context] Failed to serialise context props', e);
    }
  }

  /**
   * Serialize context data to a JSON attribute so the Chrome extension's
   * content script (isolated world) can read it via the shared DOM.
   */
  #exportContexts(contexts) {
    try {
      const data = contextData(contexts);
      const serialized = Array.from(data).map(({ alias, data: instance }) => {
        const entry = { alias, type: instance.type };

        if (instance.type === 'object') {
          entry.methods = instance.methods ?? [];
          entry.properties = (instance.properties ?? []).map((p) => {

            const prop = { key: p.key, type: p.type };
            if (p.value !== undefined) {
              prop.value = this.#safeValue(p.value, 0);
            }

            return prop;

          });
        } else if (instance.type === 'primitive') {
          entry.value = this.#safeValue(instance.value, 0);
        }
        return entry;
      });
      var s = JSON.stringify(serialized);
      this.setAttribute('data-umb-debug-contexts', JSON.stringify(serialized));
      this.#internalLog("Serialised the ocntexts", s);
    } catch (ex) {
      // Ignore serialization errors
      this.#internalLog("Unable to add attr", ex)
    }
  }

  #safeValue(val, depth) {
    if (depth > 6) return '[nested]';
    if (val === null || val === undefined) return null;
    const type = typeof val;
    if (type === 'function') return '[Function]';
    if (type === 'symbol') return '[Symbol]';
    if (type !== 'object') return val;
    if (Array.isArray(val)) {
      return val.slice(0, 20).map((v) => this.#safeValue(v, depth + 1));
    }
    const keys = Object.keys(val);
    const result = {};
    let count = 0;
    for (const k of keys) {
      if (count++ > 30) { result['...'] = `${keys.length - 30} more keys`; break; }
      try { result[k] = this.#safeValue(val[k], depth + 1); } catch { result[k] = '[Error]'; }
    }
    return result;
  }

  #toggleDebugPane() {
    this._debugPaneOpen = !this._debugPaneOpen;
    if (this._debugPaneOpen) {
      this.#update();
    }
  }

  #internalLog(...args) {
    //console.log(...args);
  }

  render() {
    if (!this.visible) return nothing;
    return this.#renderPanel();
  }

  #renderPanel() {
    return html`
      <div id="container">
        <uui-button color="danger" look="primary" @click=${this.#toggleDebugPane}>
          <uui-icon name="icon-bug"></uui-icon>
          <span>Debug</span>
        </uui-button>
        ${when(this._debugPaneOpen, () => this.#renderContextAliases())}
      </div>
    `;
  }

  #renderContextAliases() {
    const data = contextData(this._contexts);
    return html`
      <div class="events">
        ${map(data, (context) => html`
          <details>
            <summary><strong>${context.alias}</strong></summary>
            ${this.#renderInstance(context.data)}
          </details>
        `)}
      </div>
    `;
  }

  #renderInstance(instance) {
    switch (instance.type) {
      case 'function':
        return html`<h3>Callable Function</h3>`;

      case 'object':
        return html`
          <details>
            <summary>Methods</summary>
            <ul>
              ${map(instance.methods, (methodName) => html`<li>${methodName}</li>`)}
            </ul>
          </details>
          <details>
            <summary>Properties</summary>
            <ul>
              ${map(instance.properties, (prop) => {
          switch (prop.type) {
            case 'string':
            case 'number':
            case 'boolean':
            case 'object':
              return html`<li>${prop.key} <em>(${prop.type})</em> = ${prop.value}</li>`;
            default:
              return html`<li>${prop.key} <em>(${prop.type})</em></li>`;
          }
        })}
            </ul>
          </details>
        `;

      case 'primitive':
        return html`<p>Context is a primitive with value: ${instance.value}</p>`;

      default:
        return html`<p>Unknown type: ${instance.type}</p>`;
    }
  }

  static styles = [
    css`
      :host {
        float: right;
        font-family: monospace;
        position: relative;
        z-index: 10000;
      }

      #container {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
      }

      uui-badge {
        cursor: pointer;
        gap: 0.5rem;
      }

      uui-icon {
        font-size: 15px;
      }

      .events {
        background-color: var(--uui-color-danger);
        color: var(--uui-color-selected-contrast);
        padding: 1rem;
      }

      summary {
        cursor: pointer;
      }

      details > details {
        margin-left: 1rem;
      }

      ul {
        margin-top: 0;
      }
    `,
  ];
}

if (!customElements.get('umb-debug-ext')) {
  customElements.define('umb-debug-ext', UmbDebugElementExt);
}
