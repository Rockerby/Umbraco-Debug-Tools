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

class UmbDebugElementExt extends UmbLitElement {
  static properties = {
    visible: { type: Boolean },
    dialog: { type: Boolean },
    _contexts: { state: true },
    _debugPaneOpen: { state: true },
  };

  constructor() {
    super();
    this.visible = false;
    this.dialog = false;
    this._contexts = new Map();
    this._debugPaneOpen = false;
  }

  #update() {
    this.dispatchEvent(
      new UmbContextDebugRequest((contexts) => {
        this._contexts = contexts;
      }),
    );
  }

  #toggleDebugPane() {
    this._debugPaneOpen = !this._debugPaneOpen;
    if (this._debugPaneOpen) {
      this.#update();
    }
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
