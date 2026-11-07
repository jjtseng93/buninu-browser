import {moveNodeBefore} from '../happy-dom/node-move.js';
import { actuallyDisabled } from '../happy-dom/form-disabled.js';
import {indexedElement} from './indexed-element.js';
import {contentEditable, setContentEditable, isContentEditable, designMode, setDesignMode} from './editable-state.js';
import {mediaFileTypeSupported} from '../media/codec-support.js';
import {animationProperty} from '../style/animation-values.js';
import {cssDeclarationRevision} from '../happy-dom/css-declaration-mutations.js';
import {inputFiles} from './file-input.js';
import {encodingString} from './encoding-string.js';
import {characterDataString, nodeTextString} from '../happy-dom/node-text.js';
import {signalSlotChange} from '../happy-dom/slot-notifications.js';
import {replaceOuterHTML, parseMarkupFragment} from '../happy-dom/markup-fragment.js';
import {replaceAllNodes, withCustomElementReactions} from '../happy-dom/node-replace-all.js';
import {shadowRoot as nativeShadowRoot} from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import {locateNamespace, locateNamespacePrefix, elementById} from '../happy-dom/node-queries.js';
import {containsNode, compareNodePosition} from '../happy-dom/node-comparison.js';
import {inputNumberValue, setInputNumberValue, setInputDateValue, stepInputValue} from '../happy-dom/input-value-api.js';
import {inputDateTimestamp} from '../happy-dom/input-value-types.js';
import {createCDATASection} from '../happy-dom/cdata-section.js';
import {adoptNode, importNode} from '../happy-dom/node-document-transfer.js';
import {createElement, createElementNS} from '../happy-dom/element-factories.js';
import {labelCollectionQuery} from '../happy-dom/label-associations.js';
import {optionText, optionValue, optionLabel} from '../happy-dom/option-values.js';
import {textSelection, setTextSelection, setTextSelectionRange, replaceTextSelection, selectTextControl} from '../happy-dom/text-control-selection.js';
import {markEventTrusted, isEventTrusted, markEventUninitialized, initializeEvent, isEventDispatching, dispatchScriptEvent, exposedEventTarget} from '../happy-dom/event-state.js';
import {createDetachedDocument, documentOriginURL, documentEncoding, elementTagName} from './document-constructor.js';
import { DataTransfer, dragData, dragEvent, isDraggable } from './html-drag.js';
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
import { replaceNode, replaceWithNodes, insertAdjacentNodes } from '../happy-dom/node-replacement.js';
import { observeIteratorRemoval } from '../happy-dom/node-iterator-removal.js';
import { renderedText, setRenderedText } from "./rendered-text.js";
import { assignedSlot, slotAssignedNodes, assignSlotNodes } from "./slot-assignment.js";
import { scrollIntoViewOptions, scrollAlignmentDelta } from "./scroll-into-view.js";
import { documentBaseURL } from "../happy-dom/document-base.js";
import { resetCanvas } from "./canvas-2d.js";
import {installKeyboardEventInterface} from './keyboard-event.js';
import {supplementalEventInterfaces, supplementalEventName} from './legacy-event-interfaces.js';
import {isStorage} from './interfaces.js';
import {isWindow} from './window-brand.js';
import { proxy as nodeProxy, listeners as nativeListeners } from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import NativeDOMException from '../../vendor/happy-dom/packages/happy-dom/src/exception/DOMException.ts';

const CONSTRUCT = Symbol("binding construction key");
// Element proxies share the same hidden native node/realm as their target.
const indexedBindings = new WeakMap();
const domString = value => encodingString(value, (_name, message) => new TypeError(message));
const bindingTypeError = (realm, message) => new (realm.hooks.pageGlobal?.()?.TypeError ?? TypeError)(message);
// WebIDL ToNumber conversion; page-thrown exceptions propagate unchanged.
// Number(value) alone would incorrectly accept BigInt (including boxed ones).
export function bindingNumber(value, realm, label) {
  const object = v => v !== null && (typeof v === 'object' || typeof v === 'function');
  if (object(value)) {
    const exotic = value[Symbol.toPrimitive];
    if (exotic != null) {
      if (typeof exotic !== 'function') throw bindingTypeError(realm, 'Invalid primitive converter');
      value = Reflect.apply(exotic, value, ['number']);
    } else {
      const original = value;
      for (const key of ['valueOf', 'toString']) {
        const method = original[key];
        if (typeof method === 'function') {
          value = Reflect.apply(method, original, []);
          if (!object(value)) break;
        }
      }
    }
  }
  if (object(value) || typeof value === 'symbol' || typeof value === 'bigint')
    throw bindingTypeError(realm, `Cannot convert ${label} to a number`);
  return Number(value);
}
function eventLong(value, realm, label = 'event detail') {
  return bindingNumber(value, realm, label) | 0;
}
function finiteDouble(value, realm, label) {
  const number = bindingNumber(value, realm, label);
  if (!Number.isFinite(number)) throw bindingTypeError(realm, `${label} must be finite`);
  return number;
}
const clipboardEventData = new WeakMap();
const isCanvasSizeAttribute = (node, name, namespace = null) => !namespace
  && node.namespaceURI === "http://www.w3.org/1999/xhtml" && node.tagName === "CANVAS"
  && (name === "width" || name === "height");
const REFLECTED_PROPERTIES = [
  "selectionStart", "selectionEnd", "selectionDirection", "minLength", "maxLength",
  "value", "checked", "disabled", "type", "name", "href", "src", "alt", "title",
  "placeholder", "selected", "defaultSelected", "defaultChecked", "readOnly", "required", "min", "max", "step", "rel", "target",
  "htmlFor", "lang", "dir", "tabIndex", "hidden", "inert", "defaultValue", "action", "method",
  "controls", "autoplay", "loop", "playsInline", "preload", "poster",
];

/** Per-document state shared by that document's wrappers. */
export class BindingRealm {
  #wrappers = new WeakMap();
  #listeners = new WeakMap();
  #events = new WeakMap();
  // MessageEvent fields (data, origin, lastEventId, source, ports) by engine
  // event: page values stay on this side, as CustomEvent detail does.
  #messages = new WeakMap();
  #liveViews = new WeakMap();
  #ranges = new WeakMap();
  #hooks;
  #window;
  eventPrototype = null;
  elementPrototype = null;
  /** @type {((node: object) => object) | null} the prototype for an element's wrapper */
  elementPrototypeOf = null;
  fragmentPrototype = null;
  shadowRootPrototype = null;
  rangePrototype = null;
  textPrototype = null;
  characterDataPrototype = null;
  nodePrototype = null;
  datasetPrototype = null;
  wrapValidity = null;
  documentPrototype = null;
  documentPrototypeOf = null;

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
    // Forms and selects have an internal named-property proxy. Native Attr
    // owners may point at its target; expose one wrapper for either identity.
    node = node[nodeProxy] ?? node;
    let wrapper = this.#wrappers.get(node);
    if (!wrapper) {
      const Binding = node.nodeType === 1 ? ElementBinding
        : node.nodeType === 9 ? DocumentBinding
          : node.nodeType === 11 ? (node instanceof this.#window.ShadowRoot ? ShadowRootBinding : FragmentBinding)
            : node.nodeType === 3 || node.nodeType === 4 ? TextBinding
              : node.nodeType === 7 ? ProcessingInstructionBinding
              : node.nodeType === 10 ? DocumentTypeBinding
              : node.nodeType === 8 ? CharacterDataBinding
                : node.nodeType === 2 ? AttrBinding : NodeBinding;
      wrapper = new Binding(CONSTRUCT, node, this);
      if (Binding === ElementBinding && this.elementPrototype) {
        Object.setPrototypeOf(wrapper, this.elementPrototypeOf?.(node) ?? this.elementPrototype);
      }
      if (Binding === FragmentBinding && this.fragmentPrototype) Object.setPrototypeOf(wrapper, this.fragmentPrototype);
      if (Binding === ShadowRootBinding && this.shadowRootPrototype) Object.setPrototypeOf(wrapper, this.shadowRootPrototype);
      if (Binding === TextBinding && this.textPrototype) Object.setPrototypeOf(wrapper, node.nodeType === 4 ? this.cdataPrototype ?? this.textPrototype : this.textPrototype);
      if (Binding === CharacterDataBinding && this.characterDataPrototype) Object.setPrototypeOf(wrapper, this.commentPrototype ?? this.characterDataPrototype);
      if (Binding === ProcessingInstructionBinding && this.processingInstructionPrototype) Object.setPrototypeOf(wrapper, this.processingInstructionPrototype);
      if (Binding === DocumentTypeBinding && this.documentTypePrototype) Object.setPrototypeOf(wrapper, this.documentTypePrototype);
      if (Binding === AttrBinding && this.attrPrototype) Object.setPrototypeOf(wrapper, this.attrPrototype);
      if (Binding === NodeBinding && this.nodePrototype) Object.setPrototypeOf(wrapper, this.nodePrototype);
      if (Binding === DocumentBinding && this.documentPrototype) Object.setPrototypeOf(wrapper, this.documentPrototypeOf?.(node) ?? this.documentPrototype);
      if (node.nodeType === 1 && node.namespaceURI === 'http://www.w3.org/1999/xhtml'
        && node.localName === 'select' && this.optionsCollections) {
        const target = wrapper;
        wrapper = indexedElement(target, {
          length:() => node.options.length,
          get:index => this.wrap(node.options[index]),
          set:(index, value) => this.optionsCollections.setIndex(node, index, value),
        });
        indexedBindings.set(wrapper, target);
      }
      this.#wrappers.set(node, wrapper);
    }
    return wrapper;
  }

  /**
   * A live NodeList/HTMLCollection over a Happy DOM collection (DOM §4.2.10):
   * length and indices read through on every access, so a loop that moves
   * nodes out (`while (list.length) fragment.appendChild(list[0])`) ends as
   * it does in browsers. HTMLCollection uses legacy indexed/named properties;
   * NodeList exposes only indexed properties and standard iterable methods.
   * One view per collection keeps `el.childNodes === el.childNodes`.
   */
  live(collection) {
    if (!collection) return null;
    let view = this.#liveViews.get(collection);
    if (view) return view;
    const realm = this;
    if (typeof collection.namedItem === 'function' && this.htmlCollections) {
      view = this.htmlCollections.create(collection, node => this.wrap(node));
      this.#liveViews.set(collection, view);
      return view;
    }
    if (this.nodeLists) {
      view = this.nodeLists.create(collection, node => this.wrap(node));
      this.#liveViews.set(collection, view);
      return view;
    }
    const at = (index) => index < collection.length ? realm.wrap(collection[index] ?? collection.item?.(index)) : undefined;
    const isIndex = (property) => typeof property === "string" && /^(?:0|[1-9]\d*)$/.test(property);
    const methods = {
      item: (index) => at(Number(index) >>> 0) ?? null,
      namedItem: (name) => {
        const key = String(name);
        for (let index = 0; index < collection.length; index++) {
          const node = collection[index];
          if (node?.getAttribute?.("id") === key || node?.getAttribute?.("name") === key) return realm.wrap(node);
        }
        return null;
      },
    };
    // Indices and length read through; other properties a page sets are
    // expandos kept on the target (they shadow item/namedItem, as an own
    // property on a browser's collection does).
    const expando = (target, property) => property !== "length" && !isIndex(property) && Object.hasOwn(target, property);
    view = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") return collection.length;
        if (isIndex(property)) return at(Number(property));
        if (expando(target, property)) return target[property];
        if (Object.hasOwn(methods, property)) return methods[property];
        return Reflect.get(target, property, receiver);
      },
      has: (target, property) => property === "length" || Object.hasOwn(methods, property)
        || (isIndex(property) ? Number(property) < collection.length : Reflect.has(target, property)),
      getOwnPropertyDescriptor(target, property) {
        if (property === "length") return { value: collection.length, writable: true, enumerable: false, configurable: false };
        if (isIndex(property) && Number(property) < collection.length) {
          return { value: at(Number(property)), writable: false, enumerable: true, configurable: true };
        }
        return expando(target, property) ? Reflect.getOwnPropertyDescriptor(target, property) : undefined;
      },
      ownKeys: (target) => [...Array.from({ length: collection.length }, (_, index) => String(index)), "length",
        ...Reflect.ownKeys(target).filter((key) => expando(target, key))],
      set(target, property, value) {
        if (property === "length" || isIndex(property)) return false;
        if (expando(target, property)) {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
          if (!("value" in descriptor)) return descriptor.set ? (descriptor.set.call(view, value), true) : false;
          if (!descriptor.writable) return false;
        }
        return Reflect.defineProperty(target, property, expando(target, property)
          ? { value } : { value, writable: true, enumerable: true, configurable: true });
      },
      defineProperty: (target, property, descriptor) =>
        property !== "length" && !isIndex(property) && Reflect.defineProperty(target, property, descriptor),
      deleteProperty: (target, property) => !isIndex(property) && property !== "length" && Reflect.deleteProperty(target, property),
    });
    this.#liveViews.set(collection, view);
    return view;
  }

  wrapAll(nodes) {
    return Array.from(nodes ?? [], (node) => this.wrap(node));
  }

  selectOptions(select) {
    const collection = select.options;
    let view = this.#liveViews.get(collection);
    if (!view) { view = this.optionsCollections.create(select); this.#liveViews.set(collection, view); }
    return view;
  }

  staticList(nodes) {
    return this.nodeLists ? this.nodeLists.create(Array.from(nodes), node => this.wrap(node), {static:true}) : this.wrapAll(nodes);
  }

  /** A MessageEvent for the page: an engine event carrying page-side fields. */
  messageEvent(type, { data = null, origin = "", lastEventId = "", source = null, ports = [] } = {}, init = {}) {
    const event = new this.#window.Event(String(type), init);
    this.#messages.set(event, Object.freeze({ data, origin: String(origin), lastEventId: String(lastEventId), source,
      ports: Object.freeze([...ports]) }));
    return this.wrapEvent(event);
  }

  /** The engine event behind a page event, or null. */
  unwrapEvent(value) {
    return EventBinding.unwrap(value);
  }

  /** Marks an event created by the browser's input path as trusted. */
  markTrusted(value) {
    const event = EventBinding.unwrap(value) ?? (value && typeof value === "object" ? value : null);
    if (event) markEventTrusted(event);
  }

  isTrusted(event) {
    return isEventTrusted(event);
  }

  /** The MessageEvent fields of an engine event, if it is one. */
  messageOf(event) {
    return this.#messages.get(event) ?? null;
  }

  /** The page's Range for an engine Range (one wrapper each). */
  unwrapRange(range) { return RangeBinding.rangeOf(range); }

  wrapRange(range) {
    if (!range) return null;
    let wrapper = this.#ranges.get(range);
    if (!wrapper) {
      wrapper = new RangeBinding(CONSTRUCT, range, this);
      if (this.rangePrototype) Object.setPrototypeOf(wrapper, this.rangePrototype);
      this.#ranges.set(range, wrapper);
    }
    return wrapper;
  }

  /** One wrapper per event, so listeners see the dispatched object (and its detail). */
  wrapEvent(event, detail = undefined) {
    if (!event) return null;
    let wrapper = this.#events.get(event);
    if (!wrapper) {
      wrapper = new EventBinding(CONSTRUCT, event, this, detail);
      if (this.eventPrototype) {
        const prototype = this.eventPrototypes?.get(this.#messages.has(event) ? "MessageEvent" : clipboardEventData.has(event) ? "ClipboardEvent" : dragData(event) !== undefined ? "DragEvent" : supplementalEventName(event) ?? event.constructor?.name) ?? this.eventPrototype;
        Object.setPrototypeOf(wrapper, prototype);
        // isTrusted is [LegacyUnforgeable]: an own accessor of every event.
        const isTrusted = Object.getOwnPropertyDescriptor(EventBinding.prototype, "isTrusted");
        Object.defineProperty(wrapper, "isTrusted", { get: isTrusted.get, enumerable: true, configurable: false });
      }
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
    // Web IDL attributes and operations are enumerable (class members are not).
    if (typeof key === "string") descriptor.enumerable = true;
    Object.defineProperty(prototype, key, descriptor);
  }
  // An own, writable constructor (callers set the page's): an inherited one
  // from a hardened class would be read-only, and then a page subclass's
  // `Sub.prototype = Object.create(Base.prototype); Sub.prototype.constructor = Sub`
  // fails (the override mistake).
  Object.defineProperty(prototype, "constructor", { value: base.constructor, writable: true, configurable: true });
  return prototype;
}

function realmOf(wrapper) {
  return NodeBinding.realmOf(wrapper);
}

/** Translate only parser exceptions; page string-conversion exceptions retain identity. */
function selectorQuery(wrapper, method, args) {
  if (!args.length) throw new TypeError(`${method} requires a selector`);
  const selector = '' + args[0], realm = realmOf(wrapper), node = nodeOf(wrapper);
  try { return node[method](selector); }
  catch (error) {
    if (error instanceof realm.window.DOMException) throw new DOMException(error.message, 'SyntaxError');
    throw error;
  }
}

/** Converts page input to a node: wrappers are unwrapped, anything else becomes text. */
function toNode(wrapper, value) {
  const node = nodeOf(value);
  if (node) return node;
  return realmOf(wrapper).window.document.createTextNode(String(value));
}

/** The page changed `wrapper`'s node (state the style engine may read: attributes, checked, value). */
function touch(wrapper, stateFeatures = [], mutation = null) {
  realmOf(wrapper).hooks.touch(NodeBinding.unwrap(wrapper), stateFeatures, mutation);
}

/**
 * Nodes put into the tree by page code (not by innerHTML, whose scripts
 * never run): the realm starts any script elements that became connected.
 */
function inserted(wrapper, nodes) {
  const realm = realmOf(wrapper);
  realm.hooks.touch(NodeBinding.unwrap(wrapper), [], 'childList');
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
    if (value === null || typeof value !== 'object') return null;
    if (#node in value) return value.#node;
    const target = indexedBindings.get(value);
    return target ? target.#node : null;
  }

  static realmOf(value) {
    if (value === null || typeof value !== 'object') return null;
    if (#realm in value) return value.#realm;
    const target = indexedBindings.get(value);
    return target ? target.#realm : null;
  }

  get nodeType() {
    return nodeOf(this).nodeType;
  }

  get nodeName() {
    return nodeOf(this).nodeType === 1 ? elementTagName(nodeOf(this))
      : nodeOf(this).nodeType === 2 ? nodeOf(this).name : nodeOf(this).nodeName;
  }

  /** The document base URL (HTML §2.4.1): the first <base href>, else the document's URL. */
  get baseURI() {
    return documentBaseURL(nodeOf(this));
  }

  get nodeValue() {
    return nodeOf(this).nodeType === 2 ? nodeOf(this).value ?? '' : nodeOf(this).nodeValue ?? null;
  }

  set nodeValue(value) {
    value = nodeTextString(value);
    if (nodeOf(this).nodeType === 2) return setAttrValue(this, value);
    if ([3, 4, 7, 8].includes(nodeOf(this).nodeType)) {
      nodeOf(this).nodeValue = value;
      touch(this, [], 'characterData');
    }
  }

  get textContent() {
    return nodeOf(this).textContent;
  }

  set textContent(value) {
    value = nodeTextString(value);
    if (nodeOf(this).nodeType === 2) return setAttrValue(this, value);
    nodeOf(this).textContent = value;
    if ([1, 3, 4, 7, 8, 11].includes(nodeOf(this).nodeType))
      touch(this, [], [1, 11].includes(nodeOf(this).nodeType) ? 'childList' : 'characterData');
  }

  get parentNode() {
    return realmOf(this).wrap(nodeOf(this).parentNode);
  }

  get parentElement() {
    return realmOf(this).wrap(nodeOf(this).parentElement);
  }

  get childNodes() {
    return realmOf(this).live(nodeOf(this).childNodes);
  }

  get firstChild() {
    return realmOf(this).wrap(nodeOf(this).firstChild);
  }

  get lastChild() {
    return realmOf(this).wrap(nodeOf(this).lastChild);
  }

  get nextSibling() {
    return realmOf(this).wrap(nodeOf(this).nextSibling);
  }

  get previousSibling() {
    return realmOf(this).wrap(nodeOf(this).previousSibling);
  }

  get ownerDocument() {
    return realmOf(this).wrap(nodeOf(this).ownerDocument);
  }

  get isConnected() {
    return Boolean(nodeOf(this).isConnected);
  }

  hasChildNodes() {
    return nodeOf(this).hasChildNodes();
  }

  contains(other) {
    if (!arguments.length) throw new TypeError('One argument is required');
    const node = nodeOf(other);
    if (other != null && !node) throw new TypeError("Parameter is not of type 'Node'");
    return containsNode(nodeOf(this), node);
  }

  /** Where `other` is relative to this node, as DOCUMENT_POSITION_* bits (DOM §4.4). */
  compareDocumentPosition(other) {
    const node = nodeOf(other);
    if (!node) throw new TypeError("Failed to execute 'compareDocumentPosition' on 'Node': parameter 1 is not of type 'Node'.");
    return compareNodePosition(nodeOf(this), node);
  }

  getRootNode(options = undefined) {
    return realmOf(this).wrap(nodeOf(this).getRootNode({ composed: Boolean(options?.composed) }));
  }

  isSameNode(other) {
    return other === this || (nodeOf(other) !== null && nodeOf(other) === nodeOf(this));
  }

  isEqualNode(other) {
    const node = nodeOf(other);
    return node ? nodeOf(this).isEqualNode(node) : false;
  }

  normalize() {
    nodeOf(this).normalize();
    realmOf(this).hooks.touch(nodeOf(this));
  }

  // DOM §4.4 "locate a namespace" and "locate a namespace prefix".
  lookupNamespaceURI(prefix) {
    prefix = prefix == null ? null : domString(prefix);
    return locateNamespace(nodeOf(this), prefix === '' ? null : prefix);
  }

  lookupPrefix(namespace) {
    return locateNamespacePrefix(nodeOf(this), namespace == null ? null : domString(namespace));
  }

  isDefaultNamespace(namespace) {
    namespace = namespace == null ? null : domString(namespace);
    return locateNamespace(nodeOf(this), null) === (namespace === '' ? null : namespace);
  }

  appendChild(child) {
    const node = requireNode(child);
    const list = insertionList([node]);
    nodeOf(this).appendChild(node);
    inserted(this, list);
    return child;
  }

  insertBefore(child, reference) {
    const node = requireNode(child);
    const list = insertionList([node]);
    nodeOf(this).insertBefore(node, nodeOf(reference));
    inserted(this, list);
    return child;
  }

  removeChild(child) {
    nodeOf(this).removeChild(requireNode(child));
    touch(this, [], 'childList');
    return child;
  }

  replaceChild(child, old) {
    const node = requireNode(child);
    const list = insertionList([node]);
    replaceNode(nodeOf(this), node, requireNode(old));
    inserted(this, list);
    return old;
  }

  cloneNode(deep = false) {
    return realmOf(this).wrap(nodeOf(this).cloneNode(Boolean(deep)));
  }

  addEventListener(type, listener, options = undefined) {
    addListener(this, nodeOf(this), type, listener, options);
  }

  removeEventListener(type, listener, options = undefined) {
    removeListener(this, nodeOf(this), type, listener, options);
  }

  dispatchEvent(event) {
    const target = nodeOf(this);
    const real = EventBinding.unwrap(event);
    if (!real) throw bindingTypeError(realmOf(this), "dispatchEvent requires an Event");
    return dispatchScriptEvent(target, real, () => realmOf(this).hooks.prepareEvent?.(target, real.type));
  }
}

function requireNode(value) {
  const node = nodeOf(value);
  if (!node) throw new TypeError("parameter is not of type 'Node'");
  return node;
}

/** Text and comments; frameworks read comment data (React's hydration markers). */
// Node constants (DOM §4.4) on instances too, and the one the class lacks.
for (const [name, value] of Object.entries({
  ELEMENT_NODE: 1, ATTRIBUTE_NODE: 2, TEXT_NODE: 3, CDATA_SECTION_NODE: 4, PROCESSING_INSTRUCTION_NODE: 7,
  ENTITY_REFERENCE_NODE: 5, ENTITY_NODE: 6, COMMENT_NODE: 8, DOCUMENT_NODE: 9, DOCUMENT_TYPE_NODE: 10,
  DOCUMENT_FRAGMENT_NODE: 11, NOTATION_NODE: 12,
  DOCUMENT_POSITION_DISCONNECTED: 1, DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4,
  DOCUMENT_POSITION_CONTAINS: 8, DOCUMENT_POSITION_CONTAINED_BY: 16, DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 32,
})) {
  if (!Object.hasOwn(NodeBinding, name)) Object.defineProperty(NodeBinding, name, { value, enumerable: true });
  if (!Object.hasOwn(NodeBinding.prototype, name)) Object.defineProperty(NodeBinding.prototype, name, { value, enumerable: true });
}

class CharacterDataBinding extends NodeBinding {
  get nextElementSibling() {
    let node = nodeOf(this).nextSibling;
    while (node && node.nodeType !== 1) node = node.nextSibling;
    return realmOf(this).wrap(node);
  }
  get previousElementSibling() {
    let node = nodeOf(this).previousSibling;
    while (node && node.nodeType !== 1) node = node.previousSibling;
    return realmOf(this).wrap(node);
  }
  get data() { return nodeOf(this).data; }
  set data(value) {
    nodeOf(this).data = characterDataString(value);
    touch(this, [], 'characterData');
  }
  get length() { return nodeOf(this).data.length; }
  substringData(offset, count) {
    if (arguments.length < 2) throw new TypeError("substringData requires two arguments");
    offset = +offset >>> 0; count = +count >>> 0;
    const data = nodeOf(this).data;
    if (offset > data.length) throw new DOMException("Offset exceeds data length", "IndexSizeError");
    return data.slice(offset, offset + count);
  }
  appendData(data) {
    if (!arguments.length) throw new TypeError("appendData requires an argument");
    const text = "" + data, node = nodeOf(this);
    node.data += text;
    touch(this, [], 'characterData');
  }
  insertData(offset, data) {
    if (arguments.length < 2) throw new TypeError("insertData requires two arguments");
    CharacterDataBinding.prototype.replaceData.call(this, offset, 0, data);
  }
  deleteData(offset, count) {
    if (arguments.length < 2) throw new TypeError("deleteData requires two arguments");
    CharacterDataBinding.prototype.replaceData.call(this, offset, count, "");
  }
  replaceData(offset, count, data) {
    if (arguments.length < 3) throw new TypeError("replaceData requires three arguments");
    offset = +offset >>> 0; count = +count >>> 0; data = "" + data;
    const node = nodeOf(this), previous = node.data;
    if (offset > previous.length) throw new DOMException("Offset exceeds data length", "IndexSizeError");
    // DOM offsets count UTF-16 code units, including individual surrogates.
    node.data = previous.slice(0, offset) + data + previous.slice(offset + count);
    touch(this, [], 'characterData');
  }
}

class ProcessingInstructionBinding extends CharacterDataBinding {
  get target() { return nodeOf(this).target; }
}

// Accessors belong to their defining page, even when borrowed by another
// realm. Do conversion outside mutation code so author-thrown errors retain
// their identity, and before the node-type-specific no-op for Document etc.
export function installNodeTextAccessors(nodePrototype, characterPrototype, realm) {
  const TypeErrorConstructor = realm.inputValueIntrinsics.TypeError;
  const error = (_name, message) => new TypeErrorConstructor(message);
  for (const [prototype, base, properties] of [
    [nodePrototype, NodeBinding.prototype, ['nodeValue', 'textContent']],
    [characterPrototype, CharacterDataBinding.prototype, ['data']],
  ]) for (const property of properties) {
    const descriptor = Object.getOwnPropertyDescriptor(base, property);
    const receiver = self => {
      const node = nodeOf(self);
      if (!node || property === 'data' && ![3, 4, 7, 8].includes(node.nodeType))
        throw error('TypeError', 'Illegal invocation');
    };
    Object.defineProperty(prototype, property, {configurable: true, enumerable: true,
      get() {
        receiver(this);
        return descriptor.get.call(this);
      },
      set(value) {
        receiver(this);
        value = property === 'data' ? characterDataString(value, error) : nodeTextString(value, error);
        descriptor.set.call(this, value);
      },
    });
  }
}

export function installOuterHTMLAccessor(elementPrototype, realm) {
  const TypeErrorConstructor = realm.inputValueIntrinsics.TypeError;
  const error = (_name, message) => new TypeErrorConstructor(message);
  const receiver = self => {
    const node = nodeOf(self);
    if (node?.nodeType !== 1) throw error('TypeError', 'Illegal invocation');
    return node;
  };
  Object.defineProperty(elementPrototype, 'outerHTML', {configurable:true, enumerable:true,
    get() {return receiver(this).outerHTML;},
    set(value) {
      const node = receiver(this);
      // TrustedHTML uses the existing policy object's string value. CSP
      // Trusted Types enforcement is not implemented by the other sinks.
      const parent = replaceOuterHTML(node, characterDataString(value, error));
      if (parent) realmOf(this).hooks.touch(parent);
    },
  });
}

// Query conversions and brand errors belong to the function's defining realm,
// while results are wrapped in the receiver's realm. Capture intrinsics before
// author code can replace the page's global constructors.
export function installNodeQueryMethods(nodePrototype, documentPrototype, fragmentPrototype, realm) {
  const TypeErrorConstructor = realm.inputValueIntrinsics.TypeError;
  const error = (_name, message) => new TypeErrorConstructor(message);
  const receiver = (self, type) => {
    const node = nodeOf(self);
    if (!node || type !== undefined && node.nodeType !== type) throw error('TypeError', 'Illegal invocation');
    return node;
  };
  const required = count => {
    if (!count) throw error('TypeError', 'One argument is required');
  };
  const nullableString = value => value == null ? null : encodingString(value, error);
  const methods = {
    lookupNamespaceURI(prefix) {
      const node = receiver(this);
      required(arguments.length);
      prefix = nullableString(prefix);
      return locateNamespace(node, prefix === '' ? null : prefix);
    },
    lookupPrefix(namespace) {
      const node = receiver(this);
      required(arguments.length);
      return locateNamespacePrefix(node, nullableString(namespace));
    },
    isDefaultNamespace(namespace) {
      const node = receiver(this);
      required(arguments.length);
      namespace = nullableString(namespace);
      return locateNamespace(node, null) === (namespace === '' ? null : namespace);
    },
  };
  for (const [name, value] of Object.entries(methods))
    Object.defineProperty(nodePrototype, name, {value, enumerable: true, writable: true, configurable: true});
  for (const [prototype, type] of [[documentPrototype, 9], [fragmentPrototype, 11]]) {
    const method = {getElementById(id) {
      const node = receiver(this, type);
      required(arguments.length);
      id = encodingString(id, error);
      return realmOf(this).wrap(elementById(node, id));
    }}.getElementById;
    Object.defineProperty(prototype, 'getElementById', {value: method, enumerable: true, writable: true, configurable: true});
  }
}

// WebIDL errors belong to the method's defining realm, including when a
// method is borrowed by another document. Node arguments are never coerced.
export function installNodeComparisonMethods(nodePrototype, realm) {
  const TypeErrorConstructor = realm.inputValueIntrinsics.TypeError;
  const receiver = self => {
    const node = nodeOf(self);
    if (!node) throw new TypeErrorConstructor('Illegal invocation');
    return node;
  };
  const argument = (value, count, nullable) => {
    if (!count) throw new TypeErrorConstructor('One argument is required');
    if (nullable && value == null) return null;
    const node = nodeOf(value);
    if (!node) throw new TypeErrorConstructor("Parameter is not of type 'Node'");
    return node;
  };
  const methods = {
    contains(other) {
      const node = receiver(this);
      return containsNode(node, argument(other, arguments.length, true));
    },
    compareDocumentPosition(other) {
      const node = receiver(this);
      return compareNodePosition(node, argument(other, arguments.length, false));
    },
  };
  for (const [name, value] of Object.entries(methods))
    Object.defineProperty(nodePrototype, name, {value, enumerable:true, writable:true, configurable:true});
}

export function installMoveBeforeMethods(prototypes, realm) {
  const {TypeError: Error, DOMException: Exception} = realm.inputValueIntrinsics;
  for (const [prototype, type] of prototypes) {
    const moveBefore = {moveBefore(node, child) {
      const parent = nodeOf(this), moving = nodeOf(node), reference = child == null ? null : nodeOf(child);
      if (parent?.nodeType !== type) throw new Error('Illegal invocation');
      if (arguments.length < 2) throw new Error('moveBefore requires two arguments');
      if (!moving || child != null && !reference) throw new Error("Parameter is not of type 'Node'");
      const oldParent = moveNodeBefore(parent, moving, reference, Exception);
      const hooks = realmOf(this).hooks;
      hooks.touch(oldParent); hooks.touch(parent);
      hooks.atomicMove?.(moving);
    }}.moveBefore;
    Object.defineProperty(prototype, 'moveBefore', {value:moveBefore,writable:true,enumerable:true,configurable:true});
  }
}

/** Unsafe HTML parsing deliberately retains markup, while scripts remain
 * inert. Unsupported sanitizer/script-execution options fail explicitly. */
export function installHTMLParsingMethods(elementPrototype, shadowPrototype, templatePrototype, Document, realm, parseDocument) {
  const {TypeError: Error, DOMException: Exception} = realm.inputValueIntrinsics;
  const string = value => encodingString(value, (_name, message) => new Error(message));
  const object = value => value !== null && (typeof value === 'object' || typeof value === 'function');
  const input = (markup, options, count) => {
    if (!count) throw new Error('An HTML string is required');
    markup = string(markup);
    if (options != null && !object(options)) throw new Error('Options must be a dictionary');
    const runScripts = Boolean(options?.runScripts), sanitizer = options?.sanitizer;
    if (runScripts || sanitizer !== undefined)
      throw new Exception('Sanitizer and script-executing HTML parsing options are not implemented', 'NotSupportedError');
    return markup;
  };
  for (const [prototype, shadow] of [[elementPrototype,false],[shadowPrototype,true]]) {
    const setHTMLUnsafe = {setHTMLUnsafe(markup, options) {
      const node = nodeOf(this);
      if (shadow ? !node?.host || node.nodeType !== 11 : node?.nodeType !== 1) throw new Error('Illegal invocation');
      markup = input(markup, options, arguments.length);
      const owner = realmOf(this), context = shadow ? node.host : node;
      const target = !shadow && node.namespaceURI === 'http://www.w3.org/1999/xhtml' && node.localName === 'template' ? node.content : node;
      withCustomElementReactions(() => {
        const fragment = parseMarkupFragment(context, markup, {declarative:true});
        replaceAllNodes(target, fragment);
      });
      // Observe newly attached roots as well as the replaced light children;
      // closed roots remain visible only to the renderer's internal hooks.
      const pending = [target];
      while (pending.length) {
        const current = pending.pop(), root = current[nativeShadowRoot];
        if (root) { owner.hooks.shadowAttached?.(root); pending.push(root); }
        for (const child of current.childNodes) pending.push(child);
      }
      owner.hooks.touch(target);
    }}.setHTMLUnsafe;
    Object.defineProperty(prototype,'setHTMLUnsafe',{value:setHTMLUnsafe,writable:true,enumerable:true,configurable:true});
  }
  const parseHTMLUnsafe = {parseHTMLUnsafe(markup, options) {
    return realm.wrap(parseDocument(input(markup, options, arguments.length)));
  }}.parseHTMLUnsafe;
  Object.defineProperty(Document,'parseHTMLUnsafe',{value:parseHTMLUnsafe,writable:true,enumerable:true,configurable:true});
  for (const [name, attribute, boolean] of [
    ['shadowRootMode','shadowrootmode',false], ['shadowRootDelegatesFocus','shadowrootdelegatesfocus',true],
    ['shadowRootClonable','shadowrootclonable',true], ['shadowRootSerializable','shadowrootserializable',true],
    ['shadowRootSlotAssignment','shadowrootslotassignment',false],
  ]) {
    const receiver = self => {
      const node = nodeOf(self);
      if (node?.namespaceURI !== 'http://www.w3.org/1999/xhtml' || node.localName !== 'template') throw new Error('Illegal invocation');
      return node;
    };
    Object.defineProperty(templatePrototype,name,{enumerable:true,configurable:true,
      get() {
        const node = receiver(this);
        if (boolean) return node.hasAttribute(attribute);
        const value = (node.getAttribute(attribute) ?? '').replace(/[A-Z]/g, c => c.toLowerCase());
        if (name === 'shadowRootSlotAssignment') return value === 'manual' ? 'manual' : 'named';
        return value === 'open' || value === 'closed' ? value : '';
      },
      set(value) {
        const node = receiver(this);
        if (boolean) { if (value) node.setAttribute(attribute,''); else node.removeAttribute(attribute); }
        else node.setAttribute(attribute,string(value));
        realmOf(this).hooks.touch(node);
      },
    });
  }
}

class DocumentTypeBinding extends NodeBinding {
  get name() { return nodeOf(this).name; }
  get publicId() { return nodeOf(this).publicId; }
  get systemId() { return nodeOf(this).systemId; }
}

// Attr is a Node with stable identity, including while detached or moved to
// another owner. Its value setters share the DOM's attribute-change hooks.
class AttrBinding extends NodeBinding {
  get name() { return nodeOf(this).name; }
  get localName() { return nodeOf(this).localName; }
  get namespaceURI() { return nodeOf(this).namespaceURI; }
  get prefix() { return nodeOf(this).prefix; }
  get specified() { return true; }
  get ownerElement() { return realmOf(this).wrap(nodeOf(this).ownerElement); }
  get value() { return nodeOf(this).value ?? ''; }
  set value(value) { setAttrValue(this, domString(value)); }
}

function setAttrValue(wrapper, value) {
  const attribute = nodeOf(wrapper), owner = attribute.ownerElement;
  attribute.value = value;
  if (owner) attributeChanged(realmOf(wrapper).wrap(owner), attribute);
}

function attributeChanged(owner, attribute) {
  const element = nodeOf(owner), realm = realmOf(owner);
  if (!attribute) { touch(owner); return; }
  if (isCanvasSizeAttribute(element, attribute.localName, attribute.namespaceURI)) resetCanvas(element);
  // CSSOM pending shorthand identity can change even when style text does
  // not. Keep an explicit style feature alongside the attribute record.
  touch(owner, !attribute.namespaceURI && attribute.localName === 'style' ? ['[style'] : [], 'attributes');
  if (!attribute.namespaceURI && attribute.localName === 'src' && isMedia(owner)) realm.hooks.attachMediaSrc?.(element, element.src);
}

function requireAttr(value) {
  const attribute = nodeOf(value);
  if (attribute?.nodeType !== 2) throw new TypeError("parameter is not of type 'Attr'");
  return attribute;
}

class TextBinding extends CharacterDataBinding {
  get assignedSlot() { return realmOf(this).wrap(assignedSlot(nodeOf(this), true)); }
  get wholeText() { return nodeOf(this).wholeText; }
  splitText(offset) {
    if (!arguments.length) throw new TypeError("splitText requires an argument");
    offset = +offset >>> 0;
    const node = nodeOf(this);
    if (offset > node.data.length) throw new DOMException("Offset exceeds data length", "IndexSizeError");
    const next = node.splitText(offset);
    touch(this, [], 'characterData');
    return realmOf(this).wrap(next);
  }
}

/** Methods shared by elements, documents and fragments (ParentNode). */
class ParentBinding extends NodeBinding {
  get children() {
    return realmOf(this).live(nodeOf(this).children);
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
    return realmOf(this).wrap(selectorQuery(this, "querySelector", arguments));
  }

  querySelectorAll(selector) {
    return realmOf(this).staticList(selectorQuery(this, "querySelectorAll", arguments));
  }

  getElementsByTagName(name) {
    return realmOf(this).live(nodeOf(this).getElementsByTagName(String(name)));
  }

  getElementsByTagNameNS(namespace, localName) {
    return realmOf(this).live(nodeOf(this).getElementsByTagNameNS(namespace === undefined ? null : namespace, String(localName)));
  }

  getElementsByClassName(names) {
    return realmOf(this).live(nodeOf(this).getElementsByClassName(String(names)));
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
    return realmOf(this).wrap(elementById(nodeOf(this), domString(id)));
  }
}

/**
 * The renderer draws shadow trees through the composed tree; closed roots
 * remain accessible to the engine without exposing them to page scripts.
 */
class ShadowRootBinding extends FragmentBinding {
  get host() {
    return realmOf(this).wrap(nodeOf(this).host);
  }

  get mode() {
    return nodeOf(this).mode;
  }

  get delegatesFocus() { return nodeOf(this).delegatesFocus; }
  get slotAssignment() { return nodeOf(this).slotAssignment; }
  get clonable() { return nodeOf(this).clonable; }
  get serializable() { return nodeOf(this).serializable; }

  get innerHTML() {
    return nodeOf(this).innerHTML;
  }

  set innerHTML(value) {
    nodeOf(this).innerHTML = String(value);
    touch(this, [], 'childList');
  }
}

class ElementBinding extends ParentBinding {
  get contentEditable() { return contentEditable(nodeOf(this)); }
  set contentEditable(value) {
    setContentEditable(nodeOf(this), value);
    realmOf(this).hooks.touch(nodeOf(this));
  }
  get isContentEditable() { return isContentEditable(nodeOf(this)); }
  #style = null;
  #classList = null;
  #dataset = null;
  #attributes = null;
  #validity = null;
  #clickInProgress = false;

  get tagName() {
    return elementTagName(nodeOf(this));
  }

  attachShadow(init) {
    const realm = realmOf(this), node = nodeOf(this);
    const {TypeError: Error, DOMException: Exception} = realm.inputValueIntrinsics;
    const string = value => encodingString(value, (_name, message) => new Error(message));
    if (!arguments.length || init == null || !['object','function'].includes(typeof init)) throw new Error('Shadow root options are required');
    const clonable = Boolean(init.clonable), delegateFocus = Boolean(init.delegatesFocus);
    const modeValue = init.mode;
    if (modeValue === undefined) throw new Error('Shadow root mode is required');
    const mode = string(modeValue);
    if (mode !== "open" && mode !== "closed") throw new Error("Shadow root mode must be open or closed");
    const serializable = Boolean(init.serializable), slotValue = init.slotAssignment;
    const slotAssignment = slotValue === undefined ? 'named' : string(slotValue);
    if (slotAssignment !== "named" && slotAssignment !== "manual") throw new Error("Invalid slot assignment mode");
    // Happy DOM spells this internal option delegateFocus (without the s).
    let root;
    try { root = node.attachShadow({mode,slotAssignment,delegateFocus,clonable,serializable}); }
    catch (error) {
      if (error instanceof DOMException || error instanceof NativeDOMException) throw new Exception(error.message,error.name);
      throw error;
    }
    realm.hooks.shadowAttached?.(root);
    touch(this, [], 'shadow');
    return realm.wrap(root);
  }

  get shadowRoot() {
    return realmOf(this).wrap(nodeOf(this).shadowRoot);
  }

  get assignedSlot() { return realmOf(this).wrap(assignedSlot(nodeOf(this), true)); }

  get slot() { return nodeOf(this).getAttributeNS(null, "slot") ?? ""; }
  set slot(value) { this.setAttributeNS(null, "slot", domString(value)); }

  assignedNodes(options = {}) {
    const realm = realmOf(this);
    return slotAssignedNodes(nodeOf(this), Boolean(options?.flatten)).map(node => realm.wrap(node));
  }

  assignedElements(options = {}) {
    const realm = realmOf(this);
    return slotAssignedNodes(nodeOf(this), Boolean(options?.flatten)).filter(node => node.nodeType === 1).map(node => realm.wrap(node));
  }

  assign(...nodes) {
    const realm = realmOf(this);
    assignSlotNodes(nodeOf(this), nodes.map(node => nodeOf(node)), slot => {
      signalSlotChange(slot);
      // Assignment can also remove nodes from an old connected manual slot,
      // even when the receiving slot is detached. Preserve both invalidations.
      realm.hooks.touch(slot);
    });
    touch(this);
  }

  // HTMLIFrameElement: its document's window and, when same-origin, its
  // document (see messaging.js).
  get contentWindow() {
    const node = nodeOf(this);
    return node.tagName === "IFRAME" ? realmOf(this).hooks.contentWindow?.(node) ?? null : undefined;
  }

  get contentDocument() {
    const node = nodeOf(this);
    return node.tagName === "IFRAME" ? realmOf(this).hooks.contentDocument?.(node) ?? null : undefined;
  }

  // One property for two interfaces: HTMLTemplateElement.content (read-only,
  // the template's fragment) and HTMLMetaElement.content (the reflected
  // attribute, which scripts set). Other elements have none: an assignment
  // stays on the wrapper as a plain property.
  get content() {
    const node = nodeOf(this);
    if (node.tagName === "META") return node.getAttribute("content") ?? "";
    const content = node.content;
    return content === undefined ? undefined : realmOf(this).wrap(content);
  }

  set content(value) {
    const node = nodeOf(this);
    if (node.tagName === "META") {
      node.setAttribute("content", String(value));
      touch(this);
    } else if (node.tagName !== "TEMPLATE") {
      Object.defineProperty(this, "content", { value, writable: true, enumerable: true, configurable: true });
    }
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

  /** Restarts loading (HTML §4.8.11.5): playback stops and starts again from the beginning when played. */
  load() {
    if (!isMedia(this)) return;
    realmOf(this).hooks.pauseMedia?.(nodeOf(this));
    realmOf(this).hooks.reselectMedia?.(nodeOf(this));
    void realmOf(this).hooks.seekMedia?.(nodeOf(this), 0);
  }

  canPlayType(type) {
    if (!isMedia(this)) return undefined;
    // File playback covers all bundled CPU codecs; MSE keeps a separate,
    // narrower policy for the containers its append parser understands.
    return mediaFileTypeSupported(type) ? "maybe" : "";
  }

  get localName() {
    return nodeOf(this).localName;
  }

  get namespaceURI() { return nodeOf(this).namespaceURI; }
  get prefix() { return nodeOf(this).prefix; }

  get id() {
    return nodeOf(this).id;
  }

  set id(value) {
    const node = nodeOf(this);
    node.id = domString(value);
    touch(this, [], 'attributes');
  }

  get className() {
    return nodeOf(this).className;
  }

  set className(value) {
    const node = nodeOf(this);
    node.className = domString(value);
    touch(this, [], 'attributes');
  }

  get classList() {
    const target = indexedBindings.get(this) ?? this;
    if (!target.#classList) {
      const realm=realmOf(this);
      target.#classList=new ClassListBinding(CONSTRUCT,nodeOf(this),realm);
      if(realm.tokenListPrototype)Object.setPrototypeOf(target.#classList,realm.tokenListPrototype);
    }
    return target.#classList;
  }

  set classList(value) {
    this.classList.value = value;
  }

  get style() {
    // Indexed elements retain their public proxy receiver; private slots live
    // on its backing binding, while author accessors still see the proxy.
    const target = indexedBindings.get(this) ?? this;
    target.#style ??= styleBinding(nodeOf(this), realmOf(this));
    return target.#style;
  }

  // ElementCSSInlineStyle is [PutForwards=cssText], not assignment-readonly.
  set style(value) {
    this.style.cssText = value;
  }

  get dataset() {
    const target = indexedBindings.get(this) ?? this;
    target.#dataset ??= datasetBinding(nodeOf(this), realmOf(this));
    return target.#dataset;
  }

  get attributes() {
    const target = indexedBindings.get(this) ?? this;
    target.#attributes ??= attributesBinding(this);
    return target.#attributes;
  }

  getAttribute(name) {
    if (!arguments.length) throw new TypeError('getAttribute requires a name');
    return nodeOf(this).getAttribute(domString(name));
  }

  getAttributeNodeNS(namespace, localName) {
    if (arguments.length < 2) throw new TypeError('getAttributeNodeNS requires two arguments');
    return realmOf(this).wrap(nodeOf(this).getAttributeNodeNS(namespace == null ? null : domString(namespace), domString(localName)));
  }

  // CSSOM View §6.1: false when the element or an ancestor has no box or is
  // visibility: hidden (with the visibilityProperty option).
  checkVisibility(options = undefined) {
    const realm = realmOf(this);
    const node = nodeOf(this);
    if (!node.isConnected) return false;
    // display:contents has no box of its own; its descendants still can.
    if (realm.hooks.computedStyle?.(node)?.display === "contents") return false;
    const checkOpacity = Boolean(options?.opacityProperty || options?.checkOpacity);
    for (let element = node; element; element = element.parentElement) {
      const style = realm.hooks.computedStyle?.(element);
      if (style?.display === "none" || (checkOpacity && style?.opacity === 0)) return false;
    }
    if ((options?.visibilityProperty || options?.checkVisibilityCSS)
      && ["hidden", "collapse"].includes(realm.hooks.computedStyle?.(node)?.visibility)) return false;
    return true;
  }

  // Web Animations: no animations run outside CSS transitions/animations.
  getAnimations() {
    return [];
  }

  // Pointer capture (Pointer Events §10): a pointer this element has captured.
  hasPointerCapture(_pointerId) {
    return false;
  }

  setPointerCapture(_pointerId) {}

  releasePointerCapture(_pointerId) {}

  getAttributeNode(name) {
    if (!arguments.length) throw new TypeError('getAttributeNode requires a name');
    return realmOf(this).wrap(nodeOf(this).getAttributeNode(domString(name)));
  }

  setAttributeNode(attribute) {
    const attr = requireAttr(attribute), element = nodeOf(this);
    const old = element.setAttributeNode(attr);
    if (old !== attr) attributeChanged(this, attr);
    return realmOf(this).wrap(old);
  }

  setAttributeNodeNS(attribute) {
    return ElementBinding.prototype.setAttributeNode.call(this, attribute);
  }

  removeAttributeNode(attribute) {
    const attr = requireAttr(attribute), element = nodeOf(this);
    if ((attr.ownerElement?.[nodeProxy] ?? attr.ownerElement) !== element) throw new DOMException('Attribute does not belong to this element', 'NotFoundError');
    element.removeAttributeNode(attr);
    attributeChanged(this, attr);
    return realmOf(this).wrap(attr);
  }

  setAttribute(name, value) {
    if (arguments.length < 2) throw new TypeError('setAttribute requires two arguments');
    const node = nodeOf(this);
    const attribute = domString(name);
    const next = domString(value);
    // Even an unchanged value runs attribute-change steps (observers and
    // custom-element reactions). The DOM retains the existing Attr node.
    node.setAttribute(attribute, next);
    attributeChanged(this, node.getAttributeNode(attribute));
  }

  removeAttribute(name) {
    if (!arguments.length) throw new TypeError('removeAttribute requires a name');
    const node = nodeOf(this);
    const nameString = domString(name), attribute = node.getAttributeNode(nameString);
    if (attribute) {
      node.removeAttribute(nameString);
      attributeChanged(this, attribute);
    }
  }

  hasAttribute(name) {
    if (!arguments.length) throw new TypeError('hasAttribute requires a name');
    return nodeOf(this).hasAttribute(domString(name));
  }

  hasAttributes() {
    return nodeOf(this).getAttributeNames().length > 0;
  }

  // Namespaced attributes (DOM §4.9): xlink:href and friends in SVG.
  getAttributeNS(namespace, localName) {
    if (arguments.length < 2) throw new TypeError('getAttributeNS requires two arguments');
    return nodeOf(this).getAttributeNS(namespace == null ? null : domString(namespace), domString(localName));
  }

  hasAttributeNS(namespace, localName) {
    if (arguments.length < 2) throw new TypeError('hasAttributeNS requires two arguments');
    return nodeOf(this).hasAttributeNS(namespace == null ? null : domString(namespace), domString(localName));
  }

  setAttributeNS(namespace, qualifiedName, value) {
    if (arguments.length < 3) throw new TypeError('setAttributeNS requires three arguments');
    const node = nodeOf(this), ns = namespace == null ? null : domString(namespace), name = domString(qualifiedName);
    node.setAttributeNS(ns, name, domString(value));
    attributeChanged(this, node.getAttributeNodeNS(ns, name.slice(name.indexOf(':') + 1)));
  }

  removeAttributeNS(namespace, localName) {
    if (arguments.length < 2) throw new TypeError('removeAttributeNS requires two arguments');
    const node = nodeOf(this), ns = namespace == null ? null : domString(namespace), name = domString(localName);
    const attribute = node.getAttributeNodeNS(ns, name);
    if (attribute) {
      node.removeAttributeNS(ns, name);
      attributeChanged(this, attribute);
    }
  }

  toggleAttribute(name, force = undefined) {
    if (!arguments.length) throw new TypeError('toggleAttribute requires a name');
    const node = nodeOf(this), attributeName = domString(name);
    const attribute = node.getAttributeNode(attributeName);
    const result = node.toggleAttribute(attributeName, force === undefined ? undefined : Boolean(force));
    if (Boolean(attribute) !== result) attributeChanged(this, attribute ?? node.getAttributeNode(attributeName));
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
    touch(this, [], 'childList');
  }

  get outerHTML() {
    return nodeOf(this).outerHTML;
  }

  get innerText() {
    const node = nodeOf(this);
    const realm = realmOf(this);
    return node.ownerDocument !== realm.window.document ? node.textContent : renderedText(node, realm.hooks.computedStyle);
  }

  set innerText(value) {
    setRenderedText(nodeOf(this), value);
    touch(this, [], 'childList');
  }

  insertAdjacentHTML(position, html) {
    nodeOf(this).insertAdjacentHTML(String(position), String(html));
    touch(this, [], 'childList');
  }

  insertAdjacentText(position, text) {
    nodeOf(this).insertAdjacentText(String(position), String(text));
    touch(this, [], 'childList');
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
    return realmOf(this).wrap(selectorQuery(this, "closest", arguments));
  }

  matches(selector) {
    return selectorQuery(this, "matches", arguments);
  }


  remove() {
    const node = nodeOf(this);
    node.parentNode?.removeChild(node);
    touch(this, [], 'childList');
  }

  before(...values) {
    const nodes = values.map((value) => toNode(this, value));
    const list = insertionList(nodes);
    insertAdjacentNodes(nodeOf(this), nodes, false);
    inserted(this, list);
  }

  after(...values) {
    const nodes = values.map((value) => toNode(this, value));
    const list = insertionList(nodes);
    insertAdjacentNodes(nodeOf(this), nodes, true);
    inserted(this, list);
  }

  replaceWith(...values) {
    const nodes = values.map((value) => toNode(this, value));
    const list = insertionList(nodes);
    replaceWithNodes(nodeOf(this), nodes);
    inserted(this, list);
  }

  get files(){const files=inputFiles(nodeOf(this));if(files&&realmOf(this).fileInterface)for(const file of files)realmOf(this).fileInterface.exposeFile(file);return files;}
  showPicker(){const e=nodeOf(this);if(actuallyDisabled(e))throw new DOMException('The input is disabled','InvalidStateError');
    const hooks=realmOf(this).hooks;
    if(!hooks.consumeUserActivation?.())throw new DOMException('showPicker requires transient user activation','NotAllowedError');
    hooks.pickFile?.(e);
  }
  click() {
    const realm = realmOf(this);
    const element = nodeOf(this);
    const target = indexedBindings.get(this) ?? this;
    if (target.#clickInProgress || element.matches(":disabled")) return;
    const anchor = element.closest?.("a[href]");
    const Event = realm.window.PointerEvent ?? realm.window.MouseEvent;
    const event = new Event("click", { bubbles: true, cancelable: true, composed: true });
    const activationState = realm.hooks.activationState?.(element);
    target.#clickInProgress = true;
    try {
      element.dispatchEvent(event);
      if (!event.defaultPrevented) realm.hooks.pickFile?.(element);
      if (!event.defaultPrevented && anchor?.hasAttribute("href")) realm.hooks.activateLink?.(anchor);
    } finally {
      target.#clickInProgress = false;
      realm.hooks.activationChanged?.(activationState);
    }
  }

  submit() {
    const form = nodeOf(this);
    if (form.tagName === "FORM") realmOf(this).hooks.submitForm?.(form);
  }

  reset() {
    const realm = realmOf(this), form = nodeOf(this);
    if (form.namespaceURI !== 'http://www.w3.org/1999/xhtml' || form.localName !== 'form') throw new TypeError('Illegal invocation');
    const previous = realm.hooks.activationState?.(form);
    try { form.reset(); }
    finally { if (previous) realm.hooks.activationChanged?.(previous); }
  }

  requestSubmit(submitter) {
    const realm = realmOf(this);
    const form = nodeOf(this);
    if (form.tagName !== "FORM") return;
    const realSubmitter = submitter == null ? null : nodeOf(submitter);
    if (realSubmitter && !((realSubmitter.tagName === "BUTTON" && realSubmitter.type === "submit")
      || (realSubmitter.tagName === "INPUT" && ["submit", "image"].includes(realSubmitter.type)))) {
      throw new TypeError("The submitter must be a submit button");
    }
    if (realSubmitter && realSubmitter.form !== form) throw new DOMException("Submitter is not owned by this form", "NotFoundError");
    if (!form.noValidate && !realSubmitter?.formNoValidate && !form.checkValidity()) return;
    const event = new realm.window.SubmitEvent("submit", {
      bubbles: true, cancelable: true, submitter: realSubmitter,
    });
    form.dispatchEvent(event);
    if (!event.defaultPrevented) realm.hooks.submitForm?.(form, realSubmitter);
  }

  get validity() {
    const target = indexedBindings.get(this) ?? this;
    return target.#validity ??= realmOf(this).wrapValidity(nodeOf(this).validity);
  }

  setSelectionRange(start, end, direction = 'none') {
    if(arguments.length<2)throw new TypeError('setSelectionRange requires start and end');
    nodeOf(this).setSelectionRange(Number(start),Number(end),String(direction));touch(this);
  }
  setRangeText(replacement, ...args) {
    if(!arguments.length)throw new TypeError('setRangeText requires replacement');
    nodeOf(this).setRangeText(String(replacement),...args.map((v,i)=>i<2?Number(v):String(v)));touch(this);
  }
  select() {const node=nodeOf(this);node.focus();node.select();touch(this);}

  setCustomValidity(message) {
    if (!arguments.length) throw new TypeError("setCustomValidity requires a message");
    nodeOf(this).setCustomValidity(String(message));
    touch(this, [":state"]);
  }

  checkValidity() { return nodeOf(this).checkValidity(); }
  reportValidity() { return nodeOf(this).reportValidity(); }

  focus() {
    const node = nodeOf(this);
    const previous = node.ownerDocument.activeElement;
    node.focus();
    if (node.ownerDocument.activeElement !== previous) touch(this, [":focus", ":focus-visible"]);
  }

  blur() {
    const node = nodeOf(this);
    const previous = node.ownerDocument.activeElement;
    node.blur();
    if (node.ownerDocument.activeElement !== previous) touch(this, [":focus", ":focus-visible"]);
  }

  get draggable() { return isDraggable(nodeOf(this)); }
  set draggable(value) { nodeOf(this).setAttribute('draggable',Boolean(value) ? 'true' : 'false'); touch(this); }

  getBoundingClientRect() {
    const rect = realmOf(this).hooks.boundsOf(nodeOf(this)) ?? { left: 0, top: 0, width: 0, height: 0 };
    return domRect(rect);
  }

  getClientRects() {
    const realm = realmOf(this), node = nodeOf(this);
    if (!node.isConnected || realm.hooks.computedStyle?.(node)?.display === "contents") return [];
    const rect = realm.hooks.boundsOf(node);
    return rect ? [domRect(rect)] : [];
  }

  get offsetWidth() {
    return Math.round(this.getBoundingClientRect().width);
  }

  get offsetHeight() {
    return Math.round(this.getBoundingClientRect().height);
  }

  /**
   * CSSOM View §7: the nearest ancestor that is positioned (or that
   * contains absolutely positioned boxes, as a transformed one does), or a
   * td, th or table for an element that is not positioned itself, else the
   * body. Null for the root, the body, fixed boxes and elements without a box.
   */
  get offsetParent() {
    const realm = realmOf(this);
    const node = nodeOf(this);
    const document = node.ownerDocument;
    if (!node.isConnected || node === document?.documentElement || node === document?.body) return null;
    const style = realm.hooks.computedStyle?.(node);
    if (!style || style.display === "none" || style.position === "fixed") return null;
    const positioned = style.position !== "static";
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor === document.body) return realm.wrap(ancestor);
      const ancestorStyle = realm.hooks.computedStyle?.(ancestor);
      if (ancestorStyle?.display === "none") return null;
      if (ancestorStyle && (ancestorStyle.position !== "static" || ancestorStyle.transform)) return realm.wrap(ancestor);
      if (!positioned && (ancestor.tagName === "TD" || ancestor.tagName === "TH" || ancestor.tagName === "TABLE")) {
        return realm.wrap(ancestor);
      }
    }
    return null;
  }

  // The border edge's distance from the offsetParent's padding edge, or
  // from the document's origin when that is the body or there is none.
  get offsetLeft() {
    return offsetCoordinate(this, "left");
  }

  get offsetTop() {
    return offsetCoordinate(this, "top");
  }

  // CSSOM View client metrics use untransformed padding boxes, unlike rects.
  get clientWidth() { return clientMetric(this, "width"); }
  get clientHeight() { return clientMetric(this, "height"); }
  get clientTop() { return clientMetric(this, "top"); }
  get clientLeft() { return clientMetric(this, "left"); }

  // Scroll positions (CSSOM View §6): a scroll container's own; the root
  // element and body stand for the viewport's.
  get scrollTop() {
    if (scrollsViewport(this)) return realmOf(this).hooks.viewport().scrollY;
    return elementScroll(this)?.y ?? 0;
  }

  set scrollTop(value) {
    this.scrollTo(this.scrollLeft, Number(value));
  }

  get scrollLeft() {
    if (scrollsViewport(this)) return realmOf(this).hooks.viewport().scrollX;
    return elementScroll(this)?.x ?? 0;
  }

  set scrollLeft(value) {
    this.scrollTo(Number(value), this.scrollTop);
  }

  scrollTo(x = undefined, y = undefined) {
    const options = typeof x === "object" && x !== null ? x : null;
    const left = options ? options.left ?? this.scrollLeft : Number(x);
    const top = options ? options.top ?? this.scrollTop : Number(y);
    const realm = realmOf(this);
    if (scrollsViewport(this)) realm.hooks.scrollTo(Number.isFinite(left) ? left : 0, Number.isFinite(top) ? top : 0);
    else realm.hooks.setElementScroll?.(nodeOf(this), Number.isFinite(left) ? left : 0, Number.isFinite(top) ? top : 0);
  }

  scroll(x = undefined, y = undefined) {
    this.scrollTo(x, y);
  }

  scrollBy(x = undefined, y = undefined) {
    const options = typeof x === "object" && x !== null ? x : null;
    const dx = Number(options ? options.left ?? 0 : x) || 0;
    const dy = Number(options ? options.top ?? 0 : y) || 0;
    this.scrollTo(this.scrollLeft + dx, this.scrollTop + dy);
  }

  // Forms, tables and selects (undefined on other elements, as in browsers).
  get elements() {
    const node = nodeOf(this);
    return node.tagName === "FORM" ? realmOf(this).live(node.elements) : undefined;
  }

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
    const node = nodeOf(this);
    return node.localName === 'select' ? realmOf(this).selectOptions(node) : realmOf(this).live(node.options);
  }

  get selectedOptions() {
    const options = nodeOf(this).localName === "select" ? nodeOf(this).selectedOptions : undefined;
    return options === undefined ? undefined : realmOf(this).live(options);
  }

  get length() { return nodeOf(this).options.length; }
  set length(value) { realmOf(this).optionsCollections.setLength(nodeOf(this), value); }

  add(element, before = null) { realmOf(this).optionsCollections.add(nodeOf(this), element, before, arguments.length); }
  item(index) { return realmOf(this).optionsCollections.item(nodeOf(this), index, arguments.length); }
  namedItem(name) { return realmOf(this).optionsCollections.namedItem(nodeOf(this), name, arguments.length); }

  get selectedIndex() {
    return nodeOf(this).selectedIndex;
  }

  set selectedIndex(value) {
    if (nodeOf(this).localName !== "select") return;
    realmOf(this).optionsCollections.setSelectedIndex(nodeOf(this), value);
  }

  // A scroll container's scroll size is how far its content reaches; other
  // boxes' is their own size; the root element spans at least the viewport.
  get scrollWidth() {
    const scroller = elementScroll(this);
    if (scroller) return Math.round(scroller.scrollWidth);
    const root = nodeOf(this) === nodeOf(this).ownerDocument?.documentElement;
    return Math.max(this.offsetWidth, root ? realmOf(this).hooks.viewport().width : 0);
  }

  get scrollHeight() {
    const scroller = elementScroll(this);
    if (scroller) return Math.round(scroller.scrollHeight);
    const root = nodeOf(this) === nodeOf(this).ownerDocument?.documentElement;
    return Math.max(this.offsetHeight, root ? realmOf(this).hooks.viewport().height : 0);
  }

  scrollIntoView(options = undefined) {
    const realm = realmOf(this);
    const normalized = scrollIntoViewOptions(options);
    if (realm.hooks.scrollIntoView) {
      realm.hooks.scrollIntoView(nodeOf(this), normalized);
      return;
    }
    const rect = this.getBoundingClientRect();
    const { scrollX, scrollY, width, height } = realm.hooks.viewport();
    realm.hooks.scrollTo(scrollX + scrollAlignmentDelta(rect.left, rect.width, width, normalized.inline),
      scrollY + scrollAlignmentDelta(rect.top, rect.height, height, normalized.block));
  }
}

/** A scroll container's scroll state, or null (see the renderer's scrollerGeometry). */
function offsetCoordinate(wrapper, side) {
  const realm = realmOf(wrapper);
  const node = nodeOf(wrapper);
  // CSSOM View §7: the body's offsets are zero.
  if (node === node.ownerDocument?.body) return 0;
  const rect = realm.hooks.boundsOf(node);
  if (!rect) return 0;
  const { scrollX, scrollY } = realm.hooks.viewport();
  const own = side === "left" ? rect.left + scrollX : rect.top + scrollY;
  const parent = wrapper.offsetParent;
  if (!parent || nodeOf(parent) === node.ownerDocument?.body) return Math.round(own);
  const parentNode = nodeOf(parent);
  const parentRect = realm.hooks.boundsOf(parentNode);
  if (!parentRect) return Math.round(own);
  const border = realm.hooks.computedStyle?.(parentNode)?.borderWidths?.[side === "left" ? 3 : 0] ?? 0;
  // A box scrolled inside its offsetParent keeps its layout offset.
  const scrolled = elementScroll(parent);
  const scroll = side === "left" ? scrolled?.x ?? 0 : scrolled?.y ?? 0;
  const origin = (side === "left" ? parentRect.left + scrollX : parentRect.top + scrollY) + border;
  return Math.round(own - origin + scroll);
}

function elementScroll(wrapper) {
  return realmOf(wrapper).hooks.elementScroll?.(nodeOf(wrapper)) ?? null;
}

function clientMetric(wrapper, name) {
  const realm = realmOf(wrapper), node = nodeOf(wrapper);
  if (!node.isConnected || node.ownerDocument !== realm.window.document) return 0;
  return Math.round(realm.hooks.clientMetrics?.(node)?.[name] ?? 0);
}

/** The root element and body scroll the viewport (CSSOM View §6, the scrolling element). */
function scrollsViewport(wrapper) {
  const node = nodeOf(wrapper);
  const document = node.ownerDocument;
  return node === document?.documentElement || node === document?.body;
}

function isMedia(wrapper) {
  return wrapper.tagName === "VIDEO" || wrapper.tagName === "AUDIO";
}

/** on* event handler properties (element.onclick = fn, script.onload = fn). */
export const EVENT_HANDLER_NAMES = Object.freeze([
  "dragstart", "drag", "dragenter", "dragleave", "dragover", "drop", "dragend", "pointercancel",
  "click", "auxclick", "dblclick", "mousedown", "mouseup", "mousemove", "mouseover", "mouseout", "mouseenter", "mouseleave",
  "keydown", "keyup", "keypress", "beforeinput", "input", "change", "select", "submit", "formdata", "reset", "focus", "blur", "load", "error",
  "abort", "scroll", "resize", "wheel", "contextmenu", "touchstart", "touchend", "touchmove",
  "pointerdown", "pointerup", "pointermove", "animationend", "transitionend", "readystatechange", "slotchange", "toggle", "invalid",
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
      realmFor(this).hooks.prepareHandler?.(targetOf(this), type);
      return handlers.get(this)?.handler ?? null;
    },
    set(value) {
      const realm = realmFor(this);
      const target = targetOf(this);
      realm.hooks.prepareHandler?.(target, type);
      const previous = handlers.get(this);
      const callback = (event) => {
        if (realm.hooks.acceptEvent && !realm.hooks.acceptEvent(event)) return;
        const result = realm.hooks.call(value, this, [realm.wrapEvent(event)]);
        if (result === false) event.preventDefault();
      };
      if (previous && typeof value === 'function') {
        // HTML replaces the callback without reordering its event listener.
        // Capture the replacement script's error source again: retaining the
        // old capture could expose errors from a cross-origin classic script.
        previous.invoke = realm.hooks.captureCallback?.(callback) ?? callback;
        previous.handler = value;
        return;
      }
      if (previous) target.removeEventListener(type, previous.listener);
      handlers.delete(this);
      if (typeof value !== "function") return;
      const entry = {handler:value, invoke:realm.hooks.captureCallback?.(callback) ?? callback};
      const listener = event => entry.invoke(event);
      entry.listener = listener;
      handlers.set(this, entry);
      target.addEventListener(type, listener);
    },
  });
}

for (const type of EVENT_HANDLER_NAMES) {
  defineEventHandlerProperty(ElementBinding.prototype, type, (wrapper) => nodeOf(wrapper), (wrapper) => realmOf(wrapper));
}

export function installCDATAFactory(prototype, realm) {
  const methods = {createCDATASection(data) {
    const document = nodeOf(this), intrinsics = realm.inputValueIntrinsics;
    if (document?.nodeType !== 9) throw new intrinsics.TypeError('Illegal invocation');
    if (!arguments.length) throw new intrinsics.TypeError('createCDATASection requires an argument');
    data = encodingString(data, (_name, message) => new intrinsics.TypeError(message));
    return realmOf(this).wrap(createCDATASection(document, data, intrinsics.DOMException));
  }};
  Object.defineProperty(prototype, 'createCDATASection', Object.getOwnPropertyDescriptor(methods, 'createCDATASection'));
}

export function installDocumentTransferMethods(prototype, realm) {
  const receiver = self => {
    const node = nodeOf(self);
    if (node?.nodeType !== 9) throw new realm.inputValueIntrinsics.TypeError('Illegal invocation');
    return node;
  };
  const argument = value => {
    const node = nodeOf(value);
    if (!node) throw new realm.inputValueIntrinsics.TypeError('Parameter is not of type Node');
    return node;
  };
  const methods = {
    adoptNode(value) {
      const document = receiver(this), node = argument(value);
      const owner = node.nodeType === 2 ? node.ownerElement : null, parent = node.parentNode;
      const result = adoptNode(document, node, realm.inputValueIntrinsics);
      // Removal affects the source page, even when the destination is inert.
      const sourceRealm = realmOf(value);
      if (owner) attributeChanged(sourceRealm.wrap(owner), node);
      else if (parent) sourceRealm.hooks.touch(parent);
      return realmOf(this).wrap(result);
    },
    importNode(value, deep = false) {
      const document = receiver(this), node = argument(value);
      const options = typeof deep === 'object' && deep !== null ? Boolean(deep.deep) : Boolean(deep);
      return realmOf(this).wrap(importNode(document, node, options, realm.inputValueIntrinsics));
    },
  };
  Object.defineProperties(prototype, Object.getOwnPropertyDescriptors(methods));
}

export function installLabelAccessors(prototypes, realm) {
  const element = (self, tag) => {
    const node = nodeOf(self);
    if (!node || node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || node.localName !== tag)
      throw new realm.inputValueIntrinsics.TypeError('Illegal invocation');
    return node;
  };
  const label = {
    get control() { const node = element(this, 'label'); return realmOf(this).wrap(node.control); },
    get form() { const node = element(this, 'label'); return realmOf(this).wrap(node.form); },
  };
  Object.defineProperties(prototypes.get('HTMLLabelElement'), Object.getOwnPropertyDescriptors(label));
  for (const [name, tag] of [['HTMLInputElement', 'input'], ['HTMLButtonElement', 'button'],
    ['HTMLSelectElement', 'select'], ['HTMLTextAreaElement', 'textarea'], ['HTMLMeterElement', 'meter'],
    ['HTMLOutputElement', 'output'], ['HTMLProgressElement', 'progress']]) {
    const getter = {get labels() { const node = element(this, tag); return realmOf(this).live(labelCollectionQuery(node)); }};
    Object.defineProperty(prototypes.get(name), 'labels', Object.getOwnPropertyDescriptor(getter, 'labels'));
  }
}

export function installFormAccessors(prototypes, realm) {
  const element = (self, tag) => {
    const node = nodeOf(self);
    if (!node || node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || node.localName !== tag)
      throw new realm.inputValueIntrinsics.TypeError('Illegal invocation');
    return node;
  };
  for (const [name, tag] of [['HTMLInputElement','input'], ['HTMLButtonElement','button'],
    ['HTMLSelectElement','select'], ['HTMLTextAreaElement','textarea'], ['HTMLFieldSetElement','fieldset'],
    ['HTMLObjectElement','object'], ['HTMLOutputElement','output']]) {
    const getters = {get form() { const node = element(this, tag); return realmOf(this).wrap(node.form); }};
    Object.defineProperty(prototypes.get(name), 'form', Object.getOwnPropertyDescriptor(getters, 'form'));
  }
  for (const [name, tag] of [['HTMLFormElement','form'], ['HTMLFieldSetElement','fieldset']]) {
    const getters = {get elements() { const node = element(this, tag); return realmOf(this).formCollections.create(node); }};
    Object.defineProperty(prototypes.get(name), 'elements', Object.getOwnPropertyDescriptor(getters, 'elements'));
  }
}

export function installOptionValueAccessors(prototype, realm) {
  const option = self => {
    const element = nodeOf(self);
    if (!element || element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || element.localName !== 'option')
      throw new realm.inputValueIntrinsics.TypeError('Illegal invocation');
    return element;
  };
  for (const [name, getter] of [['text', optionText], ['label', optionLabel], ['value', optionValue]]) {
    Object.defineProperty(prototype, name, { configurable: true, enumerable: true,
      get() { return getter(option(this)); },
      set(value) {
        const element = option(this);
        value = encodingString(value, (_name, message) => new realm.inputValueIntrinsics.TypeError(message));
        if (name === 'text') element.textContent = value;
        else element.setAttributeNS(null, name, value);
        touch(this);
      },
    });
  }
}

export function installSelectSizeAccessor(prototype, realm) {
  const conversionRealm = { hooks: { pageGlobal: () => realm.inputValueIntrinsics } };
  const select = self => {
    const element = nodeOf(self);
    if (!element || element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || element.localName !== 'select')
      throw new realm.inputValueIntrinsics.TypeError('Illegal invocation');
    return element;
  };
  Object.defineProperty(prototype, 'size', { configurable: true, enumerable: true,
    get() { return select(this).size; },
    set(value) {
      const element = select(this);
      element.size = bindingNumber(value, conversionRealm, 'size') >>> 0;
      touch(this, [':state']);
    },
  });
}

export function installInputValueAccessors(prototype, realm) {
  // Capture the accessor's realm, not a borrowed receiver's realm. Generated
  // Date values/errors still belong to this page when called on another input.
  const conversionRealm = { hooks: { pageGlobal: () => realm.inputValueIntrinsics } };
  const input = self => {
    const element = nodeOf(self);
    if (!element || element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || element.localName !== 'input')
      throw new realm.inputValueIntrinsics.TypeError('Illegal invocation');
    return element;
  };
  const accessors = {
    get valueAsNumber() { return inputNumberValue(input(this)); },
    set valueAsNumber(value) {
      const element = input(this), number = bindingNumber(value, conversionRealm, 'valueAsNumber');
      setInputNumberValue(element, number, realm.inputValueIntrinsics);
      touch(this, [':state']);
    },
    get valueAsDate() {
      const element = input(this), timestamp = inputDateTimestamp(element.type, element.value);
      const DateConstructor = realm.inputValueIntrinsics.Date;
      return timestamp === null ? null : new DateConstructor(timestamp);
    },
    set valueAsDate(value) {
      setInputDateValue(input(this), value, realm.inputValueIntrinsics);
      touch(this, [':state']);
    },
    stepUp(n = 1) {
      const element = input(this), count = eventLong(n, conversionRealm, 'step count');
      if (stepInputValue(element, count, realm.inputValueIntrinsics)) touch(this, [':state']);
    },
    stepDown(n = 1) {
      const element = input(this), count = eventLong(n, conversionRealm, 'step count');
      if (stepInputValue(element, -count, realm.inputValueIntrinsics)) touch(this, [':state']);
    },
  };
  Object.defineProperties(prototype, Object.getOwnPropertyDescriptors(accessors));
}

export function installTextControlValueAccessors(prototypes, realm) {
  const string = value => encodingString(value, (_name, message) => new realm.inputValueIntrinsics.TypeError(message));
  for (const [name, tag] of [['HTMLInputElement', 'input'], ['HTMLTextAreaElement', 'textarea']]) {
    const element = self => {
      const node = nodeOf(self);
      if (!node || node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || node.localName !== tag)
        throw new realm.inputValueIntrinsics.TypeError('Illegal invocation');
      return node;
    };
    for (const property of ['value', 'defaultValue']) {
      Object.defineProperty(prototypes.get(name), property, { configurable: true, enumerable: true,
        get() {
          const node = element(this);
          if (property === 'value' && tag === 'input' && node.type === 'file') {
            const file = inputFiles(node)[0];
            return file ? 'C:\\fakepath\\' + file.name : '';
          }
          return node[property];
        },
        set(value) {
          const node = element(this);
          // Only value has LegacyNullToEmptyString. Converters may change the
          // input's type, so perform file-state validation after conversion.
          value = property === 'value' && value === null ? '' : string(value);
          if (property === 'value' && tag === 'input' && node.type === 'file' && value !== '')
            throw new realm.inputValueIntrinsics.DOMException('File input value can only be set to an empty string.', 'InvalidStateError');
          node[property] = value;
          touch(this, [':state']);
        },
      });
    }
  }
}

export function installTextSelectionAccessors(prototypes, realm) {
  const conversionRealm = { hooks: { pageGlobal: () => realm.inputValueIntrinsics } };
  const number = value => bindingNumber(value, conversionRealm, 'selection offset') >>> 0;
  const string = value => encodingString(value, (_name, message) => new realm.inputValueIntrinsics.TypeError(message));
  for (const [name, tag] of [['HTMLInputElement', 'input'], ['HTMLTextAreaElement', 'textarea']]) {
    const element = self => {
      const node = nodeOf(self);
      if (!node || node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || node.localName !== tag)
        throw new realm.inputValueIntrinsics.TypeError('Illegal invocation');
      return node;
    };
    const prototype = prototypes.get(name);
    for (const [property, field] of [['selectionStart', 'start'], ['selectionEnd', 'end'], ['selectionDirection', 'direction']]) {
      Object.defineProperty(prototype, property, { configurable: true, enumerable: true,
        get() { return textSelection(element(this), field); },
        set(value) {
          const node = element(this);
          value = field === 'direction' ? (tag === 'input' && value == null ? '' : string(value)) : number(value);
          setTextSelection(node, field, value, realm.inputValueIntrinsics);
          touch(this);
        },
      });
    }
    const methods = {
      setSelectionRange(start, end, direction = 'none') {
        const node = element(this);
        if (arguments.length < 2) throw new realm.inputValueIntrinsics.TypeError('setSelectionRange requires two arguments');
        start = number(start); end = number(end); direction = string(direction);
        setTextSelectionRange(node, start, end, direction, realm.inputValueIntrinsics);
        touch(this);
      },
      setRangeText(replacement, ...args) {
        const node = element(this);
        if (arguments.length === 0 || arguments.length === 2) throw new realm.inputValueIntrinsics.TypeError('Invalid setRangeText overload');
        replacement = string(replacement);
        let start, end, mode = 'preserve';
        if (args.length >= 2) {
          start = number(args[0]); end = number(args[1]);
          if (args[2] !== undefined) mode = string(args[2]);
          if (!['preserve', 'select', 'start', 'end'].includes(mode)) throw new realm.inputValueIntrinsics.TypeError('Invalid selection mode');
        }
        replaceTextSelection(node, replacement, start, end, mode, realm.inputValueIntrinsics);
        touch(this);
      },
      select() { selectTextControl(element(this)); touch(this); },
    };
    Object.defineProperties(prototype, Object.getOwnPropertyDescriptors(methods));
  }
}

// Reflected IDL attributes: values are coerced to primitives on the way in.
for (const property of REFLECTED_PROPERTIES) {
  Object.defineProperty(ElementBinding.prototype, property, {
    configurable: true,
    enumerable: true,
    get() {
      const node = nodeOf(this);
      const value = node[property];
      if (property === "value" && node.tagName === "INPUT" && node.type === "file") {
        const file = inputFiles(node)[0];
        return file ? "C:\\fakepath\\" + file.name : "";
      }
      if (typeof value === "string" && ["src", "href", "action", "poster"].includes(property)) {
        const attribute = node.getAttributeNS(null, property);
        if (property === "action" && !attribute) return node.ownerDocument.URL;
        if (attribute !== null) {
          try { return new URL(attribute, node.tagName === "BASE" ? node.ownerDocument.URL : documentBaseURL(node)).href; }
          catch { return attribute; }
        }
      }
      return value === null || typeof value !== "object" ? value : String(value);
    },
    set(value) {
      const node = nodeOf(this);
      node[property] = property === 'minLength' || property === 'maxLength' ? eventLong(value,realmOf(this),property)
        : typeof node[property] === "boolean" ? Boolean(value)
        : typeof node[property] === "number" ? Number(value)
          : String(value);
      if (property === 'title' && node.namespaceURI === 'http://www.w3.org/1999/xhtml')
        touch(this, [], 'attributes');
      else touch(this, [":state"]);
      // A media src may be a MediaSource blob URL. Attachment runs now so
      // sourceopen is queued after this setter returns.
      if (property === "src" && isMedia(this)) realmOf(this).hooks.attachMediaSrc?.(node, node.src);
    },
  });
}

// HTMLHyperlinkElementUtils: anchors and areas expose their parsed URL, not
// only the reflected href string. Happy DOM owns resolution against baseURI;
// bindings forward the primitive components without exposing the host node.
for (const property of ["origin", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "hash"]) {
  Object.defineProperty(ElementBinding.prototype, property, {
    configurable: true,
    enumerable: true,
    get() {
      const node = nodeOf(this);
      return node.tagName === "A" || node.tagName === "AREA" ? String(node[property] ?? "") : undefined;
    },
    set(value) {
      const node = nodeOf(this);
      if (node.tagName !== "A" && node.tagName !== "AREA") return;
      node[property] = String(value);
      touch(this);
    },
  });
}

class DocumentBinding extends ParentBinding {
  get designMode() { return designMode(nodeOf(this)); }
  set designMode(value) {
    setDesignMode(nodeOf(this), value);
    realmOf(this).hooks.touch(nodeOf(this));
  }
  #implementation = null;

  /**
   * document.implementation (DOM §4.5.1): documents scripts build off-screen
   * (template parsing, sanitizers, polyfills). They share this window and are
   * never rendered.
   */
  get implementation() {
    const realm = realmOf(this);
    const node = nodeOf(this);
    this.#implementation ??= Object.freeze({
      createHTMLDocument: (title = undefined) => {
        const created = createDetachedDocument(realm.window, { contentType: 'text/html', sourceDocument: node });
        const html = created.createElement("html");
        const head = created.createElement("head");
        const body = created.createElement("body");
        created.replaceChildren(created.implementation.createDocumentType("html", "", ""), html);
        html.append(head, body);
        if (title !== undefined) {
          const titleElement = created.createElement("title");
          titleElement.textContent = String(title);
          head.appendChild(titleElement);
        }
        return realm.wrap(created);
      },
      createDocument: (namespace, qualifiedName, doctype = null) => {
        const uri = namespace === null || namespace === undefined ? null : domString(namespace);
        const name = qualifiedName === null || qualifiedName === undefined ? "" : domString(qualifiedName);
        const created = createDetachedDocument(realm.window, {
          xmlDocument: true, sourceDocument: node,
          contentType: uri === "http://www.w3.org/1999/xhtml" ? "application/xhtml+xml"
            : uri === "http://www.w3.org/2000/svg" ? "image/svg+xml" : "application/xml",
        });
        if (doctype !== null) created.appendChild(requireNode(doctype));
        if (name) created.appendChild(created.createElementNS(uri, name));
        return realm.wrap(created);
      },
      createDocumentType: (qualifiedName, publicId, systemId) => realm.wrap(node.implementation.createDocumentType(
        String(qualifiedName), String(publicId), String(systemId))),
      hasFeature: () => true,
    });
    return this.#implementation;
  }

  get documentElement() {
    return realmOf(this).wrap(nodeOf(this).documentElement);
  }

  get doctype() { return realmOf(this).wrap(nodeOf(this).doctype); }

  get head() {
    return realmOf(this).wrap(nodeOf(this).head);
  }

  get body() {
    const realm = realmOf(this);
    const node = nodeOf(this);
    return realm.wrap(node === realm.window.document && realm.hooks.body ? realm.hooks.body() : node.body);
  }

  execCommand(command, _showUI = false, _value = null) {
    return Boolean(realmOf(this).hooks.execCommand?.(String(command).toLowerCase()));
  }

  queryCommandSupported(command) { return String(command).toLowerCase() === 'copy'; }
  queryCommandEnabled(command) {
    return this.queryCommandSupported(command) && Boolean(realmOf(this).hooks.copyEnabled?.());
  }

  get title() {
    return nodeOf(this).title;
  }

  set title(value) {
    nodeOf(this).title = String(value);
  }

  get readyState() {
    const realm = realmOf(this);
    return nodeOf(this) === realm.window.document ? realm.hooks.readyState?.() ?? "complete" : "complete";
  }

  // Page Visibility: the renderer only runs the page its client is showing.
  get visibilityState() {
    return "visible";
  }

  get hidden() {
    return false;
  }

  get URL() {
    return nodeOf(this).URL;
  }

  get documentURI() {
    return nodeOf(this).URL;
  }

  get referrer() { return nodeOf(this).referrer ?? ""; }

  get location() {
    const realm = realmOf(this);
    return nodeOf(this) === realm.window.document ? realm.hooks.pageGlobal?.()?.location ?? null : null;
  }

  get domain() {
    return new URL(documentOriginURL(nodeOf(this))).hostname;
  }

  get characterSet() {
    return documentEncoding(nodeOf(this));
  }
  get charset() { return this.characterSet; }
  get inputEncoding() { return this.characterSet; }

  get contentType() { return nodeOf(this).contentType; }

  get compatMode() {
    return "CSS1Compat";
  }

  /** Non-HttpOnly cookies from the controller's jar; writes go back to the jar. */
  get cookie() {
    const realm = realmOf(this);
    return nodeOf(this) === realm.window.document ? realm.hooks.documentCookie?.() ?? "" : "";
  }

  set cookie(value) {
    const realm = realmOf(this);
    if (nodeOf(this) === realm.window.document) realm.hooks.setDocumentCookie?.(String(value));
  }

  get activeElement() {
    return realmOf(this).wrap(nodeOf(this).activeElement);
  }

  /**
   * document.all is an HTMLAllCollection that is falsy and loosely equal to
   * undefined (HTML §7.2.6 [[IsHTMLDDA]]), which script cannot create. null
   * keeps what pages test, `!document.all`, `document.all == null` and
   * `value !== document.all` for undefined values (polymer_resin's check
   * before sanitizing); only typeof differs.
   */
  get all() {
    return null;
  }

  /**
   * document.styleSheets (CSSOM §6.2): one entry per <style> and loaded-or-not
   * <link rel=stylesheet>, in document order. Their rules are not exposed
   * (cssRules is empty), as for a sheet scripts may not read.
   */
  get styleSheets() {
    const realm = realmOf(this);
    const sheets = [...nodeOf(this).querySelectorAll("style, link[rel~='stylesheet']")].map((element) => {
      const href = element.tagName === "LINK" ? element.getAttribute("href") : null;
      let resolved = null;
      if (href !== null) try { resolved = new URL(href, element.baseURI || nodeOf(this).URL).href; } catch {}
      return Object.freeze({
        type: "text/css",
        href: resolved,
        title: element.getAttribute("title"),
        disabled: false,
        ownerNode: realm.wrap(element),
        media: Object.freeze({ mediaText: element.getAttribute("media") ?? "", length: element.hasAttribute("media") ? 1 : 0 }),
        cssRules: Object.freeze([]),
        rules: Object.freeze([]),
      });
    });
    const list = [...sheets];
    list.item = (index) => sheets[Number(index) >>> 0] ?? null;
    return Object.freeze(list);
  }

  /** The topmost element painted at a viewport point (CSSOM View §5.1), or null. */
  elementFromPoint(x, y) {
    const realm = realmOf(this);
    if (arguments.length < 2) throw bindingTypeError(realm, 'elementFromPoint requires two coordinates');
    x = finiteDouble(x, realm, 'x');
    y = finiteDouble(y, realm, 'y');
    if (nodeOf(this) !== realm.window.document) return null;
    return realm.wrap(realm.hooks.elementAt?.(x, y) ?? null);
  }

  elementsFromPoint(x, y) {
    const realm = realmOf(this);
    if (arguments.length < 2) throw bindingTypeError(realm, 'elementsFromPoint requires two coordinates');
    x = finiteDouble(x, realm, 'x');
    y = finiteDouble(y, realm, 'y');
    if (nodeOf(this) !== realm.window.document) return [];
    return realm.wrapAll(realm.hooks.elementsAt?.(x, y) ?? []);
  }

  get currentScript() {
    const realm = realmOf(this);
    return nodeOf(this) === realm.window.document ? realm.wrap(realm.hooks.currentScript?.() ?? null) : null;
  }

  get defaultView() {
    const realm = realmOf(this);
    return nodeOf(this) === realm.window.document ? realm.hooks.pageGlobal?.() ?? null : null;
  }

  get scripts() {
    return realmOf(this).live(nodeOf(this).scripts);
  }

  get forms() {
    return realmOf(this).live(nodeOf(this).forms);
  }

  get images() {
    return realmOf(this).live(nodeOf(this).images);
  }

  get links() {
    return realmOf(this).live(nodeOf(this).links);
  }

  getElementById(id) {
    return realmOf(this).wrap(elementById(nodeOf(this), domString(id)));
  }

  getElementsByName(name) {
    const realm = realmOf(this), document = nodeOf(this), key = String(name);
    const query = () => Array.from(document.querySelectorAll('[name]')).filter(node =>
      node.namespaceURI === 'http://www.w3.org/1999/xhtml' && node.getAttribute('name') === key);
    return realm.nodeLists ? realm.nodeLists.create(query, node => realm.wrap(node)) : realm.wrapAll(query());
  }

  createElement(name) {
    const element = createElement(nodeOf(this), domString(name));
    realmOf(this).hooks.created?.(element);
    return realmOf(this).wrap(element);
  }

  createElementNS(namespace, name) {
    const element = createElementNS(nodeOf(this), namespace == null ? null : domString(namespace), domString(name));
    realmOf(this).hooks.created?.(element);
    return realmOf(this).wrap(element);
  }

  createAttribute(name) {
    if (!arguments.length) throw new TypeError('createAttribute requires a name');
    return realmOf(this).wrap(nodeOf(this).createAttribute(domString(name)));
  }

  createAttributeNS(namespace, name) {
    if (arguments.length < 2) throw new TypeError('createAttributeNS requires two arguments');
    return realmOf(this).wrap(nodeOf(this).createAttributeNS(namespace == null ? null : domString(namespace), domString(name)));
  }

  createProcessingInstruction(target, data) {
    const realm = realmOf(this);
    if (arguments.length < 2) throw bindingTypeError(realm, 'createProcessingInstruction requires two arguments');
    const string = value => encodingString(value, (_name, message) => bindingTypeError(realm, message));
    return realm.wrap(nodeOf(this).createProcessingInstruction(string(target), string(data)));
  }

  createTextNode(text) {
    return realmOf(this).wrap(nodeOf(this).createTextNode(String(text)));
  }

  createComment(text) {
    return realmOf(this).wrap(nodeOf(this).createComment(String(text)));
  }

  createNodeIterator(root, whatToShow = NodeFilter.SHOW_ALL, filter = null) {
    return new NodeIteratorBinding(CONSTRUCT, realmOf(this), requireNode(root), whatToShow, filter);
  }

  createTreeWalker(root, whatToShow = NodeFilter.SHOW_ALL, filter = null) {
    return new TreeWalkerBinding(CONSTRUCT, realmOf(this), requireNode(root), whatToShow, filter);
  }

  createDocumentFragment() {
    return realmOf(this).wrap(nodeOf(this).createDocumentFragment());
  }

  getSelection() { return realmOf(this).selection?.() ?? null; }

  createRange() {
    return realmOf(this).wrapRange(nodeOf(this).createRange());
  }

  /** A copy of a node (from any document, a template's content say) owned by this one (DOM §4.5). */
  importNode(node, deep = false) {
    const options = typeof deep === "object" && deep !== null ? Boolean(deep.deep) : Boolean(deep);
    return realmOf(this).wrap(nodeOf(this).importNode(requireNode(node), options));
  }

  /** Moves a node into this document, out of wherever it was. */
  adoptNode(node) {
    const adopted = requireNode(node), owner = adopted.nodeType === 2 ? adopted.ownerElement : null;
    const result = nodeOf(this).adoptNode(adopted);
    if (owner) attributeChanged(realmOf(this).wrap(owner), adopted);
    return realmOf(this).wrap(result);
  }

  createEvent(type) {
    return createLegacyEvent(this, type, arguments.length, realmOf(this));
  }

  hasFocus() {
    return true;
  }
}

for (const type of EVENT_HANDLER_NAMES) {
  defineEventHandlerProperty(DocumentBinding.prototype, type, (wrapper) => nodeOf(wrapper), (wrapper) => realmOf(wrapper));
}

// UI initialization belongs to the event, including when another realm wraps it.
const initializedUIEvents = new WeakMap();

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

  static initializeLegacy(receiver, values) {
    return receiver.#initialize(values.type, values.bubbles, values.cancelable);
  }

  static initializeLegacyUI(receiver, values) {
    if (!receiver.#initialize(values.type, values.bubbles, values.cancelable)) return false;
    initializedUIEvents.set(receiver.#event, {detail:values.detail ?? 0, view:values.view ?? null});
    return true;
  }

  static initializeKeyboard(receiver, values) {
    if (!receiver.#initialize(values.type, values.bubbles, values.cancelable)) return;
    initializedUIEvents.set(receiver.#event, {detail:0, view:values.view});
    Object.assign(receiver.#event, {location:values.location, ctrlKey:values.ctrlKey,
      altKey:values.altKey, shiftKey:values.shiftKey, metaKey:values.metaKey, repeat:false});
  }

  get type() {
    return this.#event.type;
  }

  get target() {
    const target = exposedEventTarget(this.#event);
    return this.#realm.wrap(target) ?? this.#realm.hooks.targetOf?.(target) ?? null;
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
    return this.#realm.isTrusted(this.#event);
  }

  // Happy DOM stamps events with the engine's clock; pages see their document's timeline.
  get timeStamp() {
    return this.#realm.hooks.eventTime?.(this.#event.timeStamp)
      ?? this.#event.timeStamp - (this.#realm.hooks.timeOriginOffset?.() ?? 0);
  }

  get detail() {
    return initializedUIEvents.get(this.#event)?.detail ?? this.#detail
      ?? (typeof this.#event.detail === "number" ? this.#event.detail : null);
  }

  get composed() {
    return Boolean(this.#event.composed);
  }

  // Legacy aliases of defaultPrevented and stopPropagation (DOM §2.2).
  get returnValue() {
    return !this.#event.defaultPrevented;
  }

  set returnValue(value) {
    if (!value) this.preventDefault();
  }

  get cancelBubble() {
    return this.#event.cancelBubble;
  }

  set cancelBubble(value) {
    if (value) this.#event.stopPropagation();
  }

  // UIEvent: the window for events the browser dispatches, null for constructed ones.
  get view() {
    const initialized = initializedUIEvents.get(this.#event);
    if (initialized) return initialized.view;
    return this.#realm.isTrusted(this.#event) ? this.#realm.hooks.targetOf?.(this.#realm.window) ?? null : null;
  }

  get which() {
    if (typeof this.#event.keyCode === "number" && this.#event.keyCode) return this.#event.keyCode;
    return typeof this.#event.button === "number" ? this.#event.button + 1 : 0;
  }

  // MouseEvent coordinates (CSSOM View §12): page = client + scroll; x/y alias client.
  get pageX() {
    return this.clientX + (this.#realm.hooks.viewport?.().scrollX ?? 0);
  }

  get pageY() {
    return this.clientY + (this.#realm.hooks.viewport?.().scrollY ?? 0);
  }

  get x() {
    return this.clientX;
  }

  get y() {
    return this.clientY;
  }

  get offsetX() {
    // CSSOM View: relative to the target padding edge while dispatching;
    // outside dispatch offsetX/Y fall back to pageX/Y (also for synthetic events).
    if (!this.#event.eventPhase) return this.pageX;
    return this.#realm.hooks.mouseOffset?.(this.#event.target, this.clientX, this.clientY)?.x ?? this.pageX;
  }

  get offsetY() {
    if (!this.#event.eventPhase) return this.pageY;
    return this.#realm.hooks.mouseOffset?.(this.#event.target, this.clientX, this.clientY)?.y ?? this.pageY;
  }

  get movementX() {
    return this.#event.movementX ?? 0;
  }

  get movementY() {
    return this.#event.movementY ?? 0;
  }

  get dataTransfer() { return dragData(this.#event) ?? null; }
  get clipboardData() { return clipboardEventData.get(this.#event) ?? null; }

  get relatedTarget() {
    return this.#realm.wrap(exposedEventTarget(this.#event, true)) ?? null;
  }

  get submitter() { return this.#realm.wrap(this.#event.submitter ?? null); }

  getModifierState(key) {
    const name = String(key);
    return name === "Alt" ? this.altKey : name === "Control" ? this.ctrlKey : name === "Shift" ? this.shiftKey
      : name === "Meta" ? this.metaKey : false;
  }

  // Perform IDL conversions before changing any event state, including before
  // the dispatch guard. Initializers call private helpers so page overrides of
  // public initEvent/initUIEvent methods cannot intercept native initialization.
  #eventType(type, argumentCount, method) {
    if (!argumentCount) throw bindingTypeError(this.#realm, `${method} requires a type`);
    return encodingString(type, (_name, message) => bindingTypeError(this.#realm, message));
  }

  #initialize(type, bubbles, cancelable) {
    if (isEventDispatching(this.#event)) return false;
    initializeEvent(this.#event);
    this.#event.initEvent(type, Boolean(bubbles), Boolean(cancelable));
    return true;
  }

  #initializeUI(type, bubbles, cancelable, detail) {
    detail = eventLong(detail, this.#realm);
    if (this.#initialize(type, bubbles, cancelable)) {
      initializedUIEvents.set(this.#event, {detail, view:null});
    }
  }

  initUIEvent(type, bubbles = false, cancelable = false, _view = null, detail = 0) {
    type = this.#eventType(type, arguments.length, 'initUIEvent');
    this.#initializeUI(type, bubbles, cancelable, detail);
  }

  initMouseEvent(type, bubbles = false, cancelable = false, _view = null, detail = 0) {
    type = this.#eventType(type, arguments.length, 'initMouseEvent');
    this.#initializeUI(type, bubbles, cancelable, detail);
  }

  initEvent(type, bubbles = false, cancelable = false) {
    type = this.#eventType(type, arguments.length, 'initEvent');
    this.#initialize(type, bubbles, cancelable);
  }

  initCustomEvent(type, bubbles = false, cancelable = false, detail = null) {
    type = this.#eventType(type, arguments.length, 'initCustomEvent');
    if (this.#initialize(type, bubbles, cancelable)) this.#detail = detail;
  }

  // PopStateEvent and HashChangeEvent fields; the engine only fires popstate
  // with a null state, so no engine object reaches the page.
  get state() {
    if (!("state" in this.#event)) return undefined;
    const state = this.#event.state;
    return state !== null && typeof state === "object" ? null : state ?? null;
  }

  get oldURL() {
    return typeof this.#event.oldURL === "string" ? this.#event.oldURL : undefined;
  }

  get newURL() {
    return typeof this.#event.newURL === "string" ? this.#event.newURL : undefined;
  }

  get animationName() { return this.#event.animationName ?? ""; }
  get elapsedTime() { return this.#event.elapsedTime ?? 0; }
  get pseudoElement() { return this.#event.pseudoElement ?? ""; }

  get key() {
    return this.#event.key;
  }

  get code() {
    return this.#event.code;
  }

  get keyCode() { return this.#event.keyCode ?? 0; }
  get charCode() { return this.#event.charCode ?? 0; }

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
    const message = this.#realm.messageOf(this.#event);
    return message ? message.data : this.#event.data ?? null;
  }

  // MessageEvent fields; undefined on other events, as in browsers.
  get origin() {
    return this.#realm.messageOf(this.#event)?.origin;
  }

  get lastEventId() {
    return this.#realm.messageOf(this.#event)?.lastEventId;
  }

  get source() {
    const message = this.#realm.messageOf(this.#event);
    return message ? message.source : undefined;
  }

  get ports() {
    return this.#realm.messageOf(this.#event)?.ports;
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
    this.#event.stopPropagation();
    this.#event.stopImmediatePropagation();
  }

  composedPath() {
    return [];
  }
}

export const NodeFilter = Object.freeze({
  FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3,
  SHOW_ALL: 0xffffffff, SHOW_ELEMENT: 0x1, SHOW_ATTRIBUTE: 0x2, SHOW_TEXT: 0x4, SHOW_CDATA_SECTION: 0x8,
  SHOW_ENTITY_REFERENCE: 0x10, SHOW_ENTITY: 0x20,
  SHOW_PROCESSING_INSTRUCTION: 0x40, SHOW_COMMENT: 0x80, SHOW_DOCUMENT: 0x100, SHOW_DOCUMENT_TYPE: 0x200,
  SHOW_DOCUMENT_FRAGMENT: 0x400, SHOW_NOTATION: 0x800,
});
const { FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP } = NodeFilter;

const traversalTypes = new WeakMap();
const traversalNumber = (value, realm) => bindingNumber(value,
  {hooks: {pageGlobal: () => realm.inputValueIntrinsics}}, 'traversal argument');

// DOM filtering calls the object operation afresh, then converts its result
// to Web IDL unsigned short. Do not translate exceptions from page getters,
// callbacks or numeric converters: those retain their original identity.
function filterNode(realm, filter, node) {
  const callback = typeof filter === 'function' ? filter : filter.acceptNode;
  if (typeof callback !== 'function')
    throw new realm.inputValueIntrinsics.TypeError('NodeFilter.acceptNode must be callable');
  const result = Reflect.apply(callback, typeof filter === 'function' ? undefined : filter, [realm.wrap(node)]);
  return traversalNumber(result, realm) & 0xffff;
}

/** Per-page Web IDL facades; engine-private traversal state stays private. */
export function installTraversalInterfaces(documentPrototype, realm) {
  const interfaces = {};
  for (const [name, Binding] of [['TreeWalker', TreeWalkerBinding], ['NodeIterator', NodeIteratorBinding]]) {
    const Interface = {[name]: function () { throw new realm.inputValueIntrinsics.TypeError('Illegal constructor'); }}[name];
    const prototype = Object.create(Object.prototype);
    for (const key of Reflect.ownKeys(Binding.prototype)) {
      if (key === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(Binding.prototype, key);
      const wrap = (fn, setter = false) => function (...args) {
        if (traversalTypes.get(this) !== name)
          throw new realm.inputValueIntrinsics.TypeError('Illegal invocation');
        if (setter && !nodeOf(args[0]))
          throw new realm.inputValueIntrinsics.TypeError('currentNode requires a Node');
        return Reflect.apply(fn, this, args);
      };
      for (const kind of ['value', 'get', 'set']) if (typeof descriptor[kind] === 'function') {
        const original = descriptor[kind];
        descriptor[kind] = wrap(original, kind === 'set');
        Object.defineProperties(descriptor[kind], {
          name: {value: original.name, configurable: true},
          length: {value: original.length, configurable: true},
        });
      }
      descriptor.configurable = descriptor.enumerable = true;
      if ('value' in descriptor) descriptor.writable = true;
      Object.defineProperty(prototype, key, descriptor);
    }
    Object.defineProperties(prototype, {
      constructor: {value: Interface, writable: true, configurable: true},
      [Symbol.toStringTag]: {value: name, configurable: true},
    });
    Object.defineProperty(Interface, 'prototype', {value: prototype, writable: false});
    interfaces[name] = Interface;
    const method = `create${name}`;
    const factory = {[method](root, whatToShow = NodeFilter.SHOW_ALL, filter = null) {
      const TypeError = realm.inputValueIntrinsics.TypeError;
      if (nodeOf(this)?.nodeType !== 9) throw new TypeError('Illegal invocation');
      const nativeRoot = nodeOf(root);
      if (!nativeRoot) throw new TypeError(`${method} requires a Node`);
      const mask = traversalNumber(whatToShow, realm) >>> 0;
      if (filter !== null && typeof filter !== 'object' && typeof filter !== 'function')
        throw new TypeError('NodeFilter must be an object or null');
      const walker = new Binding(CONSTRUCT, realm, nativeRoot, mask, filter);
      traversalTypes.set(walker, name);
      Object.setPrototypeOf(walker, prototype);
      return walker;
    }};
    Object.defineProperty(documentPrototype, method, Object.getOwnPropertyDescriptor(factory, method));
  }
  return interfaces;
}

/** DOM §6.1: a cursor between nodes, including the root; REJECT skips
 * only that node, unlike TreeWalker where it also prunes descendants. */
class NodeIteratorBinding {
  #realm; #root; #reference; #before = true; #whatToShow; #filter; #active = false;
  #candidate = null;
  constructor(key, realm, root, whatToShow, filter) {
    if (key !== CONSTRUCT) throw new TypeError("Illegal constructor");
    this.#realm = realm; this.#root = this.#reference = root;
    this.#whatToShow = +whatToShow >>> 0; this.#filter = filter ?? null;
    // WebIDL callback interfaces accept objects/functions or null, but no
    // primitives; validate even when whatToShow would skip every node.
    if (this.#filter !== null && typeof filter !== "object" && typeof filter !== "function") {
      throw new TypeError("NodeIterator filter must be an object or null");
    }
    // Keep the internal removal callback off the page-visible interface.
    observeIteratorRemoval(root, this.#removal);
  }
  #removal = { preRemove: node => this.#preRemove(node) };
  get root() { return this.#realm.wrap(this.#root); }
  get referenceNode() { return this.#realm.wrap(this.#reference); }
  get pointerBeforeReferenceNode() { return this.#before; }
  get whatToShow() { return this.#whatToShow; }
  get filter() { return this.#filter; }
  detach() {} // Legacy no-op, as required by DOM.
  nextNode() { return this.#traverse(true); }
  previousNode() { return this.#traverse(false); }
  #following(node, children = true) {
    if (children && node.firstChild) return node.firstChild;
    while (node && node !== this.#root) {
      if (node.nextSibling) return node.nextSibling;
      node = node.parentNode;
    }
    return null;
  }
  #preceding(node) {
    if (node === this.#root) return null;
    if (!node.previousSibling) return node.parentNode;
    node = node.previousSibling;
    while (node.lastChild) node = node.lastChild;
    return node;
  }
  #accept(node) {
    if (this.#active) throw new DOMException("The iterator filter is already active", "InvalidStateError");
    if (!(this.#whatToShow & (1 << (node.nodeType - 1)))) return FILTER_SKIP;
    if (this.#filter === null) return FILTER_ACCEPT;
    this.#active = true;
    try {
      return filterNode(this.#realm, this.#filter, node);
    } finally { this.#active = false; }
  }
  #traverse(forward) {
    if (this.#active) throw new DOMException("The iterator filter is already active", "InvalidStateError");
    // A filter can remove its candidate or an ancestor synchronously. Track
    // the traversal cursor separately so pre-removal adjusts both positions.
    const cursor = this.#candidate = { node: this.#reference, before: this.#before };
    try {
      for (;;) {
        if (forward) {
          if (cursor.before) cursor.before = false;
          else cursor.node = this.#following(cursor.node);
        } else {
          if (!cursor.before) cursor.before = true;
          else cursor.node = this.#preceding(cursor.node);
        }
        const node = cursor.node;
        if (!node) return null;
        if (this.#accept(node) === FILTER_ACCEPT) {
          this.#reference = cursor.node; this.#before = cursor.before;
          // Return the accepted node even if the filter removed it; the next
          // traversal resumes at the repaired position in the remaining tree.
          return this.#realm.wrap(node);
        }
      }
    } finally { this.#candidate = null; }
  }
  #preRemove(node) {
    if (node === this.#root) return;
    const adjust = cursor => {
      if (!cursor?.node || !node.contains(cursor.node)) return;
      if (cursor.before) {
        const next = this.#following(node, false);
        if (next) { cursor.node = next; return; }
        cursor.before = false;
      }
      cursor.node = this.#preceding(node);
    };
    const reference = { node: this.#reference, before: this.#before };
    adjust(reference);
    this.#reference = reference.node; this.#before = reference.before;
    adjust(this.#candidate);
  }
}

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
  #active = false;

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
    if (this.#active)
      throw new this.#realm.inputValueIntrinsics.DOMException('The walker filter is already active', 'InvalidStateError');
    if (!(this.#whatToShow & (1 << (node.nodeType - 1)))) return FILTER_SKIP;
    const filter = this.#filter;
    if (filter === null) return FILTER_ACCEPT;
    this.#active = true;
    try { return filterNode(this.#realm, filter, node); }
    finally { this.#active = false; }
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

const classListStates = new WeakMap();
function classListState(list) {
  const state = classListStates.get(list);
  if (!state) throw new TypeError('Illegal invocation');
  return state;
}
function classListTypeError(list, message) {
  const {realm} = classListState(list);
  return new (realm.hooks.pageGlobal?.()?.TypeError ?? TypeError)(message);
}
function classTokens(list) {
  const value = classListState(list).node.getAttribute('class') ?? '';
  return [...new Set(value.split(/[\t\n\f\r ]+/).filter(Boolean))];
}
function validateClassTokens(list, values, minimum = 0) {
  if (values.length < minimum) throw classListTypeError(list, 'Not enough arguments');
  const strings = values.map(value => '' + value);
  for (const token of strings) {
    if (!token.length) throw new DOMException('The token must not be empty.', 'SyntaxError');
    if (/[\t\n\f\r ]/.test(token)) throw new DOMException('The token must not contain ASCII whitespace.', 'InvalidCharacterError');
  }
  return strings;
}
function updateClassTokens(list, tokens) {
  const {node, realm} = classListState(list);
  if (!tokens.length && !node.hasAttribute('class')) return;
  node.setAttribute('class', tokens.join(' '));
  realm.hooks.touch(node, [], 'attributes');
}

class ClassListBinding {
  constructor(key, node, realm) {
    if (key !== CONSTRUCT) throw new TypeError('Illegal constructor');
    const isIndex = key => typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < 0xffffffff;
    const proxy = new Proxy(this, {
      get(target, key, receiver) {
        return isIndex(key) ? classTokens(receiver)[Number(key)] : Reflect.get(target, key, receiver);
      },
      has(target, key) { return isIndex(key) ? Number(key) < classTokens(proxy).length : Reflect.has(target, key); },
      ownKeys(target) { return [...classTokens(proxy).map((_, i) => String(i)), ...Reflect.ownKeys(target)]; },
      getOwnPropertyDescriptor(target, key) {
        if (isIndex(key)) {
          const value = classTokens(proxy)[Number(key)];
          return value === undefined ? undefined : {value, writable:false, enumerable:true, configurable:true};
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      set(target, key, value, receiver) { return !isIndex(key) && Reflect.set(target, key, value, receiver); },
      defineProperty(target, key, descriptor) { return !isIndex(key) && Reflect.defineProperty(target, key, descriptor); },
      deleteProperty(target, key) { return isIndex(key) ? Number(key) >= classTokens(proxy).length : Reflect.deleteProperty(target, key); },
      preventExtensions: () => false,
    });
    classListStates.set(proxy, {node, realm});
    return proxy;
  }

  get length() { return classTokens(this).length; }
  get value() { return classListState(this).node.getAttribute('class') ?? ''; }
  set value(value) {
    const {node, realm} = classListState(this);
    node.setAttribute('class', '' + value);
    realm.hooks.touch(node, [], 'attributes');
  }
  item(index) {
    if (!arguments.length) throw classListTypeError(this, 'Not enough arguments');
    return classTokens(this)[Number(index) >>> 0] ?? null;
  }
  contains(token) {
    if (!arguments.length) throw classListTypeError(this, 'Not enough arguments');
    return classTokens(this).includes('' + token);
  }
  supports(token) {
    if (!arguments.length) throw classListTypeError(this, 'Not enough arguments');
    token = '' + token;
    throw classListTypeError(this, 'classList has no supported tokens');
  }
  add(...tokens) {
    const converted = validateClassTokens(this, tokens);
    updateClassTokens(this, [...new Set([...classTokens(this), ...converted])]);
  }
  remove(...tokens) {
    const converted = new Set(validateClassTokens(this, tokens));
    updateClassTokens(this, classTokens(this).filter(token => !converted.has(token)));
  }
  toggle(token, force) {
    [token] = validateClassTokens(this, arguments.length ? [token] : [], 1);
    const tokens = classTokens(this), present = tokens.includes(token);
    const desired = force !== undefined ? Boolean(force) : !present;
    if (desired !== present) updateClassTokens(this, desired ? [...tokens, token] : tokens.filter(t => t !== token));
    return desired;
  }
  replace(oldToken, newToken) {
    if (arguments.length < 2) throw classListTypeError(this, 'Not enough arguments');
    oldToken = '' + oldToken; newToken = '' + newToken;
    // replace checks both empty strings before checking either for whitespace.
    if (!oldToken.length || !newToken.length) throw new DOMException('The token must not be empty.', 'SyntaxError');
    validateClassTokens(this, [oldToken, newToken]);
    const tokens = classTokens(this);
    if (!tokens.includes(oldToken)) return false;
    updateClassTokens(this, [...new Set(tokens.map(token => token === oldToken ? newToken : token))]);
    return true;
  }
  toString() { return this.value; }
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
  // Scroll-driven animations
  "animationTimeline", "scrollTimeline", "scrollTimelineAxis", "scrollTimelineName", "viewTimeline",
  "viewTimelineAxis", "viewTimelineInset", "viewTimelineName",
]);

/** Each element.style proxy → its element, declaration block and realm. */
const styleStates = new WeakMap();

function styleState(self) {
  const state = styleStates.get(self);
  if (!state) throw new TypeError("Illegal invocation");
  return state;
}

/**
 * CSSStyleDeclaration (CSSOM §6.6) for one realm: the operations and the
 * cssText/length accessors live on its prototype, as in browsers, so
 * element.style.setProperty is the interface's (native-looking) method.
 */
export function cssStyleDeclarationInterface(realm) {
  if (realm.cssStyleDeclaration) return realm.cssStyleDeclaration;
  const CSSStyleDeclaration = { CSSStyleDeclaration: function () { throw new TypeError("Illegal constructor"); } }.CSSStyleDeclaration;
  const members = {
    get cssText() { return styleState(this).style.cssText; },
    set cssText(value) {
      const { style, notify } = styleState(this);
      style.cssText = String(value);
      // Replacing the declaration block reparses it, including pending values
      // whose public serialization can be identical to the previous block.
      notify();
    },
    get length() { return styleState(this).style.length; },
    get parentRule() { return styleState(this).parentRule; },
    [Symbol.iterator]: Array.prototype.values,
    get cssFloat() { return styleState(this).style.getPropertyValue("float"); },
    set cssFloat(value) { this.setProperty("float", value); },
    item(index) { return styleState(this).style.item?.(Number(index) >>> 0) ?? ""; },
    getPropertyValue(property) { return styleState(this).style.getPropertyValue(animationProperty(property)); },
    getPropertyPriority(property) { return styleState(this).style.getPropertyPriority?.(animationProperty(property)) ?? ""; },
    setProperty(property, value, priority = "") {
      const { style, notify } = styleState(this);
      // The shared CSSOM layer already compares and publishes changes,
      // including pending shorthands whose public cssText can stay identical.
      const revision=cssDeclarationRevision(style);
      style.setProperty(animationProperty(property), value === null ? "" : String(value), String(priority));
      if (cssDeclarationRevision(style)!==revision) notify();
    },
    removeProperty(property) {
      const { style, notify } = styleState(this);
      const revision=cssDeclarationRevision(style);
      const previous = style.removeProperty(animationProperty(property));
      if (cssDeclarationRevision(style)!==revision) notify();
      return previous;
    },
  };
  const prototype = {};
  for (const key of Reflect.ownKeys(members)) {
    Object.defineProperty(prototype, key, { ...Object.getOwnPropertyDescriptor(members, key), enumerable: true, configurable: true });
  }
  Object.defineProperty(prototype, "constructor", { value: CSSStyleDeclaration, writable: true, configurable: true });
  Object.defineProperty(prototype, Symbol.toStringTag, { value: "CSSStyleDeclaration", configurable: true });
  Object.defineProperty(CSSStyleDeclaration, "prototype", { value: prototype });
  realm.cssStyleDeclaration = CSSStyleDeclaration;
  return CSSStyleDeclaration;
}

/** CSS feature detection ignores JavaScript expandos on an inline declaration. */
export function supportsStyleProperty(declaration, property) {
  return styleStates.get(declaration)?.supportsProperty(property) ?? false;
}

/**
 * element.style: a proxy over a CSSStyleDeclaration that reads and writes
 * the real declaration block, by property name, with string values only.
 * Mutations go to the style attribute, which the style engine reads.
 */
function styleBinding(node, realm, {style = node.style, notify = () => realm.hooks.touch(node, ['[style'], 'attributes'), parentRule = null} = {}) {
  const prototype = cssStyleDeclarationInterface(realm).prototype;
  const toKebab = (property) => property.startsWith("--") ? property : animationProperty(property);
  const indexPattern = /^(0|[1-9]\d*)$/;
  const supported = (property) => {
    const normalized = animationProperty(property);
    if (/^animation(?:-(?:name|duration|delay|iteration-count|direction|fill-mode|play-state|timing-function))?$/.test(normalized)) {
      return normalized in style || normalized.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) in style;
    }
    const camel = property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    return !property.startsWith("--") && property in style && !UNRENDERED_STYLE_PROPERTIES.has(camel);
  };
  const proxy = new Proxy(Object.create(prototype), {
    get(target, property, receiver) {
      if (typeof property !== "string" || Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      if (indexPattern.test(property)) {
        const index = Number(property);
        return index < style.length ? style.item(index) : undefined;
      }
      // CSS named accessors exist only for supported properties. Unknown
      // names are ordinary JavaScript expandos, not empty CSS declarations.
      return supported(property) ? style.getPropertyValue(toKebab(property)) : undefined;
    },
    set(target, property, value, receiver) {
      if (typeof property === "string" && indexPattern.test(property)) return false;
      if (typeof property !== "string" || Reflect.has(target, property) || !supported(property)) {
        return Reflect.set(target, property, value, receiver);
      }
      const revision=cssDeclarationRevision(style);
      style.setProperty(toKebab(property), value === null ? "" : String(value));
      if (cssDeclarationRevision(style)!==revision) notify();
      return true;
    },
    has(target, property) {
      if (Reflect.has(target, property)) return true;
      if (typeof property !== "string") return false;
      if (indexPattern.test(property)) return Number(property) < style.length;
      return supported(property);
    },
    ownKeys(target) {
      return [...Array.from({length: style.length}, (_, index) => String(index)), ...Reflect.ownKeys(target)];
    },
    getOwnPropertyDescriptor(target, property) {
      if (typeof property === "string" && indexPattern.test(property) && Number(property) < style.length) {
        return {value: style.item(Number(property)), writable: false, enumerable: true, configurable: true};
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    defineProperty(target, property, descriptor) {
      if (typeof property === "string" && indexPattern.test(property)) return false;
      return Reflect.defineProperty(target, property, descriptor);
    },
    deleteProperty(target, property) {
      if (typeof property === "string" && indexPattern.test(property) && Number(property) < style.length) return false;
      return Reflect.deleteProperty(target, property);
    },
    // Indexed properties are virtual and change with the live declaration block.
    preventExtensions: () => false,
    setPrototypeOf: () => false,
  });
  styleStates.set(proxy, { node, style, realm, notify, parentRule, supportsProperty: supported });
  return proxy;
}

export function ruleStyleBinding(style, realm, parentRule, notify) {
  return styleBinding(null, realm, {style, notify, parentRule});
}

/** A live NamedNodeMap, with stable Attr wrappers and prototype methods. */
const attributeMapOwners = new WeakMap();
function mapOwner(map) {
  const owner = attributeMapOwners.get(map);
  if (!owner) throw new TypeError('Illegal invocation');
  return owner;
}
class NamedNodeMapBinding {
  constructor() { throw new TypeError('Illegal constructor'); }
  get length() { return nodeOf(mapOwner(this)).attributes.length; }
  item(index) {
    const owner = mapOwner(this);
    if (!arguments.length) throw new TypeError('item requires an index');
    return realmOf(owner).wrap(nodeOf(owner).attributes.item(+index >>> 0));
  }
  getNamedItem(name) {
    return ElementBinding.prototype.getAttributeNode.apply(mapOwner(this), arguments);
  }
  getNamedItemNS(namespace, localName) {
    return ElementBinding.prototype.getAttributeNodeNS.apply(mapOwner(this), arguments);
  }
  setNamedItem(attribute) {
    return ElementBinding.prototype.setAttributeNode.call(mapOwner(this), attribute);
  }
  setNamedItemNS(attribute) {
    return ElementBinding.prototype.setAttributeNodeNS.call(mapOwner(this), attribute);
  }
  removeNamedItem(name) {
    const owner = mapOwner(this);
    const attr = ElementBinding.prototype.getAttributeNode.apply(owner, arguments);
    if (!attr) throw new DOMException('Attribute not found', 'NotFoundError');
    return ElementBinding.prototype.removeAttributeNode.call(owner, attr);
  }
  removeNamedItemNS(namespace, localName) {
    const owner = mapOwner(this);
    const attr = ElementBinding.prototype.getAttributeNodeNS.apply(owner, arguments);
    if (!attr) throw new DOMException('Attribute not found', 'NotFoundError');
    return ElementBinding.prototype.removeAttributeNode.call(owner, attr);
  }
  *[Symbol.iterator]() {
    const owner = mapOwner(this), attributes = nodeOf(owner).attributes;
    for (let i = 0; i < attributes.length; i++) yield realmOf(owner).wrap(attributes.item(i));
  }
  get [Symbol.toStringTag]() { return 'NamedNodeMap'; }
}
function attributesBinding(owner) {
  const element = nodeOf(owner), realm = realmOf(owner), attributes = element.attributes;
  const target = Object.create(realm.namedNodeMapPrototype ?? NamedNodeMapBinding.prototype);
  const isIndex = key => typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 0xffffffff;
  const at = key => realm.wrap(attributes.item(Number(key)));
  const names = () => [...new Set(element.getAttributeNames())].filter(name =>
    !(element.namespaceURI === 'http://www.w3.org/1999/xhtml' && element.ownerDocument.contentType === 'text/html' && /[A-Z]/.test(name)));
  const named = key => typeof key === 'string' && !isIndex(key) && !Reflect.has(target, key) && names().includes(key)
    ? realm.wrap(attributes.getNamedItem(key)) : null;
  const descriptor = (value, enumerable) => ({value, writable:false, enumerable, configurable:true});
  let view;
  view = new Proxy(target, {
    get(target, key, receiver) {
      if (isIndex(key) && Number(key) < attributes.length) return at(key);
      return named(key) ?? Reflect.get(target, key, receiver);
    },
    has(target, key) {
      return (isIndex(key) && Number(key) < attributes.length) || named(key) !== null || Reflect.has(target, key);
    },
    ownKeys(target) {
      return [...new Set([
        ...Array.from({length:attributes.length}, (_, i) => String(i)),
        ...names().filter(key => !isIndex(key) && !Reflect.has(target, key)),
        ...Reflect.ownKeys(target),
      ])];
    },
    getOwnPropertyDescriptor(target, key) {
      if (isIndex(key) && Number(key) < attributes.length) return descriptor(at(key), true);
      const value = named(key);
      return value ? descriptor(value, false) : Reflect.getOwnPropertyDescriptor(target, key);
    },
    set(target, key, value, receiver) {
      if (receiver === view && (isIndex(key) || named(key) !== null)) return false;
      return Reflect.set(target, key, value, receiver);
    },
    defineProperty(target, key, descriptor) {
      if (isIndex(key) || named(key) !== null) return false;
      return Reflect.defineProperty(target, key, descriptor);
    },
    deleteProperty(target, key) {
      if ((isIndex(key) && Number(key) < attributes.length) || named(key) !== null) return false;
      return Reflect.deleteProperty(target, key);
    },
    preventExtensions() { return false; },
  });
  attributeMapOwners.set(view, owner);
  return view;
}

/** element.dataset: data-* attributes as camelCase string properties. */
function datasetBinding(node, realm) {
  const attribute = (property) => `data-${property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
  const supported = (property) => typeof property === "string" && !/-[a-z]/.test(property)
    && node.hasAttribute(attribute(property));
  const set = (target, property, value) => {
    if (typeof property !== "string") return Reflect.set(target, property, value);
    if (/-[a-z]/.test(property)) throw new DOMException("The property name must not contain a hyphen followed by a lowercase letter.", "SyntaxError");
    const name = attribute(property);
    const next = String(value);
    if (node.getAttribute(name) !== next) {
      node.setAttribute(name, next);
      realm.hooks.touch(node, [], 'attributes');
    }
    return true;
  };
  return new Proxy(Object.create(realm.datasetPrototype), {
    get(target, property, receiver) {
      return supported(property) ? node.getAttribute(attribute(property)) : Reflect.get(target, property, receiver);
    },
    set,
    has: (target, property) => supported(property) || Reflect.has(target, property),
    deleteProperty(target, property) {
      if (!supported(property)) return Reflect.deleteProperty(target, property);
      node.removeAttribute(attribute(property));
      realm.hooks.touch(node, [], 'attributes');
      return true;
    },
    ownKeys: (target) => [...node.getAttributeNames()
      .filter((name) => name.startsWith("data-"))
      .map((name) => name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())), ...Reflect.ownKeys(target)],
    getOwnPropertyDescriptor(target, property) {
      return supported(property)
        ? { value: node.getAttribute(attribute(property)), writable: true, enumerable: true, configurable: true }
        : Reflect.getOwnPropertyDescriptor(target, property);
    },
    defineProperty(target, property, descriptor) {
      if (typeof property !== "string") return Reflect.defineProperty(target, property, descriptor);
      if (!("value" in descriptor) || descriptor.configurable === false) return false;
      return set(target, property, descriptor.value);
    },
    preventExtensions: () => false,
  });
}

/**
 * Flattens addEventListener's options (DOM §2.7 "flatten more"): the
 * dictionary's members are read once each, in IDL order (capture, then
 * once, passive and signal), before anything else happens, as pages detect
 * support for an option by watching its getter run.
 */
function listenerOptions(options) {
  if (typeof options !== "object" || options === null) {
    return { capture: Boolean(options), once: false, passive: null, signal: null };
  }
  const capture = Boolean(options.capture);
  const once = Boolean(options.once);
  const passiveValue = options.passive;
  const signal = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("Failed to read the 'signal' property from 'AddEventListenerOptions': Failed to convert value to 'AbortSignal'.");
  }
  return { capture, once, passive: passiveValue === undefined ? null : Boolean(passiveValue), signal: signal ?? null };
}

function addListener(wrapper, target, type, listener, options) {
  const { capture, once, signal } = listenerOptions(options);
  if (typeof listener !== "function" && (listener === null || typeof listener !== "object")) return;
  if (signal?.aborted) return;
  const realm = realmOf(wrapper) ?? wrapper;
  const listeners = realm.listenerFor(target, String(type), listener, capture);
  if (listeners.has(listener)) return;
  // An aborted signal removes the listener (DOM §2.7 "add an event listener", step 6).
  signal?.addEventListener("abort", () => removeListener(wrapper, target, type, listener, capture), { once: true });
  const callback = (event) => {
    if (realm.hooks.acceptEvent && !realm.hooks.acceptEvent(event)) return;
    if (once) removeListener(wrapper, target, type, listener, capture);
    const binding = realm.wrapEvent(event);
    const thisArg = realm.wrap(event.currentTarget) ?? wrapper;
    if (typeof listener === "function") realm.hooks.call(listener, thisArg, [binding]);
    else realm.hooks.call(listener.handleEvent, listener, [binding]);
  };
  const host = realm.hooks.captureCallback?.(callback) ?? callback;
  listeners.set(listener, host);
  target.addEventListener(String(type), host, { capture });
}

function removeListener(wrapper, target, type, listener, options) {
  const realm = realmOf(wrapper) ?? wrapper;
  const capture = typeof options === "object" && options !== null ? Boolean(options.capture) : Boolean(options);
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
      if (!real) throw bindingTypeError(realm, "dispatchEvent requires an Event");
      return dispatchScriptEvent(target, real);
    },
    targetOf: (real) => real === target ? pageGlobal : null,
  };
}

/**
 * Range (DOM §5.5) over an engine Range: boundary points and the content
 * operations; nodes go in and out wrapped. Its client rects are those of the
 * smallest element containing it.
 */
class RangeBinding {
  static START_TO_START = 0;
  static START_TO_END = 1;
  static END_TO_END = 2;
  static END_TO_START = 3;

  #range;
  #realm;

  constructor(key, range, realm) {
    if (key !== CONSTRUCT) throw new TypeError("Illegal constructor");
    this.#range = range;
    this.#realm = realm;
  }

  static rangeOf(value) {
    if (value === null || typeof value !== "object" || !(#range in value)) throw new TypeError("parameter is not of type 'Range'");
    return value.#range;
  }

  get startContainer() { return this.#realm.wrap(this.#range.startContainer); }
  get startOffset() { return this.#range.startOffset; }
  get endContainer() { return this.#realm.wrap(this.#range.endContainer); }
  get endOffset() { return this.#range.endOffset; }
  get collapsed() { return this.#range.collapsed; }
  get commonAncestorContainer() { return this.#realm.wrap(this.#range.commonAncestorContainer); }

  setStart(node, offset) { this.#range.setStart(requireNode(node), Number(offset) >>> 0); }
  setEnd(node, offset) { this.#range.setEnd(requireNode(node), Number(offset) >>> 0); }
  setStartBefore(node) { this.#range.setStartBefore(requireNode(node)); }
  setStartAfter(node) { this.#range.setStartAfter(requireNode(node)); }
  setEndBefore(node) { this.#range.setEndBefore(requireNode(node)); }
  setEndAfter(node) { this.#range.setEndAfter(requireNode(node)); }
  selectNode(node) { this.#range.selectNode(requireNode(node)); }
  selectNodeContents(node) { this.#range.selectNodeContents(requireNode(node)); }
  collapse(toStart = false) { this.#range.collapse(Boolean(toStart)); }
  detach() {}

  cloneRange() { return this.#realm.wrapRange(this.#range.cloneRange()); }
  compareBoundaryPoints(how, other) { return this.#range.compareBoundaryPoints(Number(how), RangeBinding.rangeOf(other)); }
  comparePoint(node, offset) { return this.#range.comparePoint(requireNode(node), Number(offset) >>> 0); }
  isPointInRange(node, offset) { return this.#range.isPointInRange(requireNode(node), Number(offset) >>> 0); }
  intersectsNode(node) { return this.#range.intersectsNode(requireNode(node)); }

  cloneContents() { return this.#realm.wrap(this.#range.cloneContents()); }
  extractContents() { return this.#realm.wrap(this.#range.extractContents()); }
  deleteContents() { this.#range.deleteContents(); }
  insertNode(node) { this.#range.insertNode(requireNode(node)); }
  surroundContents(node) { this.#range.surroundContents(requireNode(node)); }
  createContextualFragment(html) { return this.#realm.wrap(this.#range.createContextualFragment(String(html))); }

  getBoundingClientRect() {
    let node = this.#range.commonAncestorContainer;
    if (node && node.nodeType !== 1) node = node.parentElement;
    const rect = node ? this.#realm.hooks.boundsOf(node) : null;
    return domRect(rect ?? { left: 0, top: 0, width: 0, height: 0 });
  }

  getClientRects() { return [this.getBoundingClientRect()]; }
  toString() { return this.#range.toString(); }
}

/** Page-constructible Range (`new Range()`), its prototype shared by document.createRange()'s. */
export function rangeConstructor(realm) {
  const intrinsics = () => realm.inputValueIntrinsics ?? {TypeError, DOMException};
  const invalid = message => new (intrinsics().TypeError)(message);
  function Range() {
    if (!new.target) throw invalid("Constructor Range requires 'new'");
    return realm.wrapRange(new realm.window.Range());
  }
  realm.rangePrototype = mutableBindingPrototype(RangeBinding.prototype);
  const nodeMethods = new Set(['setStart', 'setEnd', 'setStartBefore', 'setStartAfter', 'setEndBefore', 'setEndAfter',
    'selectNode', 'selectNodeContents', 'comparePoint', 'isPointInRange', 'intersectsNode', 'insertNode', 'surroundContents']);
  const offsetMethods = new Set(['setStart', 'setEnd', 'comparePoint', 'isPointInRange']);
  const conversionRealm = {hooks:{pageGlobal:intrinsics}};
  const number = value => bindingNumber(value, conversionRealm, 'Range argument');
  // Validate and coerce before entering native algorithms. Only translate the
  // engine's private DOMException class; author conversion exceptions keep
  // their identity. Functions use their defining page's captured intrinsics.
  for (const key of Reflect.ownKeys(RangeBinding.prototype)) {
    if (key === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(RangeBinding.prototype, key);
    const nodeArgument = nodeMethods.has(key), offsetArgument = offsetMethods.has(key);
    const required = offsetArgument || key === 'compareBoundaryPoints' ? 2
      : nodeArgument || key === 'createContextualFragment' ? 1 : 0;
    for (const kind of ['value', 'get']) if (typeof descriptor[kind] === 'function') {
      const original = descriptor[kind];
      descriptor[kind] = function(...args) {
        try { RangeBinding.rangeOf(this); }
        catch { throw invalid('Illegal invocation'); }
        if (args.length < required) throw invalid(`${key} requires ${required} argument(s)`);
        if (nodeArgument && !nodeOf(args[0])) throw invalid("parameter is not of type 'Node'");
        if (offsetArgument) args[1] = number(args[1]) >>> 0;
        if (key === 'compareBoundaryPoints') {
          args[0] = number(args[0]) & 0xffff;
          try { RangeBinding.rangeOf(args[1]); }
          catch { throw invalid("parameter is not of type 'Range'"); }
        }
        if (key === 'createContextualFragment') args[0] = encodingString(args[0], (_name, message) => invalid(message));
        try { return Reflect.apply(original, this, args); }
        catch (error) {
          if (error instanceof NativeDOMException) throw new (intrinsics().DOMException)(error.message, error.name);
          throw error;
        }
      };
      Object.defineProperties(descriptor[kind], {
        name: {value: original.name, configurable: true}, length: {value: original.length, configurable: true},
      });
    }
    descriptor.configurable = descriptor.enumerable = true;
    if ('value' in descriptor) descriptor.writable = true;
    Object.defineProperty(realm.rangePrototype, key, descriptor);
  }
  Object.defineProperty(realm.rangePrototype, "constructor", { value: Range, writable: true, configurable: true });
  Range.prototype = realm.rangePrototype;
  for (const name of ["START_TO_START", "START_TO_END", "END_TO_END", "END_TO_START"]) {
    Object.defineProperty(Range, name, { value: RangeBinding[name], enumerable: true });
    Object.defineProperty(realm.rangePrototype, name, { value: RangeBinding[name], enumerable: true });
  }
  return Range;
}

/**
 * Page-constructible EventTarget (`new EventTarget()` and subclasses). Each
 * instance is backed by its own Happy DOM EventTarget; `targetOf` maps that
 * back to the page object for event.target and the listener's `this`.
 * EventTarget.prototype's methods work on every event target, as in browsers
 * (Node.prototype and Window.prototype inherit them): `targetOfPage` gives the
 * engine target behind a node or the window.
 */
const pageEventTargets = new WeakSet();
export function eventTargetConstructor(realm, isTarget = () => false, targetOfPage = () => null) {
  const backing = new WeakMap();
  const owners = new WeakMap();
  const realOf = (self) => {
    const real = backing.get(self) ?? targetOfPage(self);
    if (!real) throw new TypeError("Illegal invocation");
    return real;
  };
  function EventTarget() {
    if (!new.target) throw new TypeError("Constructor EventTarget requires 'new'");
    const self = Object.create(new.target.prototype);
    const real = new realm.window.EventTarget();
    backing.set(self, real);
    pageEventTargets.add(self);
    owners.set(real, self);
    return self;
  }
  EventTarget.prototype = {
    constructor: EventTarget,
    addEventListener(type, listener, options = undefined) {
      addListener(realm, realOf(this), type, listener, options);
    },
    removeEventListener(type, listener, options = undefined) {
      removeListener(realm, realOf(this), type, listener, options);
    },
    dispatchEvent(event) {
      const target = realOf(this);
      const real = EventBinding.unwrap(event);
      if (!real) throw bindingTypeError(realm, "dispatchEvent requires an Event");
      return dispatchScriptEvent(target, real);
    },
  };
  // Nodes and the window are event targets too, though not built from this constructor.
  Object.defineProperty(EventTarget, Symbol.hasInstance, {
    value: (value) => backing.has(value) || isTarget(value)
      || Function.prototype[Symbol.hasInstance].call(EventTarget, value),
  });
  return { EventTarget, targetOf: (real) => owners.get(real) ?? null,
    hasListeners(self) {
      const lists = realOf(self)[nativeListeners];
      return [lists.capturing, lists.bubbling].some(list => [...list.values()].some(values => values.length));
    },
    defineHandler(prototype, type) { defineEventHandlerProperty(prototype, type, realOf, () => realm); },
    dispatchTrusted(self, event) {
      const real = EventBinding.unwrap(event);
      return realOf(self).dispatchEvent(markEventTrusted(real));
    },
  };
}

const EVENT_PHASES = Object.freeze({ NONE: 0, CAPTURING_PHASE: 1, AT_TARGET: 2, BUBBLING_PHASE: 3 });
const MODIFIERS = ["altKey", "ctrlKey", "shiftKey", "metaKey", "getModifierState"];
const MOUSE_MEMBERS = ["screenX", "screenY", "clientX", "clientY", "pageX", "pageY", "x", "y", "offsetX", "offsetY",
  "movementX", "movementY", "button", "buttons", "relatedTarget", "initMouseEvent", ...MODIFIERS];
/** Event interface → [parent interface, members it owns], parents first. */
const EVENT_INTERFACES = {
  CustomEvent: ["Event", ["detail", "initCustomEvent"]],
  ClipboardEvent: ["Event", ["clipboardData"]],
  AnimationEvent: ["Event", ["animationName", "elapsedTime", "pseudoElement"]],
  UIEvent: ["Event", ["detail", "view", "which", "initUIEvent"]],
  MouseEvent: ["UIEvent", MOUSE_MEMBERS],
  DragEvent: ["MouseEvent", ["dataTransfer"]],
  PointerEvent: ["MouseEvent", ["pointerType"]],
  WheelEvent: ["MouseEvent", ["deltaX", "deltaY", "deltaMode"]],
  KeyboardEvent: ["UIEvent", ["key", "code", "keyCode", "charCode", "repeat", ...MODIFIERS]],
  FocusEvent: ["UIEvent", ["relatedTarget"]],
  InputEvent: ["UIEvent", ["data", "inputType"]],
  MessageEvent: ["Event", ["data", "origin", "lastEventId", "source", "ports"]],
  PopStateEvent: ["Event", ["state"]],
  HashChangeEvent: ["Event", ["oldURL", "newURL"]],
  SubmitEvent: ["Event", ["submitter"]],
};
/** document.createEvent() interface names (DOM §4.5): legacy aliases included. */
const CREATE_EVENT_TYPES = new Map([["event", "Event"], ["events", "Event"], ["htmlevents", "Event"],
  ["svgevents", "Event"], ["beforeunloadevent", "BeforeUnloadEvent"], ["compositionevent", "CompositionEvent"],
  ["devicemotionevent", "DeviceMotionEvent"], ["deviceorientationevent", "DeviceOrientationEvent"], ["dragevent", "DragEvent"],
  ["customevent", "CustomEvent"], ["uievent", "UIEvent"], ["uievents", "UIEvent"], ["mouseevent", "MouseEvent"],
  ["mouseevents", "MouseEvent"], ["keyboardevent", "KeyboardEvent"], ["focusevent", "FocusEvent"],
  ["messageevent", "MessageEvent"], ["hashchangeevent", "HashChangeEvent"], ["storageevent", "StorageEvent"],
  ["textevent", "TextEvent"], ["touchevent", "TouchEvent"]]);

function createLegacyEvent(receiver, type, count, definingRealm) {
  const intrinsics = definingRealm?.inputValueIntrinsics ?? {TypeError, DOMException};
  if (nodeOf(receiver)?.nodeType !== 9) throw new intrinsics.TypeError('Illegal invocation');
  if (!count) throw new intrinsics.TypeError('createEvent requires an interface name');
  type = encodingString(type, (_name, message) => new intrinsics.TypeError(message));
  const name = CREATE_EVENT_TYPES.get(type.replace(/[A-Z]/g, character => character.toLowerCase()));
  const event = name && realmOf(receiver).createLegacyEvent?.(name);
  if (!event) throw new intrinsics.DOMException(`The provided event type ("${type}") is invalid.`, 'NotSupportedError');
  markEventUninitialized(EventBinding.unwrap(event));
  return event;
}

export function installLegacyEventFactory(prototype, realm) {
  Object.defineProperty(prototype, 'createEvent', {configurable:true, enumerable:true, writable:true,
    value: {createEvent(type) {return createLegacyEvent(this, type, arguments.length, realm);}}.createEvent});
}

const UI_EVENT_TYPES = ["AnimationEvent", "UIEvent", "MouseEvent", "PointerEvent", "WheelEvent", "KeyboardEvent", "FocusEvent", "InputEvent"];
const UI_EVENT_FIELDS = [
  ...["detail", "clientX", "clientY", "screenX", "screenY", "button", "buttons", "deltaX", "deltaY", "deltaZ", "deltaMode",
    "pointerId", "width", "height", "pressure", "location", "keyCode", "which", "charCode", "elapsedTime"].map((key) => [key, Number]),
  ...["key", "code", "data", "inputType", "pointerType", "animationName", "pseudoElement"].map((key) => [key, String]),
  ...["ctrlKey", "altKey", "shiftKey", "metaKey", "repeat", "isComposing", "isPrimary"].map((key) => [key, Boolean]),
];

/** Install keyboard members after the page's intrinsic error constructors exist. */
export function installKeyboardEventMethods(realm) {
  const global = realm.hooks.pageGlobal();
  const conversionRealm = {hooks:{pageGlobal:() => realm.inputValueIntrinsics}};
  installKeyboardEventInterface({global, prototype:realm.eventPrototypes.get('KeyboardEvent'),
    read(receiver) {
      const event = EventBinding.unwrap(receiver);
      return event instanceof realm.window.KeyboardEvent ? event : null;
    },
    initialize:EventBinding.initializeKeyboard,
    unsignedLong:value => bindingNumber(value, conversionRealm, 'KeyboardEvent location') >>> 0,
  });
}

/** Page-constructible Event, CustomEvent and UI event classes. */
export function eventConstructors(realm, {secure = false} = {}) {
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
  // Members moved to UI event subclasses must not remain inherited through
  // the frozen engine binding. Plain Events allow expandos such as React's
  // afterblur.relatedTarget, and Event.prototype directly inherits Object.
  realm.eventPrototype = mutableBindingPrototype(EventBinding.prototype, Object.prototype);
  Object.defineProperty(realm.eventPrototype, "constructor", { value: Event, writable: true, configurable: true });
  Event.prototype = realm.eventPrototype;
  for (const [name, value] of Object.entries(EVENT_PHASES)) {
    Object.defineProperty(Event, name, { value, enumerable: true });
    Object.defineProperty(realm.eventPrototype, name, { value, enumerable: true });
  }
  // The event interfaces (UI Events, HTML): each its own prototype, with its
  // members moved off the shared binding prototype onto it.
  realm.eventPrototypes = new Map([["Event", realm.eventPrototype]]);
  const moved = new Set();
  for (const [name, [parentName, members]] of Object.entries(EVENT_INTERFACES)) {
    const prototype = Object.create(realm.eventPrototypes.get(parentName));
    for (const member of members) {
      const descriptor = Object.getOwnPropertyDescriptor(realm.eventPrototype, member);
      if (!descriptor) continue;
      Object.defineProperty(prototype, member, descriptor);
      moved.add(member);
    }
    Object.defineProperty(prototype, Symbol.toStringTag, { value: name, configurable: true });
    realm.eventPrototypes.set(name, prototype);
  }
  for (const member of moved) delete realm.eventPrototype[member];
  // An own property of each event instead (see RealmBindings.wrapEvent).
  delete realm.eventPrototype.isTrusted;
  CustomEvent.prototype = realm.eventPrototypes.get("CustomEvent");
  Object.defineProperty(CustomEvent.prototype, "constructor", { value: CustomEvent, writable: true, configurable: true });
  // UI event subclasses: their init dictionaries are copied as primitives only
  // (view and relatedTarget are dropped).
  function DragEvent(type, options = {}) {
    if (!new.target) throw new TypeError("Constructor DragEvent requires 'new'");
    const data=options?.dataTransfer ?? null;
    if(data!==null && !(data instanceof DataTransfer))throw new TypeError("Invalid dataTransfer");
    const fields={...init(options)};
    for(const [key,coerce] of UI_EVENT_FIELDS)if(options?.[key]!==undefined)fields[key]=coerce(options[key]);
    return realm.wrapEvent(dragEvent(window,String(type),fields,data));
  }
  DragEvent.prototype=realm.eventPrototypes.get('DragEvent');
  Object.defineProperty(DragEvent.prototype,'constructor',{value:DragEvent,writable:true,configurable:true});
  function ClipboardEvent(type, options = undefined) {
    if (!new.target) throw new TypeError("Constructor ClipboardEvent requires 'new'");
    if (!arguments.length) throw new TypeError("ClipboardEvent requires an event type");
    const data = options?.clipboardData ?? null;
    if (data !== null && !(data instanceof DataTransfer)) throw new TypeError("Invalid clipboardData");
    // Synthetic clipboard data stays inside the binding layer. Dispatching this
    // event must never grant access to the host clipboard or trigger a paste.
    const event = new window.Event(String(type), init(options));
    clipboardEventData.set(event, data);
    return realm.wrapEvent(event);
  }
  ClipboardEvent.prototype = realm.eventPrototypes.get("ClipboardEvent");
  Object.defineProperty(ClipboardEvent.prototype, "constructor", {value: ClipboardEvent, writable: true, configurable: true});
  const uiEvents = {DragEvent,DataTransfer,ClipboardEvent};
  for (const name of UI_EVENT_TYPES) {
    const RealEvent = window[name];
    if (typeof RealEvent !== "function") continue;
    const Constructor = function (type, options = undefined) {
      if (!new.target) throw new TypeError(`Constructor ${name} requires 'new'`);
      const fields = { ...init(options) };
      for (const [key, coerce] of UI_EVENT_FIELDS) {
        if (name === 'KeyboardEvent' && key === 'location') {
          const location = options?.location;
          if (location !== undefined) fields.location = bindingNumber(location,
            {hooks:{pageGlobal:() => realm.inputValueIntrinsics}}, 'KeyboardEvent location') >>> 0;
        } else if (options?.[key] !== undefined) fields[key] = coerce(options[key]);
      }
      return realm.wrapEvent(new RealEvent(String(type), fields));
    };
    Object.defineProperty(Constructor, "name", { value: name });
    Constructor.prototype = realm.eventPrototypes.get(name) ?? realm.eventPrototype;
    Object.defineProperty(Constructor.prototype, "constructor", { value: Constructor, writable: true, configurable: true });
    uiEvents[name] = Constructor;
  }
  function MessageEvent(type, options = undefined) {
    if (!new.target) throw new TypeError("Constructor MessageEvent requires 'new'");
    return realm.messageEvent(type, {
      data: options?.data ?? null,
      origin: options?.origin ?? "",
      lastEventId: options?.lastEventId ?? "",
      source: options?.source ?? null,
      ports: Array.isArray(options?.ports) ? options.ports : [],
    }, init(options));
  }
  MessageEvent.prototype = realm.eventPrototypes.get("MessageEvent");
  Object.defineProperty(MessageEvent.prototype, "constructor", { value: MessageEvent, writable: true, configurable: true });
  function SubmitEvent(type, options = undefined) {
    if (!new.target) throw new TypeError("Constructor SubmitEvent requires 'new'");
    const submitter = options?.submitter == null ? null : nodeOf(options.submitter);
    if (submitter && submitter.nodeType !== 1) throw new TypeError("The submitter must be an element");
    return realm.wrapEvent(new window.SubmitEvent(String(type), { ...init(options), submitter }));
  }
  SubmitEvent.prototype = realm.eventPrototypes.get("SubmitEvent");
  Object.defineProperty(SubmitEvent.prototype, "constructor", { value: SubmitEvent, writable: true, configurable: true });
  // PromiseRejectionEvent (HTML §8.1.5.7): promise and reason stay page values in the binding.
  const rejections = new WeakMap();
  function PromiseRejectionEvent(type, options) {
    if (!new.target) throw new TypeError("Failed to construct 'PromiseRejectionEvent': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    if (arguments.length < 2) {
      throw new TypeError(`Failed to construct 'PromiseRejectionEvent': 2 arguments required, but only ${arguments.length} present.`);
    }
    if (options?.promise === undefined) {
      throw new TypeError("Failed to construct 'PromiseRejectionEvent': Failed to read the 'promise' property from 'PromiseRejectionEventInit': Required member is undefined.");
    }
    const wrapper = realm.wrapEvent(new window.Event(String(type), init(options)));
    Object.setPrototypeOf(wrapper, PromiseRejectionEvent.prototype);
    rejections.set(wrapper, { promise: options.promise, reason: options.reason });
    return wrapper;
  }
  PromiseRejectionEvent.prototype = Object.create(realm.eventPrototype, {
    constructor: { value: PromiseRejectionEvent, writable: true, configurable: true },
    promise: { get: Object.getOwnPropertyDescriptor({ get promise() { return rejections.get(this)?.promise; } }, "promise").get,
      enumerable: true, configurable: true },
    reason: { get: Object.getOwnPropertyDescriptor({ get reason() { return rejections.get(this)?.reason; } }, "reason").get,
      enumerable: true, configurable: true },
    [Symbol.toStringTag]: { value: "PromiseRejectionEvent", configurable: true },
  });
  const supplemental = supplementalEventInterfaces({realm, Event, UIEvent:uiEvents.UIEvent,
    unwrap:EventBinding.unwrap, initialize:EventBinding.initializeLegacy, initializeUI:EventBinding.initializeLegacyUI,
    global:() => realm.inputValueIntrinsics ?? globalThis, secure, storageBrand:isStorage,
    targetBrand:value => pageEventTargets.has(value) || Boolean(nodeOf(value)) || isWindow(value)});
  const constructors = {Event, CustomEvent, MessageEvent, SubmitEvent, PromiseRejectionEvent,
    ...uiEvents, ...supplemental.constructors};
  realm.createLegacyEvent = name => supplemental.create(name)
    ?? (typeof constructors[name] === 'function' ? new constructors[name]('') : null);
  return constructors;
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
// ChildNode is shared by Element, CharacterData and DocumentType, not all Nodes.
for (const proto of [CharacterDataBinding.prototype, DocumentTypeBinding.prototype]) {
  for (const name of ['remove','before','after','replaceWith'])
    Object.defineProperty(proto, name, Object.getOwnPropertyDescriptor(ElementBinding.prototype, name));
}

const BINDINGS = [NodeBinding, AttrBinding, NamedNodeMapBinding, CharacterDataBinding, ProcessingInstructionBinding, DocumentTypeBinding, TextBinding, ParentBinding, FragmentBinding, ShadowRootBinding, ElementBinding,
  DocumentBinding, EventBinding, DataTransfer, ClassListBinding, TreeWalkerBinding, NodeIteratorBinding, RangeBinding];

// Members defined with Object.defineProperty({ get() {...} }) are named
// "get"; Web IDL names an attribute's accessors "get x" / "set x" and an
// operation after itself. Named here, while the functions are still mutable.
for (const Binding of BINDINGS) {
  for (const key of Reflect.ownKeys(Binding.prototype)) {
    if (key === "constructor") continue;
    const name = typeof key === "symbol" ? `[${key.description ?? ""}]` : key;
    const descriptor = Object.getOwnPropertyDescriptor(Binding.prototype, key);
    for (const [fn, expected] of [[descriptor.get, `get ${name}`], [descriptor.set, `set ${name}`], [descriptor.value, name]]) {
      if (typeof fn !== "function" || fn.name === expected) continue;
      if (Object.getOwnPropertyDescriptor(fn, "name")?.configurable !== false) {
        Object.defineProperty(fn, "name", { value: expected, configurable: true });
      }
    }
  }
}

export function hardenBindings() {
  if (typeof harden !== "function") return;
  for (const Binding of BINDINGS) harden(Binding);
}

/** Interface objects for `instanceof` checks; all throw "Illegal constructor" when called. */
export const INTERFACES = Object.freeze({
  Node: NodeBinding,
  Attr: AttrBinding,
  NamedNodeMap: NamedNodeMapBinding,
  CharacterData: CharacterDataBinding,
  ProcessingInstruction: ProcessingInstructionBinding,
  DocumentType: DocumentTypeBinding,
  Text: TextBinding,
  Element: ElementBinding,
  HTMLElement: ElementBinding,
  Document: DocumentBinding,
  HTMLDocument: DocumentBinding,
  DocumentFragment: FragmentBinding,
  ShadowRoot: ShadowRootBinding,
  TreeWalker: TreeWalkerBinding,
  NodeIterator: NodeIteratorBinding,
  DOMTokenList: ClassListBinding,
});
