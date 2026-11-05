import Element from '../../vendor/happy-dom/packages/happy-dom/src/nodes/element/Element.ts';
import ShadowRoot from '../../vendor/happy-dom/packages/happy-dom/src/nodes/shadow-root/ShadowRoot.ts';
import HTMLParser from '../../vendor/happy-dom/packages/happy-dom/src/html-parser/HTMLParser.ts';
import CustomElementUtility from '../../vendor/happy-dom/packages/happy-dom/src/custom-element/CustomElementUtility.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import {replaceAllNodes} from './node-replace-all.js';

const HTML = 'http://www.w3.org/1999/xhtml';
const hosts = new Set('article aside blockquote body div footer h1 h2 h3 h4 h5 h6 header main nav p section span'.split(' '));
const declarative = new WeakSet();
const parsing = new WeakSet();
const lower = value => value.replace(/[A-Z]/g, letter => letter.toLowerCase());

export const shadowHostAllowed = element => element?.namespaceURI === HTML
  && (hosts.has(element.localName) || CustomElementUtility.isValidCustomElementName(element.localName));

// Declaration state belongs to a root, not its author-visible properties.
// Hydration may reuse it once, with the same mode, preserving all other flags.
const attach = Element.prototype.attachShadow;
Element.prototype.attachShadow = function(init) {
  if (!shadowHostAllowed(this))
    throw new DOMException('This element cannot host a shadow root', 'NotSupportedError');
  const root = this[S.shadowRoot];
  if (root && declarative.has(root) && init?.mode === root.mode) {
    // replaceAllNodes drains captured disconnect reactions before returning.
    // Publish the completed hydration state before those callbacks can reenter.
    declarative.delete(root);
    replaceAllNodes(root, null);
    return root;
  }
  if (root) throw new DOMException('This element already has a shadow root', 'NotSupportedError');
  return attach.call(this, init);
};

// The DOM cloning algorithm always copies a clonable shadow subtree, even
// when its host is cloned shallowly. Keep its declarative hydration state.
const cloneShadow = ShadowRoot.prototype[S.cloneNode];
ShadowRoot.prototype[S.cloneNode] = function() {
  const clone = cloneShadow.call(this, true);
  if (declarative.has(this)) declarative.add(clone);
  return clone;
};

/** An explicit parser opt-in; innerHTML, DOMParser and contextual fragments
 * continue using their existing parsers with declarative roots disabled. */
export function parseHTMLWithShadowRoots(window, markup, root, options = {}) {
  const parser = new HTMLParser(window, options);
  parsing.add(parser);
  try { return parser.parse(markup, root); }
  finally { parsing.delete(parser); }
}

// Happy DOM's TypeScript-private parser method is an ordinary prototype
// method. Hook the completed start token instead of scanning finished DOM:
// nested declarations, duplicate roots and unclosed templates then follow
// the same parser stack, and existing DOM templates are never activated.
const startTag = HTMLParser.prototype.parseEndOfStartTag;
HTMLParser.prototype.parseEndOfStartTag = function(...args) {
  const result = startTag.apply(this, args);
  if (!parsing.has(this)) return result;
  const template = this.nextElement;
  if (this.currentNode !== template || template?.namespaceURI !== HTML || template.localName !== 'template') return result;
  const mode = lower(template.getAttribute('shadowrootmode') ?? '');
  if (mode !== 'open' && mode !== 'closed') return result;
  const parent = template.parentNode;
  // A fragment parser's synthetic root is not the context element itself:
  // a leading template never attaches a shadow root to setHTMLUnsafe's receiver.
  if (parent === this.rootNode) return result;
  const host = parent;
  if (!shadowHostAllowed(host) || host[S.shadowRoot]) return result;
  const root = attach.call(host, {mode,
    delegateFocus:template.hasAttribute('shadowrootdelegatesfocus'),
    clonable:template.hasAttribute('shadowrootclonable'),
    serializable:template.hasAttribute('shadowrootserializable'),
    slotAssignment:lower(template.getAttribute('shadowrootslotassignment') ?? '') === 'manual' ? 'manual' : 'named',
  });
  declarative.add(root);
  parent.removeChild(template);
  // The parser keeps its HTML template stack item (namespace and closing-tag
  // rules); its subsequent children go straight into the actual shadow root.
  template[S.content] = root;
  return result;
};
