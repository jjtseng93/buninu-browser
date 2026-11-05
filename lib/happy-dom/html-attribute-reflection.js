import HTMLInputElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-input-element/HTMLInputElement.ts';
import HTMLDetailsElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-details-element/HTMLDetailsElement.ts';
import HTMLIFrameElement from '../../vendor/happy-dom/packages/happy-dom/src/nodes/html-iframe-element/HTMLIFrameElement.ts';
import { documentBaseURL } from './document-base.js';

// HTML reflection reads/writes null-namespace content attributes. getAttribute
// must still return the first qualified-name match, including other namespaces.
const inputTypes = new Set(['hidden','text','search','tel','url','email','password','date','month',
  'week','time','datetime-local','number','range','color','checkbox','radio','file','submit','image','reset','button']);
Object.defineProperty(HTMLInputElement.prototype, 'type', { configurable: true, enumerable: true,
  get() {
    const value = (this.getAttributeNS(null, 'type') ?? '').replace(/[A-Z]/g, c => c.toLowerCase());
    return inputTypes.has(value) ? value : 'text';
  },
  set(value) { this.setAttributeNS(null, 'type', value); },
});
Object.defineProperty(HTMLDetailsElement.prototype, 'open', { configurable: true, enumerable: true,
  get() { return this.hasAttributeNS(null, 'open'); },
  set(value) {
    if (value) this.setAttributeNS(null, 'open', '');
    else this.removeAttributeNS(null, 'open');
  },
});
Object.defineProperty(HTMLIFrameElement.prototype, 'src', { configurable: true, enumerable: true,
  get() {
    const value = this.getAttributeNS(null, 'src');
    if (value === null) return '';
    try { return new URL(value, documentBaseURL(this)).href; }
    catch { return value; }
  },
  set(value) { this.setAttributeNS(null, 'src', value); },
});
