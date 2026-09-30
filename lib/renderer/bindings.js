/**
 * DOM bindings: the only view page scripts get of the document.
 *
 * Page code never touches Happy DOM objects. Every node, event, style and
 * collection it sees is a wrapper whose real object lives in a private class
 * field, and every argument coming back from the page is coerced to a string
 * or number or unwrapped from one of these wrappers. Binding classes and
 * their prototypes are hardened, so a page cannot change them; wrapper
 * instances stay extensible because pages attach expando properties.
 *
 * Coverage is the commonly used subset of DOM, not the full WebIDL surface.
 */

const CONSTRUCT = Symbol("binding construction key");
const REFLECTED_PROPERTIES = [
  "value", "checked", "disabled", "type", "name", "href", "src", "alt", "title",
  "placeholder", "selected", "readOnly", "required", "min", "max", "step", "rel", "target",
  "htmlFor", "lang", "dir", "tabIndex", "hidden", "defaultValue", "action", "method",
];

/** Per-document state shared by that document's wrappers. */
export class BindingRealm {
  #wrappers = new WeakMap();
  #listeners = new WeakMap();
  #events = new WeakMap();
  #hooks;
  #window;
  eventPrototype = null;
  elementPrototype = null;
  fragmentPrototype = null;
  shadowRootPrototype = null;
  textPrototype = null;
  characterDataPrototype = null;
  nodePrototype = null;

  /**
   * @param {object} window the Happy DOM window of the document
   * @param {{
   *   touch(): void,
   *   boundsOf(element: object): { left: number, top: number, width: number, height: number } | null,
   *   viewport(): { width: number, height: number, scrollX: number, scrollY: number, devicePixelRatio: number },
   *   scrollTo(x: number, y: number): void,
   *   call(fn: Function, thisArg: unknown, args: unknown[]): unknown,
   * }} hooks
   */
  constructor(window, hooks) {
    this.#window = window;
    this.#hooks = hooks;
  }

  get hooks() {
    return this.#hooks;
  }

  get window() {
    return this.#window;
  }

  /** Returns the page-facing wrapper for a Happy DOM node (one per node). */
  wrap(node) {
    if (node === null || node === undefined) return null;
    // Only DOM nodes get node wrappers; the window maps to the page global.
    if (typeof node.nodeType !== "number") return this.#hooks.targetOf?.(node) ?? null;
    let wrapper = this.#wrappers.get(node);
    if (!wrapper) {
      const Binding = node.nodeType === 1 ? ElementBinding
        : node.nodeType === 9 ? DocumentBinding
          : node.nodeType === 11 ? (node instanceof this.#window.ShadowRoot ? ShadowRootBinding : FragmentBinding)
            : node.nodeType === 3 ? TextBinding
              : node.nodeType === 8 ? CharacterDataBinding
                : NodeBinding;
      wrapper = new Binding(CONSTRUCT, node, this);
      if (Binding === ElementBinding && this.elementPrototype) Object.setPrototypeOf(wrapper, this.elementPrototype);
      if (Binding === FragmentBinding && this.fragmentPrototype) Object.setPrototypeOf(wrapper, this.fragmentPrototype);
      if (Binding === ShadowRootBinding && this.shadowRootPrototype) Object.setPrototypeOf(wrapper, this.shadowRootPrototype);
      if (Binding === TextBinding && this.textPrototype) Object.setPrototypeOf(wrapper, this.textPrototype);
      if (Binding === CharacterDataBinding && this.characterDataPrototype) Object.setPrototypeOf(wrapper, this.characterDataPrototype);
      if (Binding === NodeBinding && this.nodePrototype) Object.setPrototypeOf(wrapper, this.nodePrototype);
      this.#wrappers.set(node, wrapper);
    }
    return wrapper;
  }

  wrapAll(nodes) {
    return Array.from(nodes ?? [], (node) => this.wrap(node));
  }

  /** One wrapper per event, so listeners see the dispatched object (and its detail). */
  wrapEvent(event, detail = undefined) {
    if (!event) return null;
    let wrapper = this.#events.get(event);
    if (!wrapper) {
      wrapper = new EventBinding(CONSTRUCT, event, this, detail);
      if (this.eventPrototype) Object.setPrototypeOf(wrapper, this.eventPrototype);
      this.#events.set(event, wrapper);
    }
    return wrapper;
  }

  /** Host listener registered on the real target for a page listener. */
  listenerFor(target, type, listener, capture) {
    let byTarget = this.#listeners.get(target);
    if (!byTarget) this.#listeners.set(target, byTarget = new Map());
    const key = `${capture ? 1 : 0}:${type}`;
    let byType = byTarget.get(key);
    if (!byType) byTarget.set(key, byType = new Map());
    return byType;
  }
}

/** Unwraps a node wrapper created by this module, or returns null. */
export function nodeOf(value) {
  return NodeBinding.unwrap(value);
}

/** Writable page-local facade over a frozen engine binding prototype. */
export function mutableBindingPrototype(base, parent = base) {
  const prototype = Object.create(parent);
  for (const key of Reflect.ownKeys(base)) {
    if (key === "constructor") continue;
    const descriptor = Object.getOwnPropertyDescriptor(base, key);
    descriptor.configurable = true;
    if ("value" in descriptor) descriptor.writable = true;
    Object.defineProperty(prototype, key, descriptor);
  }
  return prototype;
}

function realmOf(wrapper) {
  return NodeBinding.realmOf(wrapper);
}

/** Converts page input to a node: wrappers are unwrapped, anything else becomes text. */
function toNode(wrapper, value) {
  const node = nodeOf(value);
  if (node) return node;
  return realmOf(wrapper).window.document.createTextNode(String(value));
}

function touch(wrapper) {
  realmOf(wrapper).hooks.touch();
}

/**
 * Nodes put into the tree by page code (not by innerHTML, whose scripts
 * never run): the realm starts any script elements that became connected.
 */
function inserted(wrapper, nodes) {
  const realm = realmOf(wrapper);
  realm.hooks.touch();
  realm.hooks.inserted?.(nodes);
}

/** A fragment empties itself on insertion, so list its children beforehand. */
function insertionList(nodes) {
  return nodes.flatMap((node) => node.nodeType === 11 ? [...node.childNodes] : [node]);
}

class NodeBinding {
  static ELEMENT_NODE = 1;
  static ATTRIBUTE_NODE = 2;
  static TEXT_NODE = 3;
  static CDATA_SECTION_NODE = 4;
  static PROCESSING_INSTRUCTION_NODE = 7;
  static COMMENT_NODE = 8;
  static DOCUMENT_NODE = 9;
  static DOCUMENT_TYPE_NODE = 10;
  static DOCUMENT_FRAGMENT_NODE = 11;
  static DOCUMENT_POSITION_DISCONNECTED = 1;
  static DOCUMENT_POSITION_PRECEDING = 2;
  static DOCUMENT_POSITION_FOLLOWING = 4;
  static DOCUMENT_POSITION_CONTAINS = 8;
  static DOCUMENT_POSITION_CONTAINED_BY = 16;

  #node;
  #realm;

  constructor(key, node, realm) {
    if (key !== CONSTRUCT) throw new TypeError("Illegal constructor");
    this.#node = node;
    this.#realm = realm;
  }

  static unwrap(value) {
    return value !== null && typeof value === "object" && #node in value ? value.#node : null;
  }

  static realmOf(value) {
    return value !== null && typeof value === "object" && #realm in value ? value.#realm : null;
  }

  get nodeType() {
    return this.#node.nodeType;
  }

  get nodeName() {
    return this.#node.nodeName;
  }

  get nodeValue() {
    return this.#node.nodeValue ?? null;
  }

  set nodeValue(value) {
    if (this.#node.nodeType === 3 || this.#node.nodeType === 8) {
      this.#node.nodeValue = String(value);
      touch(this);
    }
  }

  get textContent() {
    return this.#node.textContent;
  }

  set textContent(value) {
    this.#node.textContent = value === null ? "" : String(value);
    touch(this);
  }

  get parentNode() {
    return this.#realm.wrap(this.#node.parentNode);
  }

  get parentElement() {
    return this.#realm.wrap(this.#node.parentElement);
  }

  get childNodes() {
    return this.#realm.wrapAll(this.#node.childNodes);
  }

  get firstChild() {
    return this.#realm.wrap(this.#node.firstChild);
  }

  get lastChild() {
    return this.#realm.wrap(this.#node.lastChild);
  }

  get nextSibling() {
    return this.#realm.wrap(this.#node.nextSibling);
  }

  get previousSibling() {
    return this.#realm.wrap(this.#node.previousSibling);
  }

  get ownerDocument() {
    return this.#realm.wrap(this.#node.ownerDocument);
  }

  get isConnected() {
    return Boolean(this.#node.isConnected);
  }

  hasChildNodes() {
    return this.#node.hasChildNodes();
  }

  contains(other) {
    const node = nodeOf(other);
    return node ? this.#node.contains(node) : false;
  }

  appendChild(child) {
    const node = requireNode(child);
    const list = insertionList([node]);
    this.#node.appendChild(node);
    inserted(this, list);
    return child;
  }

  insertBefore(child, reference) {
    const node = requireNode(child);
    const list = insertionList([node]);
    this.#node.insertBefore(node, nodeOf(reference));
    inserted(this, list);
    return child;
  }

  removeChild(child) {
    this.#node.removeChild(requireNode(child));
    touch(this);
    return child;
  }

  replaceChild(child, old) {
    const node = requireNode(child);
    const list = insertionList([node]);
    this.#node.replaceChild(node, requireNode(old));
    inserted(this, list);
    return old;
  }

  cloneNode(deep = false) {
    return this.#realm.wrap(this.#node.cloneNode(Boolean(deep)));
  }

  addEventListener(type, listener, options) {
    addListener(this, this.#node, type, listener, options);
  }

  removeEventListener(type, listener, options) {
    removeListener(this, this.#node, type, listener, options);
  }

  dispatchEvent(event) {
    const real = EventBinding.unwrap(event);
    if (!real) throw new TypeError("dispatchEvent requires an Event");
    const result = this.#node.dispatchEvent(real);
    touch(this);
    return result;
  }
}

function requireNode(value) {
  const node = nodeOf(value);
  if (!node) throw new TypeError("parameter is not of type 'Node'");
  return node;
}

/** Text and comments; frameworks read comment data (React's hydration markers). */
class CharacterDataBinding extends NodeBinding {
  get data() {
    return nodeOf(this).data;
  }

  set data(value) {
    nodeOf(this).data = String(value);
    touch(this);
  }

  get length() {
    return nodeOf(this).data.length;
  }
}

class TextBinding extends CharacterDataBinding {}

/** Methods shared by elements, documents and fragments (ParentNode). */
class ParentBinding extends NodeBinding {
  get children() {
    return realmOf(this).wrapAll(nodeOf(this).children);
  }

  get firstElementChild() {
    return realmOf(this).wrap(nodeOf(this).firstElementChild);
  }

  get lastElementChild() {
    return realmOf(this).wrap(nodeOf(this).lastElementChild);
  }

  get childElementCount() {
    return nodeOf(this).children.length;
  }

  querySelector(selector) {
    return realmOf(this).wrap(nodeOf(this).querySelector(String(selector)));
  }

  querySelectorAll(selector) {
    return realmOf(this).wrapAll(nodeOf(this).querySelectorAll(String(selector)));
  }

  getElementsByTagName(name) {
    return realmOf(this).wrapAll(nodeOf(this).getElementsByTagName(String(name)));
  }

  getElementsByClassName(names) {
    return realmOf(this).wrapAll(nodeOf(this).getElementsByClassName(String(names)));
  }

  append(...values) {
    const nodes = values.map((value) => toNode(this, value));
    const list = insertionList(nodes);
    nodeOf(this).append(...nodes);
    inserted(this, list);
  }

  prepend(...values) {
    const nodes = values.map((value) => toNode(this, value));
    const list = insertionList(nodes);
    nodeOf(this).prepend(...nodes);
    inserted(this, list);
  }

  replaceChildren(...values) {
    const nodes = values.map((value) => toNode(this, value));
    const list = insertionList(nodes);
    nodeOf(this).replaceChildren(...nodes);
    inserted(this, list);
  }
}

class FragmentBinding extends ParentBinding {
  getElementById(id) {
    return realmOf(this).wrap(nodeOf(this).querySelector(`#${cssEscape(String(id))}`));
  }
}

/**
 * Shadow roots work for scripts (custom elements build into them), but the
 * renderer does not draw shadow trees yet: the host's light DOM is shown.
 */
class ShadowRootBinding extends FragmentBinding {
  get host() {
    return realmOf(this).wrap(nodeOf(this).host);
  }

  get mode() {
    return nodeOf(this).mode;
  }

  get innerHTML() {
    return nodeOf(this).innerHTML;
  }

  set innerHTML(value) {
    nodeOf(this).innerHTML = String(value);
    touch(this);
  }
}

class ElementBinding extends ParentBinding {
  #style = null;
  #classList = null;
  #dataset = null;

  get tagName() {
    return nodeOf(this).tagName;
  }

  attachShadow(init) {
    const mode = init?.mode === "closed" ? "closed" : "open";
    return realmOf(this).wrap(nodeOf(this).attachShadow({ mode }));
  }

  get shadowRoot() {
    return realmOf(this).wrap(nodeOf(this).shadowRoot);
  }

  get content() {
    const content = nodeOf(this).content;
    return content === undefined ? undefined : realmOf(this).wrap(content);
  }

  // HTMLMediaElement (video and audio): the subset the renderer plays.
  get paused() {
    return isMedia(this) ? realmOf(this).hooks.mediaState?.(nodeOf(this)).paused ?? true : undefined;
  }

  get ended() {
    return isMedia(this) ? realmOf(this).hooks.mediaState?.(nodeOf(this)).ended ?? false : undefined;
  }

  get currentTime() {
    return isMedia(this) ? realmOf(this).hooks.mediaState?.(nodeOf(this)).currentTime ?? 0 : undefined;
  }

  set currentTime(value) {
    if (!isMedia(this)) return;
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) throw new TypeError("The provided double value is non-finite.");
    void realmOf(this).hooks.seekMedia?.(nodeOf(this), seconds);
  }

  get duration() {
    return isMedia(this) ? realmOf(this).hooks.mediaState?.(nodeOf(this)).duration ?? NaN : undefined;
  }

  play() {
    if (!isMedia(this)) return undefined;
    return Promise.resolve(realmOf(this).hooks.playMedia?.(nodeOf(this))).then(() => undefined);
  }

  pause() {
    if (isMedia(this)) realmOf(this).hooks.pauseMedia?.(nodeOf(this));
  }

  get localName() {
    return nodeOf(this).localName;
  }

  get id() {
    return nodeOf(this).id;
  }

  set id(value) {
    nodeOf(this).id = String(value);
    touch(this);
  }

  get className() {
    return nodeOf(this).className;
  }

  set className(value) {
    nodeOf(this).className = String(value);
    touch(this);
  }

  get classList() {
    this.#classList ??= new ClassListBinding(CONSTRUCT, nodeOf(this), realmOf(this));
    return this.#classList;
  }

  get style() {
    this.#style ??= styleBinding(nodeOf(this), realmOf(this));
    return this.#style;
  }

  get dataset() {
    this.#dataset ??= datasetBinding(nodeOf(this), realmOf(this));
    return this.#dataset;
  }

  getAttribute(name) {
    return nodeOf(this).getAttribute(String(name));
  }

  setAttribute(name, value) {
    nodeOf(this).setAttribute(String(name), String(value));
    touch(this);
  }

  removeAttribute(name) {
    nodeOf(this).removeAttribute(String(name));
    touch(this);
  }

  hasAttribute(name) {
    return nodeOf(this).hasAttribute(String(name));
  }

  toggleAttribute(name, force) {
    const result = nodeOf(this).toggleAttribute(String(name), force === undefined ? undefined : Boolean(force));
    touch(this);
    return result;
  }

  getAttributeNames() {
    return [...nodeOf(this).getAttributeNames()];
  }

  get innerHTML() {
    return nodeOf(this).innerHTML;
  }

  /** Parsed by Happy DOM with script evaluation disabled, as HTML specifies for innerHTML. */
  set innerHTML(value) {
    nodeOf(this).innerHTML = String(value);
    touch(this);
  }

  get outerHTML() {
    return nodeOf(this).outerHTML;
  }

  get innerText() {
    return nodeOf(this).textContent;
  }

  set innerText(value) {
    nodeOf(this).textContent = String(value);
    touch(this);
  }

  insertAdjacentHTML(position, html) {
    nodeOf(this).insertAdjacentHTML(String(position), String(html));
    touch(this);
  }

  insertAdjacentText(position, text) {
    nodeOf(this).insertAdjacentText(String(position), String(text));
    touch(this);
  }

  insertAdjacentElement(position, element) {
    const node = nodeOf(this).insertAdjacentElement(String(position), requireNode(element));
    if (node) inserted(this, [node]);
    else touch(this);
    return realmOf(this).wrap(node);
  }

  get nextElementSibling() {
    return realmOf(this).wrap(nodeOf(this).nextElementSibling);
  }

  get previousElementSibling() {
    return realmOf(this).wrap(nodeOf(this).previousElementSibling);
  }

  closest(selector) {
    return realmOf(this).wrap(nodeOf(this).closest(String(selector)));
  }

  matches(selector) {
    return nodeOf(this).matches(String(selector));
  }

  remove() {
    nodeOf(this).remove();
    touch(this);
  }

  before(...values) {
    const nodes = values.map((value) => toNode(this, value));
    const list = insertionList(nodes);
    nodeOf(this).before(...nodes);
    inserted(this, list);
  }

  after(...values) {
    const nodes = values.map((value) => toNode(this, value));
    const list = insertionList(nodes);
    nodeOf(this).after(...nodes);
    inserted(this, list);
  }

  replaceWith(...values) {
    const nodes = values.map((value) => toNode(this, value));
    const list = insertionList(nodes);
    nodeOf(this).replaceWith(...nodes);
    inserted(this, list);
  }

  click() {
    const realm = realmOf(this);
    const element = nodeOf(this);
    const event = new realm.window.MouseEvent("click", { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    if (!event.defaultPrevented) {
      const anchor = element.closest?.("a[href]");
      if (anchor) realm.hooks.activateLink?.(anchor);
    }
    touch(this);
  }

  focus() {
    nodeOf(this).focus();
  }

  blur() {
    nodeOf(this).blur();
  }

  getBoundingClientRect() {
    const rect = realmOf(this).hooks.boundsOf(nodeOf(this)) ?? { left: 0, top: 0, width: 0, height: 0 };
    return domRect(rect);
  }

  getClientRects() {
    return [this.getBoundingClientRect()];
  }

  get offsetWidth() {
    return Math.round(this.getBoundingClientRect().width);
  }

  get offsetHeight() {
    return Math.round(this.getBoundingClientRect().height);
  }

  get offsetLeft() {
    const { viewport } = realmOf(this).hooks;
    return Math.round(this.getBoundingClientRect().left + viewport().scrollX);
  }

  get offsetTop() {
    const { viewport } = realmOf(this).hooks;
    return Math.round(this.getBoundingClientRect().top + viewport().scrollY);
  }

  // The root element's client size is the viewport (CSSOM View §6).
  get clientWidth() {
    const root = nodeOf(this) === nodeOf(this).ownerDocument?.documentElement;
    return root ? realmOf(this).hooks.viewport().width : this.offsetWidth;
  }

  get clientHeight() {
    const root = nodeOf(this) === nodeOf(this).ownerDocument?.documentElement;
    return root ? realmOf(this).hooks.viewport().height : this.offsetHeight;
  }

  // Tables and selects (undefined on other elements, as in browsers).
  get rows() {
    const rows = nodeOf(this).rows;
    return rows === undefined ? undefined : realmOf(this).wrapAll(rows);
  }

  get cells() {
    const cells = nodeOf(this).cells;
    return cells === undefined ? undefined : realmOf(this).wrapAll(cells);
  }

  get tBodies() {
    const bodies = nodeOf(this).tBodies;
    return bodies === undefined ? undefined : realmOf(this).wrapAll(bodies);
  }

  get tHead() {
    const node = nodeOf(this);
    return node.tagName === "TABLE" ? realmOf(this).wrap(node.tHead ?? null) : undefined;
  }

  get tFoot() {
    const node = nodeOf(this);
    return node.tagName === "TABLE" ? realmOf(this).wrap(node.tFoot ?? null) : undefined;
  }

  get rowIndex() {
    return nodeOf(this).rowIndex;
  }

  get cellIndex() {
    return nodeOf(this).cellIndex;
  }

  get options() {
    const options = nodeOf(this).tagName === "SELECT" ? nodeOf(this).options : undefined;
    return options === undefined ? undefined : realmOf(this).wrapAll(options);
  }

  get selectedOptions() {
    const options = nodeOf(this).tagName === "SELECT" ? nodeOf(this).selectedOptions : undefined;
    return options === undefined ? undefined : realmOf(this).wrapAll(options);
  }

  get selectedIndex() {
    return nodeOf(this).selectedIndex;
  }

  set selectedIndex(value) {
    if (nodeOf(this).tagName !== "SELECT") return;
    nodeOf(this).selectedIndex = Number(value);
    touch(this);
  }

  // Overflow inside elements is not scrollable here, so the scroll size is the
  // box size; the root element spans at least the viewport.
  get scrollWidth() {
    const root = nodeOf(this) === nodeOf(this).ownerDocument?.documentElement;
    return Math.max(this.offsetWidth, root ? realmOf(this).hooks.viewport().width : 0);
  }

  get scrollHeight() {
    const root = nodeOf(this) === nodeOf(this).ownerDocument?.documentElement;
    return Math.max(this.offsetHeight, root ? realmOf(this).hooks.viewport().height : 0);
  }

  scrollIntoView() {
    const realm = realmOf(this);
    const rect = this.getBoundingClientRect();
    const { scrollX, scrollY } = realm.hooks.viewport();
    realm.hooks.scrollTo(scrollX, scrollY + rect.top);
  }
}

function isMedia(wrapper) {
  return wrapper.tagName === "VIDEO" || wrapper.tagName === "AUDIO";
}

/** on* event handler properties (element.onclick = fn, script.onload = fn). */
export const EVENT_HANDLER_NAMES = Object.freeze([
  "click", "dblclick", "mousedown", "mouseup", "mousemove", "mouseover", "mouseout", "mouseenter", "mouseleave",
  "keydown", "keyup", "keypress", "beforeinput", "input", "change", "submit", "reset", "focus", "blur", "load", "error",
  "abort", "scroll", "resize", "wheel", "contextmenu", "touchstart", "touchend", "touchmove",
  "pointerdown", "pointerup", "pointermove", "animationend", "transitionend", "readystatechange",
]);

/**
 * Installs an on<type> accessor that keeps at most one page handler per
 * target; a handler returning false cancels the event, as in browsers.
 */
export function defineEventHandlerProperty(object, type, targetOf, realmFor) {
  const handlers = new WeakMap();
  Object.defineProperty(object, `on${type}`, {
    configurable: true,
    enumerable: true,
    get() {
      return handlers.get(this)?.handler ?? null;
    },
    set(value) {
      const realm = realmFor(this);
      const target = targetOf(this);
      const previous = handlers.get(this);
      if (previous) target.removeEventListener(type, previous.listener);
      handlers.delete(this);
      if (typeof value !== "function") return;
      const self = this;
      const listener = (event) => {
        if (realm.hooks.acceptEvent && !realm.hooks.acceptEvent(event)) return;
        const result = realm.hooks.call(value, self, [realm.wrapEvent(event)]);
        if (result === false) event.preventDefault();
      };
      handlers.set(this, { handler: value, listener });
      target.addEventListener(type, listener);
    },
  });
}

for (const type of EVENT_HANDLER_NAMES) {
  defineEventHandlerProperty(ElementBinding.prototype, type, (wrapper) => nodeOf(wrapper), (wrapper) => realmOf(wrapper));
}

// Reflected IDL attributes: values are coerced to primitives on the way in.
for (const property of REFLECTED_PROPERTIES) {
  Object.defineProperty(ElementBinding.prototype, property, {
    configurable: true,
    enumerable: true,
    get() {
      const value = nodeOf(this)[property];
      return value === null || typeof value !== "object" ? value : String(value);
    },
    set(value) {
      const node = nodeOf(this);
      node[property] = typeof node[property] === "boolean" ? Boolean(value)
        : typeof node[property] === "number" ? Number(value)
          : String(value);
      touch(this);
    },
  });
}

class DocumentBinding extends ParentBinding {
  get documentElement() {
    return realmOf(this).wrap(nodeOf(this).documentElement);
  }

  get head() {
    return realmOf(this).wrap(nodeOf(this).head);
  }

  get body() {
    return realmOf(this).wrap(nodeOf(this).body);
  }

  get title() {
    return nodeOf(this).title;
  }

  set title(value) {
    nodeOf(this).title = String(value);
  }

  get readyState() {
    return realmOf(this).hooks.readyState?.() ?? "complete";
  }

  get URL() {
    return nodeOf(this).URL;
  }

  get documentURI() {
    return nodeOf(this).URL;
  }

  get location() {
    return realmOf(this).hooks.pageGlobal?.()?.location ?? null;
  }

  get domain() {
    return new URL(nodeOf(this).URL).hostname;
  }

  get characterSet() {
    return "UTF-8";
  }

  get compatMode() {
    return "CSS1Compat";
  }

  /** Non-HttpOnly cookies from the controller's jar; writes go back to the jar. */
  get cookie() {
    return realmOf(this).hooks.documentCookie?.() ?? "";
  }

  set cookie(value) {
    realmOf(this).hooks.setDocumentCookie?.(String(value));
  }

  get activeElement() {
    return realmOf(this).wrap(nodeOf(this).activeElement);
  }

  get currentScript() {
    return realmOf(this).wrap(realmOf(this).hooks.currentScript?.() ?? null);
  }

  get defaultView() {
    return realmOf(this).hooks.pageGlobal?.() ?? null;
  }

  get scripts() {
    return realmOf(this).wrapAll(nodeOf(this).querySelectorAll("script"));
  }

  get forms() {
    return realmOf(this).wrapAll(nodeOf(this).querySelectorAll("form"));
  }

  get images() {
    return realmOf(this).wrapAll(nodeOf(this).querySelectorAll("img"));
  }

  get links() {
    return realmOf(this).wrapAll(nodeOf(this).querySelectorAll("a[href], area[href]"));
  }

  getElementById(id) {
    return realmOf(this).wrap(nodeOf(this).getElementById(String(id)));
  }

  getElementsByName(name) {
    return realmOf(this).wrapAll(nodeOf(this).querySelectorAll(`[name="${cssEscape(String(name))}"]`));
  }

  createElement(name) {
    const element = nodeOf(this).createElement(String(name));
    realmOf(this).hooks.created?.(element);
    return realmOf(this).wrap(element);
  }

  createElementNS(namespace, name) {
    const element = nodeOf(this).createElementNS(namespace === null ? null : String(namespace), String(name));
    realmOf(this).hooks.created?.(element);
    return realmOf(this).wrap(element);
  }

  createTextNode(text) {
    return realmOf(this).wrap(nodeOf(this).createTextNode(String(text)));
  }

  createComment(text) {
    return realmOf(this).wrap(nodeOf(this).createComment(String(text)));
  }

  createTreeWalker(root, whatToShow = NodeFilter.SHOW_ALL, filter = null) {
    return new TreeWalkerBinding(CONSTRUCT, realmOf(this), requireNode(root), whatToShow, filter);
  }

  createDocumentFragment() {
    return realmOf(this).wrap(nodeOf(this).createDocumentFragment());
  }

  createEvent(_type) {
    return realmOf(this).wrapEvent(new (realmOf(this).window.Event)(""));
  }

  hasFocus() {
    return true;
  }
}

for (const type of EVENT_HANDLER_NAMES) {
  defineEventHandlerProperty(DocumentBinding.prototype, type, (wrapper) => nodeOf(wrapper), (wrapper) => realmOf(wrapper));
}

class EventBinding {
  #event;
  #realm;
  #detail;

  constructor(key, event, realm, detail = undefined) {
    if (key !== CONSTRUCT) throw new TypeError("Illegal constructor");
    this.#event = event;
    this.#realm = realm;
    this.#detail = detail;
  }

  static unwrap(value) {
    return value !== null && typeof value === "object" && #event in value ? value.#event : null;
  }

  get type() {
    return this.#event.type;
  }

  get target() {
    return this.#realm.wrap(this.#event.target) ?? this.#realm.hooks.targetOf?.(this.#event.target) ?? null;
  }

  get currentTarget() {
    return this.#realm.wrap(this.#event.currentTarget) ?? this.#realm.hooks.targetOf?.(this.#event.currentTarget) ?? null;
  }

  get srcElement() {
    return this.target;
  }

  get bubbles() {
    return Boolean(this.#event.bubbles);
  }

  get cancelable() {
    return Boolean(this.#event.cancelable);
  }

  get defaultPrevented() {
    return Boolean(this.#event.defaultPrevented);
  }

  get eventPhase() {
    return this.#event.eventPhase;
  }

  get isTrusted() {
    return Boolean(this.#event.isTrusted);
  }

  get timeStamp() {
    return this.#event.timeStamp;
  }

  get detail() {
    return this.#detail ?? null;
  }

  get key() {
    return this.#event.key;
  }

  get code() {
    return this.#event.code;
  }

  get clientX() {
    return this.#event.clientX;
  }

  get clientY() {
    return this.#event.clientY;
  }

  get button() {
    return this.#event.button;
  }

  get altKey() {
    return Boolean(this.#event.altKey);
  }

  get ctrlKey() {
    return Boolean(this.#event.ctrlKey);
  }

  get shiftKey() {
    return Boolean(this.#event.shiftKey);
  }

  get metaKey() {
    return Boolean(this.#event.metaKey);
  }

  get buttons() {
    return Number(this.#event.buttons ?? 0);
  }

  get screenX() {
    return Number(this.#event.screenX ?? 0);
  }

  get screenY() {
    return Number(this.#event.screenY ?? 0);
  }

  get deltaX() {
    return Number(this.#event.deltaX ?? 0);
  }

  get deltaY() {
    return Number(this.#event.deltaY ?? 0);
  }

  get deltaMode() {
    return Number(this.#event.deltaMode ?? 0);
  }

  get repeat() {
    return Boolean(this.#event.repeat);
  }

  get data() {
    return this.#event.data ?? null;
  }

  get inputType() {
    return String(this.#event.inputType ?? "");
  }

  get pointerType() {
    return String(this.#event.pointerType ?? "");
  }

  preventDefault() {
    this.#event.preventDefault();
  }

  stopPropagation() {
    this.#event.stopPropagation();
  }

  stopImmediatePropagation() {
    this.#event.stopImmediatePropagation();
  }

  composedPath() {
    return [];
  }
}

export const NodeFilter = Object.freeze({
  FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3,
  SHOW_ALL: 0xffffffff, SHOW_ELEMENT: 0x1, SHOW_ATTRIBUTE: 0x2, SHOW_TEXT: 0x4, SHOW_CDATA_SECTION: 0x8,
  SHOW_PROCESSING_INSTRUCTION: 0x40, SHOW_COMMENT: 0x80, SHOW_DOCUMENT: 0x100, SHOW_DOCUMENT_TYPE: 0x200,
  SHOW_DOCUMENT_FRAGMENT: 0x400,
});
const { FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP } = NodeFilter;

/**
 * DOM §6.2 TreeWalker over the real nodes. The page's filter (a function or
 * an object with acceptNode) sees node wrappers, and its exceptions reach the
 * caller as the spec says.
 */
class TreeWalkerBinding {
  #realm;
  #root;
  #current;
  #whatToShow;
  #filter;

  constructor(key, realm, root, whatToShow, filter) {
    if (key !== CONSTRUCT) throw new TypeError("Illegal constructor");
    this.#realm = realm;
    this.#root = root;
    this.#current = root;
    this.#whatToShow = Number(whatToShow) >>> 0;
    this.#filter = filter ?? null;
  }

  get root() { return this.#realm.wrap(this.#root); }
  get whatToShow() { return this.#whatToShow; }
  get filter() { return this.#filter; }
  get currentNode() { return this.#realm.wrap(this.#current); }
  set currentNode(value) { this.#current = requireNode(value); }

  #accept(node) {
    if (!(this.#whatToShow & (1 << (node.nodeType - 1)))) return FILTER_SKIP;
    const filter = this.#filter;
    if (filter === null) return FILTER_ACCEPT;
    const wrapper = this.#realm.wrap(node);
    const result = typeof filter === "function"
      ? Reflect.apply(filter, undefined, [wrapper])
      : Reflect.apply(filter.acceptNode, filter, [wrapper]);
    return Number(result);
  }

  #move(node) {
    this.#current = node;
    return this.#realm.wrap(node);
  }

  parentNode() {
    let node = this.#current;
    while (node && node !== this.#root) {
      node = node.parentNode;
      if (node && this.#accept(node) === FILTER_ACCEPT) return this.#move(node);
    }
    return null;
  }

  firstChild() { return this.#children(true); }
  lastChild() { return this.#children(false); }
  nextSibling() { return this.#siblings(true); }
  previousSibling() { return this.#siblings(false); }

  #children(first) {
    let node = first ? this.#current.firstChild : this.#current.lastChild;
    while (node) {
      const result = this.#accept(node);
      if (result === FILTER_ACCEPT) return this.#move(node);
      if (result === FILTER_SKIP) {
        const child = first ? node.firstChild : node.lastChild;
        if (child) {
          node = child;
          continue;
        }
      }
      while (node) {
        const sibling = first ? node.nextSibling : node.previousSibling;
        if (sibling) {
          node = sibling;
          break;
        }
        const parent = node.parentNode;
        if (!parent || parent === this.#root || parent === this.#current) return null;
        node = parent;
      }
    }
    return null;
  }

  #siblings(next) {
    let node = this.#current;
    if (node === this.#root) return null;
    for (;;) {
      let sibling = next ? node.nextSibling : node.previousSibling;
      while (sibling) {
        node = sibling;
        const result = this.#accept(node);
        if (result === FILTER_ACCEPT) return this.#move(node);
        sibling = next ? node.firstChild : node.lastChild;
        if (result === FILTER_REJECT || !sibling) sibling = next ? node.nextSibling : node.previousSibling;
      }
      node = node.parentNode;
      if (!node || node === this.#root) return null;
      if (this.#accept(node) === FILTER_ACCEPT) return null;
    }
  }

  previousNode() {
    let node = this.#current;
    while (node !== this.#root) {
      let sibling = node.previousSibling;
      while (sibling) {
        node = sibling;
        let result = this.#accept(node);
        while (result !== FILTER_REJECT && node.lastChild) {
          node = node.lastChild;
          result = this.#accept(node);
        }
        if (result === FILTER_ACCEPT) return this.#move(node);
        sibling = node.previousSibling;
      }
      if (node === this.#root || !node.parentNode) return null;
      node = node.parentNode;
      if (this.#accept(node) === FILTER_ACCEPT) return this.#move(node);
    }
    return null;
  }

  nextNode() {
    let node = this.#current;
    let result = FILTER_ACCEPT;
    for (;;) {
      while (result !== FILTER_REJECT && node.firstChild) {
        node = node.firstChild;
        result = this.#accept(node);
        if (result === FILTER_ACCEPT) return this.#move(node);
      }
      let sibling = null;
      for (let temporary = node; temporary; temporary = temporary.parentNode) {
        if (temporary === this.#root) return null;
        sibling = temporary.nextSibling;
        if (sibling) break;
      }
      if (!sibling) return null;
      node = sibling;
      result = this.#accept(node);
      if (result === FILTER_ACCEPT) return this.#move(node);
    }
  }
}

class ClassListBinding {
  #node;
  #realm;

  constructor(key, node, realm) {
    if (key !== CONSTRUCT) throw new TypeError("Illegal constructor");
    this.#node = node;
    this.#realm = realm;
  }

  get length() {
    return this.#node.classList.length;
  }

  get value() {
    return this.#node.className;
  }

  item(index) {
    return this.#node.classList.item(Number(index));
  }

  contains(token) {
    return this.#node.classList.contains(String(token));
  }

  add(...tokens) {
    this.#node.classList.add(...tokens.map(String));
    this.#realm.hooks.touch();
  }

  remove(...tokens) {
    this.#node.classList.remove(...tokens.map(String));
    this.#realm.hooks.touch();
  }

  toggle(token, force) {
    const result = this.#node.classList.toggle(String(token), force === undefined ? undefined : Boolean(force));
    this.#realm.hooks.touch();
    return result;
  }

  replace(oldToken, newToken) {
    const result = this.#node.classList.replace(String(oldToken), String(newToken));
    this.#realm.hooks.touch();
    return result;
  }

  set value(value) {
    this.#node.className = String(value);
    this.#realm.hooks.touch();
  }

  forEach(callback, thisArg) {
    [...this.#node.classList].forEach((token, index) => this.#realm.hooks.call(callback, thisArg, [token, index, this]));
  }

  // Iterable like DOMTokenList (the tokens are plain strings).
  [Symbol.iterator]() {
    return [...this.#node.classList].values();
  }

  keys() {
    return [...this.#node.classList].keys();
  }

  values() {
    return [...this.#node.classList].values();
  }

  entries() {
    return [...this.#node.classList].entries();
  }

  toString() {
    return this.#node.className;
  }
}

/**
 * Properties Happy DOM stores but the renderer does not implement. `in` says
 * no for them, so feature detection (`"anchorName" in el.style`) takes the
 * page's fallback path instead of relying on layout that never happens.
 */
const UNRENDERED_STYLE_PROPERTIES = new Set([
  // CSS Anchor Positioning
  "anchorName", "anchorScope", "positionAnchor", "positionArea", "insetArea", "positionTry",
  "positionTryFallbacks", "positionTryOrder", "positionVisibility",
]);

/**
 * element.style: a proxy that reads and writes the real declaration block
 * with string values only. Mutations go to the style attribute, which the
 * style engine reads.
 */
function styleBinding(node, realm) {
  const style = node.style;
  const toKebab = (property) => property.startsWith("--") ? property
    : property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const methods = {
    getPropertyValue: (property) => style.getPropertyValue(String(property)),
    setProperty: (property, value, priority = "") => {
      style.setProperty(String(property), value === null ? "" : String(value), String(priority));
      realm.hooks.touch();
    },
    removeProperty: (property) => {
      const previous = style.removeProperty(String(property));
      realm.hooks.touch();
      return previous;
    },
  };
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      if (Object.hasOwn(methods, property)) return methods[property];
      if (property === "cssText") return style.cssText;
      if (property === "length") return style.length;
      return style.getPropertyValue(toKebab(property));
    },
    set(_target, property, value) {
      if (typeof property !== "string") return false;
      if (property === "cssText") style.cssText = String(value);
      else style.setProperty(toKebab(property), value === null ? "" : String(value));
      realm.hooks.touch();
      return true;
    },
    has: (_target, property) => typeof property === "string" && (Object.hasOwn(methods, property)
      || property === "cssText" || property === "length"
      || (property in style && !UNRENDERED_STYLE_PROPERTIES.has(property))),
    defineProperty: () => false,
    deleteProperty: () => false,
    getPrototypeOf: () => null,
    setPrototypeOf: () => false,
  });
}

/** element.dataset: data-* attributes as camelCase string properties. */
function datasetBinding(node, realm) {
  const attribute = (property) => `data-${property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      return node.getAttribute(attribute(property)) ?? undefined;
    },
    set(_target, property, value) {
      if (typeof property !== "string") return false;
      node.setAttribute(attribute(property), String(value));
      realm.hooks.touch();
      return true;
    },
    has: (_target, property) => typeof property === "string" && node.hasAttribute(attribute(property)),
    deleteProperty(_target, property) {
      if (typeof property !== "string") return false;
      node.removeAttribute(attribute(property));
      realm.hooks.touch();
      return true;
    },
    ownKeys: () => node.getAttributeNames()
      .filter((name) => name.startsWith("data-"))
      .map((name) => name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())),
    getOwnPropertyDescriptor(_target, property) {
      const value = typeof property === "string" ? node.getAttribute(attribute(property)) : null;
      return value === null ? undefined : { value, writable: true, enumerable: true, configurable: true };
    },
    defineProperty: () => false,
    getPrototypeOf: () => null,
    setPrototypeOf: () => false,
  });
}

function addListener(wrapper, target, type, listener, options) {
  if (typeof listener !== "function" && (listener === null || typeof listener !== "object")) return;
  const realm = realmOf(wrapper) ?? wrapper;
  const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
  const once = typeof options === "object" && options !== null && Boolean(options.once);
  const listeners = realm.listenerFor(target, String(type), listener, capture);
  if (listeners.has(listener)) return;
  const host = (event) => {
    if (realm.hooks.acceptEvent && !realm.hooks.acceptEvent(event)) return;
    if (once) removeListener(wrapper, target, type, listener, options);
    const binding = realm.wrapEvent(event);
    const thisArg = realm.wrap(event.currentTarget) ?? wrapper;
    if (typeof listener === "function") realm.hooks.call(listener, thisArg, [binding]);
    else realm.hooks.call(listener.handleEvent, listener, [binding]);
  };
  listeners.set(listener, host);
  target.addEventListener(String(type), host, { capture });
}

function removeListener(wrapper, target, type, listener, options) {
  const realm = realmOf(wrapper) ?? wrapper;
  const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
  const listeners = realm.listenerFor(target, String(type), listener, capture);
  const host = listeners.get(listener);
  if (!host) return;
  listeners.delete(listener);
  target.removeEventListener(String(type), host, { capture });
}

/** Event listener methods for the page's window object, backed by the real window. */
export function windowEventMethods(realm, pageGlobal) {
  const target = realm.window;
  return {
    addEventListener: (type, listener, options) => addListener(realm, target, type, listener, options),
    removeEventListener: (type, listener, options) => removeListener(realm, target, type, listener, options),
    dispatchEvent: (event) => {
      const real = EventBinding.unwrap(event);
      if (!real) throw new TypeError("dispatchEvent requires an Event");
      return target.dispatchEvent(real);
    },
    targetOf: (real) => real === target ? pageGlobal : null,
  };
}

/**
 * Page-constructible EventTarget (`new EventTarget()` and subclasses). Each
 * instance is backed by its own Happy DOM EventTarget; `targetOf` maps that
 * back to the page object for event.target and the listener's `this`.
 */
export function eventTargetConstructor(realm, isTarget) {
  const backing = new WeakMap();
  const owners = new WeakMap();
  const realOf = (self) => {
    const real = backing.get(self);
    if (!real) throw new TypeError("Illegal invocation");
    return real;
  };
  function EventTarget() {
    if (!new.target) throw new TypeError("Constructor EventTarget requires 'new'");
    const self = Object.create(new.target.prototype);
    const real = new realm.window.EventTarget();
    backing.set(self, real);
    owners.set(real, self);
    return self;
  }
  EventTarget.prototype = {
    constructor: EventTarget,
    addEventListener(type, listener, options) {
      addListener(realm, realOf(this), type, listener, options);
    },
    removeEventListener(type, listener, options) {
      removeListener(realm, realOf(this), type, listener, options);
    },
    dispatchEvent(event) {
      const real = EventBinding.unwrap(event);
      if (!real) throw new TypeError("dispatchEvent requires an Event");
      return realOf(this).dispatchEvent(real);
    },
  };
  // Nodes and the window are event targets too, though not built from this constructor.
  Object.defineProperty(EventTarget, Symbol.hasInstance, {
    value: (value) => backing.has(value) || isTarget(value)
      || Function.prototype[Symbol.hasInstance].call(EventTarget, value),
  });
  return { EventTarget, targetOf: (real) => owners.get(real) ?? null };
}

const UI_EVENT_TYPES = ["UIEvent", "MouseEvent", "PointerEvent", "WheelEvent", "KeyboardEvent", "FocusEvent", "InputEvent"];
const UI_EVENT_FIELDS = [
  ...["detail", "clientX", "clientY", "screenX", "screenY", "button", "buttons", "deltaX", "deltaY", "deltaZ", "deltaMode",
    "pointerId", "width", "height", "pressure", "location"].map((key) => [key, Number]),
  ...["key", "code", "data", "inputType", "pointerType"].map((key) => [key, String]),
  ...["ctrlKey", "altKey", "shiftKey", "metaKey", "repeat", "isComposing", "isPrimary"].map((key) => [key, Boolean]),
];

/** Page-constructible Event, CustomEvent and UI event classes. */
export function eventConstructors(realm) {
  const window = realm.window;
  const init = (options) => ({
    bubbles: Boolean(options?.bubbles),
    cancelable: Boolean(options?.cancelable),
    composed: Boolean(options?.composed),
  });
  function Event(type, options = undefined) {
    if (!new.target) throw new TypeError("Constructor Event requires 'new'");
    return realm.wrapEvent(new window.Event(String(type), init(options)));
  }
  function CustomEvent(type, options = undefined) {
    if (!new.target) throw new TypeError("Constructor CustomEvent requires 'new'");
    // detail stays in the binding: page values never enter Happy DOM.
    return realm.wrapEvent(new window.CustomEvent(String(type), init(options)), options?.detail);
  }
  realm.eventPrototype = mutableBindingPrototype(EventBinding.prototype);
  Event.prototype = realm.eventPrototype;
  CustomEvent.prototype = realm.eventPrototype;
  // UI event subclasses: their init dictionaries are copied as primitives only
  // (view and relatedTarget are dropped).
  const uiEvents = {};
  for (const name of UI_EVENT_TYPES) {
    const RealEvent = window[name];
    if (typeof RealEvent !== "function") continue;
    const Constructor = function (type, options = undefined) {
      if (!new.target) throw new TypeError(`Constructor ${name} requires 'new'`);
      const fields = { ...init(options) };
      for (const [key, coerce] of UI_EVENT_FIELDS) {
        if (options?.[key] !== undefined) fields[key] = coerce(options[key]);
      }
      return realm.wrapEvent(new RealEvent(String(type), fields));
    };
    Object.defineProperty(Constructor, "name", { value: name });
    Constructor.prototype = realm.eventPrototype;
    uiEvents[name] = Constructor;
  }
  return { Event, CustomEvent, ...uiEvents };
}

function domRect({ left, top, width, height }) {
  return {
    x: left, y: top, left, top, width, height,
    right: left + width, bottom: top + height,
    toJSON() {
      return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height };
    },
  };
}

function cssEscape(value) {
  return value.replace(/["\\\]]/g, "\\$&");
}

/**
 * Freezes the binding classes so no page can change the shared prototypes.
 * Must run after SES lockdown() (which provides `harden`).
 */
export function hardenBindings() {
  if (typeof harden !== "function") return;
  for (const Binding of [NodeBinding, CharacterDataBinding, TextBinding, ParentBinding, FragmentBinding, ShadowRootBinding, ElementBinding,
    DocumentBinding, EventBinding, ClassListBinding, TreeWalkerBinding]) {
    harden(Binding);
  }
}

/** Interface objects for `instanceof` checks; all throw "Illegal constructor" when called. */
export const INTERFACES = Object.freeze({
  Node: NodeBinding,
  CharacterData: CharacterDataBinding,
  Text: TextBinding,
  Element: ElementBinding,
  HTMLElement: ElementBinding,
  Document: DocumentBinding,
  HTMLDocument: DocumentBinding,
  DocumentFragment: FragmentBinding,
  ShadowRoot: ShadowRootBinding,
  TreeWalker: TreeWalkerBinding,
  DOMTokenList: ClassListBinding,
});
