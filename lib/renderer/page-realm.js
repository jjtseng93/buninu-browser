/**
 * The JavaScript environment of one document.
 *
 * In the default mode page scripts run in an SES Compartment whose global
 * object holds only DOM bindings and a curated set of Web APIs; the renderer
 * process must have called lockdown() first. With
 * --dangerously-allow-host-js ("host" mode) scripts run in the renderer's own
 * global scope instead, with full access to Bun.
 *
 * Scripts, timer callbacks and event listeners each run as a task. Errors in
 * a task are reported and never escape; after every task `afterTask()` lets
 * the renderer schedule style, layout and paint.
 */
import {
  BindingRealm, cssStyleDeclarationInterface, defineEventHandlerProperty, eventConstructors, eventTargetConstructor, hardenBindings, INTERFACES, mutableBindingPrototype, NodeFilter, nodeOf, rangeConstructor, windowEventMethods,
} from "./bindings.js";
import { resolveModuleSpecifier, transformModule } from "./module-transform.js";
import {
  CONSTRUCTOR_HELPER, DIRECT_EVAL_HELPER, DIRECT_EVAL_STRICT, escapeSesHtmlComments, prepareDirectEvalSource,
  restoreSourceText, rewriteClassicScript, THIS_HELPER,
  rewriteConstructorReads, rewriteDirectEval,
} from "./script-rewrite.js";
import { mediaQueryMatches, resolveVariables } from "../style/computed-style.js";
import { asIncumbent, createMessaging } from "./messaging.js";
import { canvasContext, resetCanvas } from "./canvas-2d.js";
import { createWorkers } from "./workers.js";
import { createMediaSourceScope } from "./media-source.js";
import { markNative, markNativeApi, setFunctionSourceTextTransform } from "./native-functions.js";
import { applyGlobalShape, platformObject, storageInterface } from "./interfaces.js";
import { AsyncLocalStorage } from "node:async_hooks";

// URL is one shared intrinsic, hardened before any page sees it. Blob URL
// creation is installed once and dispatched to the document whose task is
// running (AsyncLocalStorage, with the latest document as a fallback).
const blobUrlContext = new AsyncLocalStorage();
let blobUrlFallback = null;

function installBlobUrls() {
  const createObjectURL = function createObjectURL(object) {
    const scope = blobUrlContext.getStore() ?? blobUrlFallback;
    if (!scope) throw new TypeError("URL.createObjectURL is not available");
    return scope.create(object);
  };
  const revokeObjectURL = function revokeObjectURL(url) {
    const scope = blobUrlContext.getStore() ?? blobUrlFallback;
    scope?.revoke(url);
  };
  Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, writable: true, configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, writable: true, configurable: true });
}
installBlobUrls();

// Captured at load, before host mode can install page globals over them.
const hostSetTimeout = globalThis.setTimeout;
const hostClearTimeout = globalThis.clearTimeout;
const hostQueueMicrotask = globalThis.queueMicrotask;
const hostPerformance = globalThis.performance;
const hostCrypto = globalThis.crypto;
const hostStructuredClone = globalThis.structuredClone;
const hostAtob = globalThis.atob;
const hostBtoa = globalThis.btoa;

export const CLASSIC_SCRIPT_TYPES = new Set([
  "", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript",
  "application/x-javascript", "text/jscript", "text/livescript",
]);
const INLINE_HANDLER_EVENTS = [
  "click", "dblclick", "mousedown", "mouseup", "input", "change", "submit", "keydown", "keyup",
  "keypress", "beforeinput", "focus", "blur", "load",
];
const MAX_CONSOLE_ENTRIES = 500;
/**
 * Reflected content attributes (HTML §2.6.1) the engine does not implement
 * itself, per interface: name → [content attribute, "string" | "unsigned"].
 */
const REFLECTED_ATTRIBUTES = {
  HTMLImageElement: { name: ["name", "string"], lowsrc: ["lowsrc", "string"], align: ["align", "string"],
    longDesc: ["longdesc", "string"], border: ["border", "string"], hspace: ["hspace", "unsigned"],
    vspace: ["vspace", "unsigned"], fetchPriority: ["fetchpriority", "string"] },
};
/** Reflected attributes whose IDL type is a nullable string (HTML §2.6.1). */
const NULLABLE_STRING_ATTRIBUTES = new Set(["crossOrigin"]);
// Page functions print the source the page wrote, not the engine's rewrite of it.
setFunctionSourceTextTransform(restoreSourceText);
/**
 * Language globals every browser has that SES leaves out of compartments
 * (float arrays for the NaN side channel, WeakRef and FinalizationRegistry
 * for non-determinism, Atomics without SharedArrayBuffer, WebAssembly).
 * SharedArrayBuffer stays out: Chromium only exposes it to cross-origin
 * isolated documents.
 */
const HOST_LANGUAGE_GLOBALS = Object.fromEntries(["Float16Array", "Float32Array", "Float64Array", "WeakRef",
  "FinalizationRegistry", "Atomics", "WebAssembly"].filter((name) => globalThis[name] !== undefined)
  .map((name) => [name, globalThis[name]]));
/** Streams (WHATWG Streams, Compression Streams, Encoding streams), Bun's own implementations. */
const HOST_STREAM_GLOBALS = Object.fromEntries(["ReadableStream", "ReadableStreamDefaultReader",
  "ReadableStreamBYOBReader", "ReadableStreamDefaultController", "ReadableByteStreamController",
  "ReadableStreamBYOBRequest", "WritableStream", "WritableStreamDefaultWriter",
  "WritableStreamDefaultController", "TransformStream", "TransformStreamDefaultController",
  "ByteLengthQueuingStrategy", "CountQueuingStrategy", "TextEncoderStream", "TextDecoderStream",
  "CompressionStream", "DecompressionStream"].filter((name) => typeof globalThis[name] === "function")
  .map((name) => [name, globalThis[name]]));
// Element interfaces recognised by instanceof, by tag name.
const ELEMENT_INTERFACES = Object.freeze({
  HTMLAnchorElement: ["A"], HTMLAreaElement: ["AREA"], HTMLAudioElement: ["AUDIO"], HTMLBRElement: ["BR"],
  HTMLBaseElement: ["BASE"], HTMLBodyElement: ["BODY"], HTMLButtonElement: ["BUTTON"], HTMLCanvasElement: ["CANVAS"],
  HTMLDListElement: ["DL"], HTMLDetailsElement: ["DETAILS"], HTMLDialogElement: ["DIALOG"], HTMLDivElement: ["DIV"],
  HTMLEmbedElement: ["EMBED"], HTMLFieldSetElement: ["FIELDSET"], HTMLFormElement: ["FORM"], HTMLHRElement: ["HR"],
  HTMLHeadElement: ["HEAD"], HTMLHeadingElement: ["H1", "H2", "H3", "H4", "H5", "H6"], HTMLHtmlElement: ["HTML"],
  HTMLIFrameElement: ["IFRAME"], HTMLImageElement: ["IMG"], HTMLInputElement: ["INPUT"], HTMLLIElement: ["LI"],
  HTMLLabelElement: ["LABEL"], HTMLLegendElement: ["LEGEND"], HTMLLinkElement: ["LINK"], HTMLMapElement: ["MAP"],
  HTMLMediaElement: ["AUDIO", "VIDEO"], HTMLMetaElement: ["META"], HTMLMeterElement: ["METER"],
  HTMLOListElement: ["OL"], HTMLObjectElement: ["OBJECT"], HTMLOptGroupElement: ["OPTGROUP"], HTMLOptionElement: ["OPTION"],
  HTMLOutputElement: ["OUTPUT"], HTMLParagraphElement: ["P"], HTMLPictureElement: ["PICTURE"], HTMLPreElement: ["PRE"],
  HTMLProgressElement: ["PROGRESS"], HTMLQuoteElement: ["BLOCKQUOTE", "Q"], HTMLScriptElement: ["SCRIPT"],
  HTMLSelectElement: ["SELECT"], HTMLSlotElement: ["SLOT"], HTMLSourceElement: ["SOURCE"], HTMLSpanElement: ["SPAN"],
  HTMLStyleElement: ["STYLE"], HTMLTableCellElement: ["TD", "TH"], HTMLTableElement: ["TABLE"], HTMLTableRowElement: ["TR"],
  HTMLTableSectionElement: ["THEAD", "TBODY", "TFOOT"], HTMLTemplateElement: ["TEMPLATE"], HTMLTextAreaElement: ["TEXTAREA"],
  HTMLTimeElement: ["TIME"], HTMLTitleElement: ["TITLE"], HTMLTrackElement: ["TRACK"], HTMLUListElement: ["UL"],
  HTMLVideoElement: ["VIDEO"],
});
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const LIFECYCLE_EVENT_TYPES = new Set(["load", "DOMContentLoaded", "readystatechange"]);
// window.on* handler properties (window.onerror has a different signature and is not modelled).
const WINDOW_HANDLER_EVENTS = [
  "load", "resize", "scroll", "keydown", "keyup", "keypress", "click", "message", "hashchange",
  "popstate", "beforeunload", "unload", "focus", "blur", "online", "offline",
];
const hostStorage = new Map();

function cssEscape(value) {
  const input = String(value);
  let output = "";
  for (let index = 0; index < input.length; index++) {
    const code = input.codePointAt(index);
    const character = String.fromCodePoint(code);
    if (code > 0xffff) index++;
    if (code === 0) { output += "\uFFFD"; continue; }
    if ((code >= 1 && code <= 31) || code === 127
      || (index === 0 && code >= 48 && code <= 57)
      || (index === 1 && input[0] === "-" && code >= 48 && code <= 57)) {
      output += `\\${code.toString(16)} `;
    } else if (index === 0 && character === "-" && input.length === 1) {
      output += "\\-";
    } else if (code >= 128 || character === "-" || character === "_"
      || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      output += character;
    } else {
      output += `\\${character}`;
    }
  }
  return output;
}

/**
 * @param {{
 *   window: object, document: object, mode: "ses" | "host",
 *   hooks: {
 *     touch(node?: object, stateFeatures?: string[]): void, afterTask(): void,
 *     boundsOf(element: object): { left: number, top: number, width: number, height: number } | null,
 *     viewport(): { width: number, height: number, scrollX: number, scrollY: number, devicePixelRatio: number },
 *     scrollTo(x: number, y: number): void,
 *     computedStyle(element: object): object | null,
 *     customProperties?(element: object): Map<string, string> | null,
 *     navigate(url: string): void,
 *     activateLink?(anchor: object): void,
 *     fetchScript(url: string): Promise<string>,
 *     reportError(message: string): void,
 *     consoleMessage?: ((level: string, text: string) => void) | null,
 *     lifecycle?: (name: "DOMContentLoaded" | "load") => void,
 *     userAgent(): string,
 *   },
 * }} options
 */
export function createPageRealm({ window, document, mode, hooks }) {
  const timers = new Map();
  // Close functions of this document's open WebSockets (see networkApi)
  const openSockets = new Set();
  // Happy DOM runs its own document lifecycle and fires load/DOMContentLoaded
  // on its own schedule; only the lifecycle events this realm dispatches
  // reach page listeners (see acceptEvent).
  const lifecycleEvents = new WeakSet();
  // Script elements created by page code run when they are inserted;
  // parser-created and innerHTML-created ones never do (HTML "already started").
  const createdScripts = new WeakSet();
  const startedScripts = new WeakSet();
  // Scripts inserted before the load event delay it, as in HTML.
  const pendingLoads = new Set();
  const consoleEntries = [];
  let nextTimerId = 1;
  let disposed = false;
  let readyState = "loading";
  // A document gets a fresh high-resolution time origin. Bun's
  // performance.now() is relative to the renderer process, which is commonly
  // pre-warmed several seconds before navigation. Page timestamps must use
  // the document's timeline rather than include that pre-warm interval.
  const documentStarted = hostPerformance.now();
  const documentTimeOrigin = hostPerformance.timeOrigin + documentStarted;
  const pageNow = () => hostPerformance.now() - documentStarted;
  // Navigation Timing 1 (performance.timing): epoch milliseconds. Phases this
  // document has not reached yet read 0; fetch phases collapse onto the start.
  const timingStart = Math.round(documentTimeOrigin);
  const timingMarks = { domLoading: Math.round(documentTimeOrigin) };
  const markTiming = (...names) => {
    const now = Math.round(documentTimeOrigin + pageNow());
    for (const name of names) timingMarks[name] = now;
  };
  let parsingHead = false;
  let currentScript = null;
  let pageGlobal = null;
  let evaluate;
  let evaluateModuleCode;
  let importMap = null;
  const modules = new Map();
  const customElementConstructors = new Map();
  let constructingElement = null;
  let inlineModuleCount = 0;

  const reportError = (error, source = currentScript?.src) => {
    // SES "safe" error taming blanks .stack, so fall back to name and message.
    const detail = error?.stack || (error?.name ? `${error.name}: ${error.message}` : String(error?.message ?? error));
    const message = source ? `${source}: ${detail}` : detail;
    consoleEntries.push({ level: "error", text: message });
    hooks.reportError(message);
  };

  // The document's MediaSource registry. Assigned before any script runs;
  // runTask publishes it so URL.createObjectURL reaches this document.
  let mediaScope = null;

  /** Runs page code as a task: errors are reported, then the renderer may update. */
  const runTask = (task) => {
    if (disposed) return undefined;
    if (mediaScope) blobUrlFallback = mediaScope;
    try {
      return blobUrlContext.run(mediaScope, () => asIncumbent(hooks.frames?.self, task));
    } catch (error) {
      reportError(error);
      return undefined;
    } finally {
      hooks.afterTask();
    }
  };

  /** Calls a page function from the host (listeners, callbacks) without letting it throw out. */
  const callPage = (fn, thisArg, args) => {
    if (typeof fn !== "function") return undefined;
    try {
      return Reflect.apply(fn, thisArg, args);
    } catch (error) {
      reportError(error);
      return undefined;
    }
  };

  const realm = new BindingRealm(window, {
    touch: hooks.touch,
    boundsOf: hooks.boundsOf,
    computedStyle: hooks.computedStyle,
    // The engine clock's reading when this document's timeline started (see pageNow).
    timeOriginOffset: () => documentStarted,
    viewport: hooks.viewport,
    scrollTo: hooks.scrollTo,
    elementScroll: hooks.elementScroll,
    elementAt: hooks.elementAt,
    setElementScroll: hooks.setElementScroll,
    scrollIntoView: hooks.scrollIntoView,
    mediaState: hooks.mediaState,
    playMedia: hooks.playMedia,
    pauseMedia: hooks.pauseMedia,
    seekMedia: hooks.seekMedia,
    attachMediaSrc: (element, value) => hooks.attachMediaSrc?.(element, value),
    mediaReadyState: (element) => hooks.mediaReadyState?.(element) ?? 0,
    mediaNetworkState: (element) => hooks.mediaNetworkState?.(element) ?? 0,
    mediaError: (element) => hooks.mediaError?.(element) ?? null,
    mediaBuffered: (element) => hooks.mediaBuffered?.(element) ?? { length: 0, start: 0, end: 0 },
    call: callPage,
    readyState: () => readyState,
    body: () => parsingHead ? null : document.body,
    documentCookie: () => hooks.documentCookie?.() ?? "",
    setDocumentCookie: (value) => hooks.setDocumentCookie?.(value),
    currentScript: () => currentScript,
    pageGlobal: () => pageGlobal,
    targetOf: (real) => real === window ? pageGlobal : eventTargets.targetOf(real),
    created: (element) => {
      if (element.tagName === "SCRIPT") createdScripts.add(element);
    },
    inserted: (nodes) => startInsertedScripts(nodes),
    activateLink: (anchor) => hooks.activateLink?.(anchor),
    submitForm: (form, submitter) => hooks.submitForm?.(form, submitter),
    contentWindow: (node) => messaging.contentWindow(node),
    contentDocument: (node) => messaging.contentDocument(node),
    acceptEvent: (event) => !LIFECYCLE_EVENT_TYPES.has(event.type)
      || (event.target !== window && event.target !== document)
      || lifecycleEvents.has(event),
  });
  const eventTargets = eventTargetConstructor(realm,
    (value) => value === pageGlobal || Boolean(nodeOf(value)),
    (value) => value === pageGlobal ? window : nodeOf(value));
  const documentBinding = realm.wrap(document);
  const NodeInterface = function Node() { throw new TypeError("Illegal constructor"); };
  // Node.prototype inherits EventTarget.prototype (DOM §4.4), as Window.prototype does.
  NodeInterface.prototype = mutableBindingPrototype(INTERFACES.Node.prototype, eventTargets.EventTarget.prototype);
  const WindowInterface = function Window() { throw new TypeError("Illegal constructor"); };
  WindowInterface.prototype = Object.create(eventTargets.EventTarget.prototype);
  Object.defineProperty(WindowInterface.prototype, "constructor", { value: WindowInterface, writable: true, configurable: true });
  Object.defineProperty(WindowInterface, Symbol.hasInstance, { value: (value) => value === pageGlobal });
  Object.defineProperty(NodeInterface.prototype, "constructor", { value: NodeInterface, writable: true, configurable: true });
  // Node.ELEMENT_NODE, Node.DOCUMENT_POSITION_FOLLOWING, ...
  for (const name of Object.keys(INTERFACES.Node)) {
    if (/^[A-Z_]+$/.test(name)) Object.defineProperty(NodeInterface, name, { value: INTERFACES.Node[name], enumerable: true });
  }
  realm.nodePrototype = NodeInterface.prototype;
  const parentPrototype = mutableBindingPrototype(Object.getPrototypeOf(INTERFACES.Element.prototype), NodeInterface.prototype);
  // The ParentNode mixin's members (children, querySelector, append, ...) are
  // own properties of Element.prototype, Document.prototype and
  // DocumentFragment.prototype, as WebIDL places them: ShadyDOM saves the
  // native accessors with Object.getOwnPropertyDescriptor on each of them.
  const withParentNodeMembers = (prototype) => {
    for (const key of Reflect.ownKeys(parentPrototype)) {
      if (key !== "constructor" && !Object.hasOwn(prototype, key)) {
        Object.defineProperty(prototype, key, Object.getOwnPropertyDescriptor(parentPrototype, key));
      }
    }
    return prototype;
  };
  const ElementInterface = function Element() { throw new TypeError("Illegal constructor"); };
  ElementInterface.prototype = withParentNodeMembers(mutableBindingPrototype(INTERFACES.Element.prototype, parentPrototype));
  Object.defineProperty(ElementInterface.prototype, "constructor", { value: ElementInterface, writable: true, configurable: true });
  const HTMLElementInterface = function HTMLElement() {
    if (!new.target || !constructingElement) throw new TypeError("Illegal constructor");
    return realm.wrap(constructingElement);
  };
  HTMLElementInterface.prototype = mutableBindingPrototype(ElementInterface.prototype);
  Object.defineProperty(HTMLElementInterface.prototype, "constructor", { value: HTMLElementInterface, writable: true, configurable: true });
  realm.elementPrototype = HTMLElementInterface.prototype;
  // HTMLDivElement.prototype, HTMLSlotElement.prototype, ...: each HTML
  // element's wrapper inherits its interface's prototype, so what a page adds
  // there (ShadyDOM patches HTMLSlotElement.prototype) reaches its elements.
  const elementInterfacePrototypes = new Map();
  const tagPrototypes = new Map();
  const mediaPrototype = Object.create(HTMLElementInterface.prototype);
  elementInterfacePrototypes.set("HTMLMediaElement", mediaPrototype);
  for (const [name, tags] of Object.entries(ELEMENT_INTERFACES)) {
    if (name === "HTMLMediaElement") continue;
    const prototype = Object.create(tags.every((tag) => ELEMENT_INTERFACES.HTMLMediaElement.includes(tag))
      ? mediaPrototype : HTMLElementInterface.prototype);
    elementInterfacePrototypes.set(name, prototype);
    for (const tag of tags) tagPrototypes.set(tag, prototype);
  }
  realm.elementPrototypeOf = (node) =>
    (node.namespaceURI === HTML_NAMESPACE && tagPrototypes.get(node.tagName)) || HTMLElementInterface.prototype;
  for (const [name, attributes] of Object.entries(REFLECTED_ATTRIBUTES)) {
    const prototype = elementInterfacePrototypes.get(name);
    for (const [key, [attribute, type]] of Object.entries(attributes)) {
      const read = (element) => {
        const value = nodeOf(element).getAttribute(attribute);
        if (type === "string") return attribute === "fetchpriority" ? (["high", "low"].includes(value) ? value : "auto") : value ?? "";
        const number = /^\s*\d+/.exec(value ?? "") ? Number.parseInt(value, 10) : 0;
        return number >= 0 && number <= 2147483647 ? number : 0;
      };
      Object.defineProperty(prototype, key, {
        configurable: true,
        enumerable: true,
        get: Object.getOwnPropertyDescriptor({ get [key]() { return read(this); } }, key).get,
        set: Object.getOwnPropertyDescriptor({ set [key](value) {
          nodeOf(this).setAttribute(attribute, String(type === "unsigned" ? Number(value) >>> 0 : value));
          realm.hooks.touch(nodeOf(this));
        } }, key).set,
      });
    }
  }
  // Interface-specific attributes Happy DOM implements (HTMLImageElement's
  // complete, naturalWidth, useMap, decoding...): each interface prototype
  // gets an accessor reading and writing the node. Only attributes whose
  // values are primitives are exposed this way; an engine object never
  // reaches the page through them.
  for (const [name, tags] of Object.entries(ELEMENT_INTERFACES)) {
    const prototype = elementInterfacePrototypes.get(name);
    const EngineInterface = window[name];
    if (!prototype || typeof EngineInterface !== "function" || !tags.length) continue;
    let sample;
    let sampleWrapper;
    try {
      sample = document.createElement(tags[0].toLowerCase());
      sampleWrapper = Object.setPrototypeOf(realm.wrap(sample), prototype);
    } catch {
      continue;
    }
    const stop = window.HTMLElement?.prototype;
    for (let engine = EngineInterface.prototype; engine && engine !== stop; engine = Object.getPrototypeOf(engine)) {
      for (const key of Object.getOwnPropertyNames(engine)) {
        if (key === "constructor" || /^on/.test(key) || Object.hasOwn(prototype, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(engine, key);
        if (!descriptor?.get) continue;
        let value;
        try {
          value = descriptor.get.call(sample);
        } catch {
          continue;
        }
        // null is only a value of nullable string attributes; elsewhere it stands for an object.
        if (value === null ? !NULLABLE_STRING_ATTRIBUTES.has(key) : !["string", "number", "boolean"].includes(typeof value)) continue;
        // The bindings' own members (contentWindow, value, ...) stay, unless
        // they are another element's and read undefined here (img.name).
        if (key in prototype) {
          let own;
          try {
            own = Reflect.get(prototype, key, sampleWrapper);
          } catch {
            continue;
          }
          if (own !== undefined) continue;
        }
        const { get, set } = descriptor;
        Object.defineProperty(prototype, key, {
          configurable: true,
          enumerable: true,
          get: Object.getOwnPropertyDescriptor({ get [key]() {
            const result = get.call(nodeOf(this));
            return result === null || ["string", "number", "boolean"].includes(typeof result) ? result : null;
          } }, key).get,
          set: set ? Object.getOwnPropertyDescriptor({ set [key](next) {
            const node = nodeOf(this);
            set.call(node, next === null || typeof next !== "object" ? next : String(next));
            realm.hooks.touch(node);
          } }, key).set : undefined,
        });
      }
    }
  }
  // HTMLCanvasElement width/height are the bitmap size (default 300×150), and
  // getContext("2d") is how pages sample colours and draw. Other elements do
  // not inherit these.
  const canvasPrototype = elementInterfacePrototypes.get("HTMLCanvasElement");
  for (const name of ["width", "height"]) {
    Object.defineProperty(canvasPrototype, name, {
      configurable: true,
      enumerable: true,
      get() {
        return nodeOf(this)[name];
      },
      set(value) {
        const node = nodeOf(this);
        node[name] = value >>> 0;
        resetCanvas(node);
        realm.hooks.touch(node);
      },
    });
  }
  Object.defineProperty(canvasPrototype, "getContext", {
    configurable: true,
    enumerable: true,
    writable: true,
    value(type) {
      return canvasContext(nodeOf(this), String(type));
    },
  });
  // HTMLMediaElement. HAVE_* / NETWORK_* / MEDIA_ERR_* live on the prototype
  // and on the interface object (feature checks read either place).
  const MEDIA_CONSTANTS = {
    HAVE_NOTHING: 0, HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2, HAVE_FUTURE_DATA: 3, HAVE_ENOUGH_DATA: 4,
    NETWORK_EMPTY: 0, NETWORK_IDLE: 1, NETWORK_LOADING: 2, NETWORK_NO_SOURCE: 3,
    MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
  };
  for (const [name, value] of Object.entries(MEDIA_CONSTANTS)) {
    Object.defineProperty(mediaPrototype, name, { value, enumerable: true });
  }
  const mediaSrcObjects = new WeakMap();
  const mediaTimeRanges = (range) => ({
    length: range.length,
    start(index) {
      if (index !== 0 || !range.length) throw new DOMException("The index provided is out of range.", "IndexSizeError");
      return range.start;
    },
    end(index) {
      if (index !== 0 || !range.length) throw new DOMException("The index provided is out of range.", "IndexSizeError");
      return range.end;
    },
  });
  for (const [name, get] of Object.entries({
    readyState: (node) => realm.hooks.mediaReadyState?.(node) ?? 0,
    networkState: (node) => realm.hooks.mediaNetworkState?.(node) ?? 0,
    error: (node) => realm.hooks.mediaError?.(node) ?? null,
    buffered: (node) => mediaTimeRanges(realm.hooks.mediaBuffered?.(node) ?? { length: 0, start: 0, end: 0 }),
  })) {
    Object.defineProperty(mediaPrototype, name, {
      configurable: true,
      enumerable: true,
      get() {
        return get(nodeOf(this));
      },
    });
  }
  const videoPrototype = elementInterfacePrototypes.get("HTMLVideoElement");
  for (const name of ["videoWidth", "videoHeight"]) {
    Object.defineProperty(videoPrototype, name, {
      configurable: true,
      enumerable: true,
      get() {
        return realm.hooks.mediaState?.(nodeOf(this))?.[name] ?? 0;
      },
    });
  }
  Object.defineProperty(mediaPrototype, "srcObject", {
    configurable: true,
    enumerable: true,
    get() {
      return mediaSrcObjects.get(this) ?? null;
    },
    set(value) {
      mediaSrcObjects.set(this, value);
      realm.hooks.attachMediaSrc?.(nodeOf(this), value);
    },
  });
  const TextInterface = function Text() { throw new TypeError("Illegal constructor"); };
  const CharacterDataInterface = function CharacterData() { throw new TypeError("Illegal constructor"); };
  CharacterDataInterface.prototype = mutableBindingPrototype(INTERFACES.CharacterData.prototype, NodeInterface.prototype);
  Object.defineProperty(CharacterDataInterface.prototype, "constructor", { value: CharacterDataInterface, writable: true, configurable: true });
  realm.characterDataPrototype = CharacterDataInterface.prototype;
  TextInterface.prototype = mutableBindingPrototype(INTERFACES.Text.prototype, CharacterDataInterface.prototype);
  Object.defineProperty(TextInterface.prototype, "constructor", { value: TextInterface, writable: true, configurable: true });
  realm.textPrototype = TextInterface.prototype;
  const DocumentFragmentInterface = function DocumentFragment() { throw new TypeError("Illegal constructor"); };
  DocumentFragmentInterface.prototype = withParentNodeMembers(mutableBindingPrototype(INTERFACES.DocumentFragment.prototype, parentPrototype));
  Object.defineProperty(DocumentFragmentInterface.prototype, "constructor", { value: DocumentFragmentInterface, writable: true, configurable: true });
  realm.fragmentPrototype = DocumentFragmentInterface.prototype;
  realm.shadowRootPrototype = mutableBindingPrototype(INTERFACES.ShadowRoot.prototype, DocumentFragmentInterface.prototype);
  const DocumentInterface = function Document() { throw new TypeError("Illegal constructor"); };
  DocumentInterface.prototype = withParentNodeMembers(mutableBindingPrototype(INTERFACES.Document.prototype, parentPrototype));
  Object.defineProperty(DocumentInterface.prototype, "constructor", { value: DocumentInterface, writable: true, configurable: true });
  Object.setPrototypeOf(documentBinding, DocumentInterface.prototype);

  /** In an iframe's document, parent and top are the embedding frames' windows. */
  const defineFrameWindows = (global) => {
    const parent = messaging.parent;
    const top = messaging.top;
    if (parent) Object.defineProperty(global, "parent", { value: parent, writable: true, configurable: true });
    if (top) Object.defineProperty(global, "top", { value: top, writable: true, configurable: true });
    Object.defineProperty(global, "frames", { value: messaging.framesOf(global), writable: true, configurable: true });
    // window.name is the frame's (browsing context's) name.
    const self = hooks.frames?.self;
    let ownName = "";
    Object.defineProperty(global, "name", {
      get: () => self ? self.name() : ownName,
      set: (value) => {
        if (self) self.setName(value);
        else ownName = String(value);
      },
      enumerable: true,
      configurable: true,
    });
  };

  const fireLifecycle = (target, event) => {
    lifecycleEvents.add(event);
    target.dispatchEvent(event);
  };

  const schedule = (handler, delay, args, repeat) => {
    const id = nextTimerId++;
    const callback = typeof handler === "function"
      ? () => callPage(handler, pageGlobal, args)
      : () => evaluate(String(handler), "timer");
    const fire = () => {
      if (!timers.has(id)) return;
      if (repeat) timers.set(id, hostSetTimeout(fire, Math.max(4, delay)));
      else timers.delete(id);
      runTask(callback);
    };
    timers.set(id, hostSetTimeout(fire, Math.max(0, Number(delay) || 0)));
    return id;
  };
  const cancel = (id) => {
    const handle = timers.get(Number(id));
    if (handle) hostClearTimeout(handle);
    timers.delete(Number(id));
  };

  const pageConsole = Object.fromEntries(["log", "info", "warn", "error", "debug", "trace"].map((level) => [
    level,
    (...args) => {
      const text = args.map(formatConsoleValue).join(" ");
      consoleEntries.push({ level, text });
      if (consoleEntries.length > MAX_CONSOLE_ENTRIES) consoleEntries.shift();
      hooks.consoleMessage?.(level, text);
    },
  ]));
  // Each console method is its own function, as in browsers (and each prints
  // its own name). Grouping, timing and counting log a line or nothing.
  for (const name of ["table", "dir", "dirxml", "group", "groupCollapsed"]) {
    pageConsole[name] = (...args) => pageConsole.log(...args);
  }
  for (const name of ["groupEnd", "clear", "profile", "profileEnd", "timeStamp"]) pageConsole[name] = () => {};
  const consoleCounts = new Map();
  const consoleTimers = new Map();
  pageConsole.count = (label = "default") => {
    const count = (consoleCounts.get(String(label)) ?? 0) + 1;
    consoleCounts.set(String(label), count);
    pageConsole.info(`${label}: ${count}`);
  };
  pageConsole.countReset = (label = "default") => { consoleCounts.delete(String(label)); };
  pageConsole.time = (label = "default") => { consoleTimers.set(String(label), hostPerformance.now()); };
  pageConsole.timeLog = (label = "default", ...args) => {
    const start = consoleTimers.get(String(label));
    if (start !== undefined) pageConsole.info(`${label}: ${hostPerformance.now() - start} ms`, ...args);
  };
  pageConsole.timeEnd = (label = "default") => {
    pageConsole.timeLog(label);
    consoleTimers.delete(String(label));
  };
  pageConsole.assert = (condition, ...args) => {
    if (!condition) pageConsole.error("Assertion failed:", ...args);
  };
  Object.defineProperty(pageConsole, Symbol.toStringTag, { value: "console", configurable: true });

  /**
   * MutationObserver wraps Happy DOM's implementation (records carry node
   * wrappers); Resize- and IntersectionObserver report the current layout
   * once per observed element, which is enough for common lazy-loading and
   * sizing code in a headless viewport.
   */
  function observerConstructors() {
    function MutationObserver(callback) {
      if (!new.target) throw new TypeError("Constructor MutationObserver requires 'new'");
      const self = {};
      const wrapRecord = (record) => ({
        type: record.type,
        target: realm.wrap(record.target),
        addedNodes: realm.wrapAll(record.addedNodes),
        removedNodes: realm.wrapAll(record.removedNodes),
        previousSibling: realm.wrap(record.previousSibling),
        nextSibling: realm.wrap(record.nextSibling),
        attributeName: record.attributeName ?? null,
        oldValue: record.oldValue ?? null,
      });
      const real = new window.MutationObserver((records) => {
        runTask(() => callPage(callback, self, [records.map(wrapRecord), self]));
      });
      self.observe = (target, options = {}) => {
        const node = nodeOf(target);
        if (!node) throw new TypeError("MutationObserver.observe requires a Node");
        real.observe(node, {
          childList: Boolean(options.childList),
          attributes: Boolean(options.attributes ?? options.attributeFilter ?? options.attributeOldValue),
          characterData: Boolean(options.characterData ?? options.characterDataOldValue),
          subtree: Boolean(options.subtree),
          attributeOldValue: Boolean(options.attributeOldValue),
          characterDataOldValue: Boolean(options.characterDataOldValue),
          ...(Array.isArray(options.attributeFilter) ? { attributeFilter: options.attributeFilter.map(String) } : {}),
        });
      };
      self.disconnect = () => real.disconnect();
      self.takeRecords = () => real.takeRecords().map(wrapRecord);
      return self;
    }

    const layoutObserver = (name, entryFor) => function Observer(callback) {
      if (!new.target) throw new TypeError(`Constructor ${name} requires 'new'`);
      const self = {};
      const observed = new Set();
      self.observe = (target) => {
        const node = nodeOf(target);
        if (!node || observed.has(node)) return;
        observed.add(node);
        schedule(() => {
          if (!observed.has(node)) return;
          const rect = hooks.boundsOf(node) ?? { left: 0, top: 0, width: 0, height: 0 };
          callPage(callback, self, [[entryFor(target, rect)], self]);
        }, 0, [], false);
      };
      self.unobserve = (target) => observed.delete(nodeOf(target));
      self.disconnect = () => observed.clear();
      self.takeRecords = () => [];
      return self;
    };
    const rectangle = ({ left, top, width, height }) => ({
      x: left, y: top, left, top, width, height, right: left + width, bottom: top + height,
    });
    const ResizeObserver = layoutObserver("ResizeObserver", (target, rect) => ({
      target,
      contentRect: rectangle({ ...rect, left: 0, top: 0 }),
      borderBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
      contentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
    }));
    const IntersectionObserver = layoutObserver("IntersectionObserver", (target, rect) => {
      const { width, height } = hooks.viewport();
      const visible = rect.top < height && rect.top + rect.height > 0 && rect.left < width && rect.left + rect.width > 0;
      return {
        target,
        time: pageNow(),
        isIntersecting: visible,
        intersectionRatio: visible ? 1 : 0,
        boundingClientRect: rectangle(rect),
        intersectionRect: rectangle(visible ? rect : { left: 0, top: 0, width: 0, height: 0 }),
        rootBounds: rectangle({ left: 0, top: 0, width, height }),
      };
    });
    return { MutationObserver, ResizeObserver, IntersectionObserver };
  }

  /**
   * fetch() and XMLHttpRequest. Requests are described as plain data and
   * sent through the controller (cookies, CORS, redirects); data: and blob:
   * URLs are read locally. Bodies are normalised with Bun's Response, which
   * also yields the right Content-Type (multipart boundaries included).
   */
  /**
   * performance (High Resolution Time, User Timing 3): marks and measures the
   * page records, and PerformanceObserver for them. Other entry types
   * (resource, paint, long tasks) are not recorded; observers of them stay quiet.
   */
  function userTimingApi() {
    const entries = [];
    const observers = new Set();
    const SUPPORTED = Object.freeze(["mark", "measure"]);
    const entry = (entryType, name, startTime, duration, detail) => Object.freeze({
      entryType, name, startTime, duration, detail: detail ?? null,
      toJSON() { return { entryType, name, startTime, duration, detail: detail ?? null }; },
    });
    // Observers get their entries in a task of their own, batched.
    const schedule = (observer) => {
      if (observer.scheduled) return;
      observer.scheduled = true;
      hostSetTimeout(() => runTask(() => {
        observer.scheduled = false;
        const list = observer.buffer.splice(0);
        if (!list.length || !observers.has(observer)) return;
        callPage(observer.callback, observer.wrapper, [entryList(list), observer.wrapper]);
      }), 0);
    };
    const notify = (recorded) => {
      for (const observer of observers) {
        if (!observer.types.has(recorded.entryType)) continue;
        observer.buffer.push(recorded);
        schedule(observer);
      }
    };
    const record = (recorded) => {
      entries.push(recorded);
      if (entries.length > 10_000) entries.shift();
      notify(recorded);
      return recorded;
    };
    const markTime = (value, fallback) => {
      if (value === undefined || value === null) return fallback;
      if (typeof value === "number") return value;
      const found = entries.findLast((candidate) => candidate.entryType === "mark" && candidate.name === String(value));
      if (!found) throw new DOMException(`The mark '${value}' does not exist.`, "SyntaxError");
      return found.startTime;
    };
    const entryList = (list) => Object.freeze({
      getEntries: () => [...list],
      getEntriesByType: (type) => list.filter((candidate) => candidate.entryType === String(type)),
      getEntriesByName: (name, type = undefined) => list.filter((candidate) => candidate.name === String(name)
        && (type === undefined || candidate.entryType === String(type))),
    });
    const performance = {
      now: pageNow,
      timeOrigin: documentTimeOrigin,
      timing: navigationTiming(timingStart, timingMarks),
      navigation: Object.freeze({ type: 0, redirectCount: 0, TYPE_NAVIGATE: 0, TYPE_RELOAD: 1, TYPE_BACK_FORWARD: 2, TYPE_RESERVED: 255 }),
      mark(name, options = undefined) {
        return record(entry("mark", String(name), options?.startTime ?? pageNow(), 0, options?.detail));
      },
      measure(name, start = undefined, end = undefined) {
        const options = typeof start === "object" && start !== null ? start : null;
        const now = pageNow();
        const startTime = markTime(options ? options.start : start, 0);
        const endTime = options?.duration !== undefined && options.end === undefined
          ? startTime + Number(options.duration)
          : markTime(options ? options.end : end, now);
        return record(entry("measure", String(name), startTime, endTime - startTime, options?.detail));
      },
      clearMarks(name = undefined) {
        for (let index = entries.length - 1; index >= 0; index--) {
          if (entries[index].entryType === "mark" && (name === undefined || entries[index].name === String(name))) entries.splice(index, 1);
        }
      },
      clearMeasures(name = undefined) {
        for (let index = entries.length - 1; index >= 0; index--) {
          if (entries[index].entryType === "measure" && (name === undefined || entries[index].name === String(name))) entries.splice(index, 1);
        }
      },
      clearResourceTimings() {},
      setResourceTimingBufferSize() {},
      getEntries: () => [...entries],
      getEntriesByType: (type) => entries.filter((candidate) => candidate.entryType === String(type)),
      getEntriesByName: (name, type = undefined) => entries.filter((candidate) => candidate.name === String(name)
        && (type === undefined || candidate.entryType === String(type))),
      toJSON: () => ({ timeOrigin: documentTimeOrigin }),
    };
    function PerformanceObserver(callback) {
      if (!new.target) throw new TypeError("Constructor PerformanceObserver requires 'new'");
      if (typeof callback !== "function") throw new TypeError("PerformanceObserver: callback is not a function");
      const wrapper = this;
      const state = { callback, wrapper, types: new Set(), buffer: [], scheduled: false };
      Object.defineProperties(this, {
        observe: {
          value(options = {}) {
            const types = options.type !== undefined ? [String(options.type)] : [...(options.entryTypes ?? [])].map(String);
            for (const type of types) state.types.add(type);
            observers.add(state);
            if (options.buffered && options.type !== undefined) {
              for (const existing of entries) if (state.types.has(existing.entryType)) state.buffer.push(existing);
              if (state.buffer.length) schedule(state);
            }
          },
        },
        disconnect: { value() { observers.delete(state); state.buffer.length = 0; } },
        takeRecords: { value: () => state.buffer.splice(0) },
      });
    }
    Object.defineProperty(PerformanceObserver, "supportedEntryTypes", { value: SUPPORTED });
    return { performance, PerformanceObserver };
  }

  function networkApi() {
    const abortError = () => new DOMException("The operation was aborted.", "AbortError");
    const baseUrl = () => document.baseURI || document.URL;

    // new Request("/api") resolves against the document's base URL (Fetch
    // §5.4), which the host's Request has no document to do.
    const PageRequest = class Request extends globalThis.Request {
      constructor(input, init = undefined) {
        super(input instanceof globalThis.Request ? input : new URL(String(input), baseUrl()).href, init);
        // Fetch §5.4 step 36: a string body gives the request its Content-Type
        // (Bun's Request only does this for the other body kinds).
        if (typeof init?.body === "string" && !this.headers.has("content-type")) {
          this.headers.set("content-type", "text/plain;charset=UTF-8");
        }
      }
    };

    // fetch(request) reads the Request's internal state, as Chromium's
    // Request::CreateRequestWithRequestOrString does with GetRequest(). Page
    // script may shadow url, method or bodyUsed on the instance; that changes
    // what script reads, not what is fetched.
    const requestSlot = (name) => {
      const get = Object.getOwnPropertyDescriptor(globalThis.Request.prototype, name).get;
      return (request) => get.call(request);
    };
    const slots = Object.fromEntries(["url", "method", "headers", "mode", "credentials", "redirect", "signal", "bodyUsed"]
      .map((name) => [name, requestSlot(name)]));
    const cloneRequest = globalThis.Request.prototype.clone;
    /** The input when it is a platform Request (a brand check, not instanceof). */
    const platformRequest = (input) => {
      if (input === null || typeof input !== "object") return null;
      try {
        slots.url(input);
        return input;
      } catch {
        return null;
      }
    };

    async function describeRequest(input, init = {}) {
      const source = platformRequest(input);
      if (source && init.body === undefined && slots.bodyUsed(source)) {
        throw new TypeError("Cannot construct a Request with a Request object that has already been used.");
      }
      const url = new URL(source ? slots.url(source) : String(input), baseUrl());
      const method = String(init.method ?? (source ? slots.method(source) : "GET")).toUpperCase();
      const headers = new Headers(init.headers ?? (source ? slots.headers(source) : undefined));
      let body = null;
      const bodyInit = init.body !== undefined ? init.body : source && !["GET", "HEAD"].includes(method)
        ? await cloneRequest.call(source).arrayBuffer() : null;
      if (bodyInit !== null && bodyInit !== undefined) {
        if (["GET", "HEAD"].includes(method)) throw new TypeError("Request with GET/HEAD method cannot have body.");
        const normalized = new Response(bodyInit);
        // Read the derived Content-Type before consuming the body: after
        // lockdown, Bun no longer reports it once the body has been read.
        const type = normalized.headers.get("content-type")
          ?? (typeof bodyInit === "string" ? "text/plain;charset=UTF-8" : null);
        body = new Uint8Array(await normalized.arrayBuffer());
        if (type && !headers.has("content-type")) headers.set("content-type", type);
      }
      return {
        url: url.href,
        method,
        headers: [...headers],
        body,
        mode: init.mode ?? (source ? slots.mode(source) : "cors"),
        credentials: init.credentials ?? (source ? slots.credentials(source) : "same-origin"),
        redirect: init.redirect ?? (source ? slots.redirect(source) : "follow"),
        signal: init.signal ?? (source ? slots.signal(source) : null),
      };
    }

    function makeResponse(data) {
      const headers = new Headers(data.headers ?? []);
      const body = data.body instanceof ReadableStream ? data.body
        : data.body instanceof Uint8Array ? data.body : new Uint8Array(0);
      const native = new Response(body, { headers: { "content-type": headers.get("content-type") ?? "" } });
      const response = {
        type: data.type ?? "basic",
        url: data.url ?? "",
        redirected: Boolean(data.redirected),
        status: data.status ?? 200,
        ok: (data.status ?? 200) >= 200 && (data.status ?? 200) <= 299,
        statusText: data.statusText ?? "",
        headers,
        get bodyUsed() {
          return native.bodyUsed;
        },
        get body() {
          return native.body;
        },
        text: () => native.text(),
        json: () => native.json(),
        arrayBuffer: () => native.arrayBuffer(),
        blob: () => native.blob(),
        formData: () => native.formData(),
        bytes: () => native.bytes(),
        clone: () => {
          const copy = native.clone();
          return makeResponse({ ...data, body: copy.body });
        },
      };
      return response;
    }

    async function pageFetch(input, init = {}) {
      const request = await describeRequest(input, init ?? {});
      const signal = request.signal;
      if (signal?.aborted) throw abortError();
      const scheme = new URL(request.url).protocol;
      let pending;
      let networkPending = null;
      if (scheme === "data:" || scheme === "blob:") {
        const stored = scheme === "blob:" ? mediaScope?.lookup(request.url) : null;
        if (stored?.kind === "media-source") {
          pending = Promise.reject(new TypeError("Failed to fetch"));
        } else if (stored?.kind === "blob") {
          pending = stored.blob.arrayBuffer().then((buffer) => ({
            type: "basic", url: request.url, status: 200, statusText: "OK",
            headers: [["content-type", stored.blob.type || ""]],
            body: new Uint8Array(buffer),
          }));
        } else {
          pending = fetch(request.url).then(async (local) => ({
            type: "basic", url: request.url, status: local.status, statusText: local.statusText,
            headers: [...local.headers], body: new Uint8Array(await local.arrayBuffer()),
          }));
        }
      } else {
        const { signal: _signal, ...plain } = request;
        networkPending = hooks.pageFetch(plain);
        // Network and CORS failures reach the page as a bare TypeError, as in
        // browsers; the reason is only logged to the console.
        pending = networkPending.catch((error) => {
          const text = `fetch ${plain.url}: ${error?.message ?? error}`;
          consoleEntries.push({ level: "error", text });
          hooks.consoleMessage?.("error", text);
          throw new TypeError("Failed to fetch");
        });
      }
      const aborted = signal
        ? new Promise((_, reject) => signal.addEventListener("abort", () => {
          networkPending?.abort?.();
          reject(abortError());
        }, { once: true }))
        : null;
      const data = await (aborted ? Promise.race([pending, aborted]) : pending);
      hooks.afterTask();
      return makeResponse(data);
    }

    function XMLHttpRequest() {
      if (!new.target) throw new TypeError("Constructor XMLHttpRequest requires 'new'");
      const listeners = new Map();
      const requestHeaders = new Headers();
      let method = "GET";
      let url = null;
      let response = null;
      let controller = null;
      let timer = null;
      const xhr = {
        UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4,
        readyState: 0,
        status: 0,
        statusText: "",
        responseURL: "",
        responseType: "",
        response: null,
        responseText: "",
        responseXML: null,
        timeout: 0,
        withCredentials: false,
        upload: { addEventListener: () => {}, removeEventListener: () => {} },
        open(requestMethod, requestUrl, async = true) {
          if (async === false) {
            throw new DOMException("Synchronous XMLHttpRequest is not supported", "InvalidAccessError");
          }
          method = String(requestMethod).toUpperCase();
          url = new URL(String(requestUrl), baseUrl()).href;
          setState(1);
        },
        setRequestHeader(name, value) {
          requestHeaders.append(String(name), String(value));
        },
        getResponseHeader(name) {
          return response?.headers.get(String(name)) ?? null;
        },
        getAllResponseHeaders() {
          if (!response) return "";
          return [...response.headers].map(([name, value]) => `${name}: ${value}\r\n`).join("");
        },
        overrideMimeType() {},
        abort() {
          controller?.abort();
        },
        send(body = null) {
          if (xhr.readyState !== 1) throw new DOMException("The object's state must be OPENED.", "InvalidStateError");
          controller = new AbortController();
          if (xhr.timeout > 0) timer = schedule(() => controller.abort(), xhr.timeout, [], false);
          fire("loadstart");
          pageFetch(url, {
            method,
            headers: requestHeaders,
            body: ["GET", "HEAD"].includes(method) ? null : body,
            credentials: xhr.withCredentials ? "include" : "same-origin",
            signal: controller.signal,
          }).then(async (result) => {
            response = result;
            xhr.status = result.status;
            xhr.statusText = result.statusText;
            xhr.responseURL = result.url;
            setState(2);
            setState(3);
            const bytes = await result.arrayBuffer();
            const text = new TextDecoder().decode(bytes);
            xhr.responseText = ["", "text"].includes(xhr.responseType) ? text : "";
            xhr.response = xhr.responseType === "json" ? safeJson(text)
              : xhr.responseType === "arraybuffer" ? bytes
                : xhr.responseType === "blob" ? new Blob([bytes], { type: result.headers.get("content-type") ?? "" })
                  : text;
            setState(4);
            fire("load");
            fire("loadend");
          }, (error) => {
            xhr.status = 0;
            setState(4);
            fire(error?.name === "AbortError" ? (timer !== null && xhr.timeout > 0 ? "timeout" : "abort") : "error");
            fire("loadend");
          }).finally(() => {
            if (timer !== null) cancel(timer);
          });
        },
        addEventListener(type, listener) {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type).add(listener);
        },
        removeEventListener(type, listener) {
          listeners.get(type)?.delete(listener);
        },
        dispatchEvent() {
          return true;
        },
      };
      for (const type of ["readystatechange", "loadstart", "load", "loadend", "error", "abort", "timeout", "progress"]) {
        xhr[`on${type}`] = null;
      }
      function setState(state) {
        xhr.readyState = state;
        fire("readystatechange");
      }
      function fire(type) {
        const event = { type, target: xhr, currentTarget: xhr, loaded: 0, total: 0, lengthComputable: false };
        runTask(() => {
          if (typeof xhr[`on${type}`] === "function") callPage(xhr[`on${type}`], xhr, [event]);
          for (const listener of listeners.get(type) ?? []) callPage(listener, xhr, [event]);
        });
      }
      return xhr;
    }
    /**
     * WebSocket (WHATWG WebSockets): the connection is Bun's WebSocket in the
     * controller (hooks.webSockets); this side keeps the state machine and
     * fires the page's events.
     */
    function WebSocket(url, protocols = []) {
      if (!new.target) throw new TypeError("Constructor WebSocket requires 'new'");
      let target;
      try {
        target = new URL(String(url), baseUrl());
      } catch {
        throw new DOMException(`Failed to construct 'WebSocket': The URL '${url}' is invalid.`, "SyntaxError");
      }
      if (target.protocol === "http:") target.protocol = "ws:";
      else if (target.protocol === "https:") target.protocol = "wss:";
      if (!["ws:", "wss:"].includes(target.protocol) || target.hash) {
        throw new DOMException(`Failed to construct 'WebSocket': The URL '${target.href}' is invalid.`, "SyntaxError");
      }
      const list = typeof protocols === "string" ? [protocols] : [...protocols].map(String);
      if (new Set(list).size !== list.length || list.some((name) => !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name))) {
        throw new DOMException("Failed to construct 'WebSocket': The subprotocol is invalid.", "SyntaxError");
      }
      const listeners = new Map();
      let id = null;
      let sending = Promise.resolve();
      const socket = Object.create(WebSocket.prototype);
      Object.assign(socket, {
        CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3,
        url: target.href,
        readyState: 0,
        protocol: "",
        extensions: "",
        bufferedAmount: 0,
        binaryType: "blob",
        onopen: null, onmessage: null, onerror: null, onclose: null,
        send(data) {
          if (socket.readyState === 0) throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
          if (socket.readyState !== 1) return;
          if (typeof data === "string") {
            sending = sending.then(() => hooks.webSockets.send(id, data));
          } else if (data instanceof Blob) {
            sending = sending.then(async () => hooks.webSockets.send(id, new Uint8Array(await data.arrayBuffer())));
          } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
            const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            const copy = view.slice();
            sending = sending.then(() => hooks.webSockets.send(id, copy));
          } else {
            const text = String(data);
            sending = sending.then(() => hooks.webSockets.send(id, text));
          }
        },
        close(code = undefined, reason = "") {
          if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) {
            throw new DOMException(`The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`, "InvalidAccessError");
          }
          if (new TextEncoder().encode(String(reason)).byteLength > 123) {
            throw new DOMException("The close reason must not be greater than 123 UTF-8 bytes.", "SyntaxError");
          }
          if (socket.readyState >= 2) return;
          socket.readyState = 2;
          sending.then(() => hooks.webSockets.close(id, code, String(reason)));
        },
        addEventListener(type, listener) {
          if (typeof listener !== "function" && typeof listener?.handleEvent !== "function") return;
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type).add(listener);
        },
        removeEventListener(type, listener) {
          listeners.get(type)?.delete(listener);
        },
        dispatchEvent(event) {
          fire(event.type, event);
          return true;
        },
      });
      function fire(type, fields = {}) {
        const event = { type, target: socket, currentTarget: socket, isTrusted: true, bubbles: false, cancelable: false,
          defaultPrevented: false, timeStamp: pageNow(), preventDefault() {}, stopPropagation() {},
          stopImmediatePropagation() {}, ...fields };
        runTask(() => {
          if (typeof socket[`on${type}`] === "function") callPage(socket[`on${type}`], socket, [event]);
          for (const listener of [...(listeners.get(type) ?? [])]) {
            if (typeof listener === "function") callPage(listener, socket, [event]);
            else callPage(listener.handleEvent, listener, [event]);
          }
        });
      }
      function onEvent(message) {
        if (disposed) return;
        if (message.event === "open" && socket.readyState === 0) {
          socket.readyState = 1;
          socket.protocol = String(message.protocol ?? "");
          socket.extensions = String(message.extensions ?? "");
          fire("open");
        } else if (message.event === "message" && socket.readyState === 1) {
          const { data } = message;
          const value = typeof data === "string" ? data
            : socket.binaryType === "arraybuffer" ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
              : new Blob([data]);
          fire("message", { data: value, origin: target.origin, lastEventId: "", source: null, ports: [] });
        } else if (message.event === "error") {
          fire("error");
        } else if (message.event === "close") {
          socket.readyState = 3;
          openSockets.delete(close);
          fire("close", { code: Number(message.code) || 1006, reason: String(message.reason ?? ""), wasClean: Boolean(message.wasClean) });
        }
      }
      const close = () => {
        if (socket.readyState < 2 && id !== null) hooks.webSockets.close(id, 1001, "");
      };
      if (!hooks.webSockets) {
        // No network: fail like an unreachable server.
        hostSetTimeout(() => onEvent({ event: "error" }) ?? onEvent({ event: "close", code: 1006 }), 0);
      } else {
        id = hooks.webSockets.open(target.href, list, onEvent);
        openSockets.add(close);
      }
      return socket;
    }
    Object.assign(WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

    XMLHttpRequest.UNSENT = 0;
    XMLHttpRequest.OPENED = 1;
    XMLHttpRequest.HEADERS_RECEIVED = 2;
    XMLHttpRequest.LOADING = 3;
    XMLHttpRequest.DONE = 4;

    return {
      // A plain function: Web IDL operations are not async functions.
      fetch: function fetch(input, init = undefined) { return pageFetch(input, init); },
      XMLHttpRequest,
      WebSocket,
      Headers,
      Request: PageRequest,
      Response,
      AbortController,
      AbortSignal,
      FormData,
      Blob,
      File,
      DOMException,
    };
  }

  /**
   * Interface objects that exist for `instanceof` and feature checks. Each
   * is an illegal constructor whose Symbol.hasInstance tests the real node.
   */
  function typeCheckInterfaces() {
    const make = (name, test) => {
      const Interface = function () {
        throw new TypeError("Illegal constructor");
      };
      Object.defineProperty(Interface, "name", { value: name });
      Object.defineProperty(Interface, Symbol.hasInstance, {
        value: (value) => {
          if (value === pageGlobal) return name === "Window" || name === "EventTarget";
          const node = nodeOf(value);
          return Boolean(node) && test(node);
        },
      });
      return Interface;
    };
    const interfaces = {
      Window: WindowInterface,
      EventTarget: eventTargets.EventTarget,
      Comment: make("Comment", (node) => node.nodeType === 8),
      CDATASection: make("CDATASection", (node) => node.nodeType === 4),
      ProcessingInstruction: make("ProcessingInstruction", (node) => node.nodeType === 7),
      DocumentType: make("DocumentType", (node) => node.nodeType === 10),
      ShadowRoot: make("ShadowRoot", (node) => node instanceof window.ShadowRoot),
      SVGElement: make("SVGElement", (node) => node.namespaceURI === SVG_NAMESPACE),
      SVGSVGElement: make("SVGSVGElement", (node) => node.namespaceURI === SVG_NAMESPACE && node.localName === "svg"),
      HTMLUnknownElement: make("HTMLUnknownElement", () => false),
    };
    for (const [name, tags] of Object.entries(ELEMENT_INTERFACES)) {
      const Interface = make(name, (node) => node.nodeType === 1 && tags.includes(node.tagName));
      Interface.prototype = elementInterfacePrototypes.get(name);
      Object.defineProperty(Interface.prototype, "constructor", { value: Interface, writable: true, configurable: true });
      if (name === "HTMLMediaElement") {
        for (const [constant, value] of Object.entries(MEDIA_CONSTANTS)) {
          Object.defineProperty(Interface, constant, { value, enumerable: true });
        }
      }
      interfaces[name] = Interface;
    }
    return interfaces;
  }

  class CSSRule {
    constructor(cssText = "") {
      this.cssText = String(cssText);
    }
  }
  class CSSStyleRule extends CSSRule {}
  class CSSGroupingRule extends CSSRule {}
  class CSSStyleSheet {
    constructor() {
      this.cssRules = [];
      this.disabled = false;
      this.href = null;
      this.media = { length: 0, mediaText: "", matches: () => false };
      this.ownerNode = null;
    }
    replaceSync(text) {
      const cssText = String(text);
      this.cssRules = cssText.trim() ? [new CSSStyleRule(cssText)] : [];
    }
    async replace(text) {
      this.replaceSync(text);
      return this;
    }
    insertRule(rule, index = this.cssRules.length) {
      const position = Number(index) >>> 0;
      if (position > this.cssRules.length) throw new DOMException("Index out of range", "IndexSizeError");
      this.cssRules.splice(position, 0, new CSSStyleRule(rule));
      return position;
    }
    deleteRule(index) {
      const position = Number(index) >>> 0;
      if (position >= this.cssRules.length) throw new DOMException("Index out of range", "IndexSizeError");
      this.cssRules.splice(position, 1);
    }
  }

  const origin = safeOrigin(document.URL);
  if (!hostStorage.has(origin)) hostStorage.set(origin, new Map());
  mediaScope = createMediaSourceScope({
    origin,
    DOMException,
    // Zero delay, as a page task, so listeners registered in the same turn
    // (right after appendBuffer or setting src) still run.
    schedule: (fn) => hostSetTimeout(() => runTask(fn), 0),
    onAppend: (source) => hooks.mediaAppended?.(source),
    onDuration: (source, duration) => hooks.mediaDuration?.(source, duration),
  });
  blobUrlFallback = mediaScope;

  const viewportValue = (key) => () => hooks.viewport()[key];
  const userAgent = hooks.userAgent();
  const chromeVersion = /(?:Chrome|Chromium)\/(\d+(?:\.\d+){0,3})/.exec(userAgent)?.[1] ?? "";
  const chromeMajor = chromeVersion.split(".")[0];
  const mobileUserAgent = /\bMobile\b/.test(userAgent);
  const uaBrands = Object.freeze([
    Object.freeze({ brand: "Not:A-Brand", version: "99" }),
    Object.freeze({ brand: "Chromium", version: chromeMajor }),
    Object.freeze({ brand: "Google Chrome", version: chromeMajor }),
  ]);
  const userAgentDataMembers = {
    brands: uaBrands,
    mobile: mobileUserAgent,
    platform: /Android/.test(userAgent) ? "Android" : /Windows/.test(userAgent) ? "Windows" : /Macintosh/.test(userAgent) ? "macOS" : "Linux",
    toJSON() { return { brands: uaBrands, mobile: mobileUserAgent, platform: this.platform }; },
    getHighEntropyValues(hints = []) {
      const values = this.toJSON();
      const available = {
        architecture: /(?:aarch64|arm64)/i.test(userAgent) ? "arm" : "x86",
        bitness: "64", model: "", platformVersion: "", uaFullVersion: chromeVersion,
        fullVersionList: uaBrands.map(({ brand, version }) => ({ brand, version: brand === "Not:A-Brand" ? version : chromeVersion })),
        wow64: false,
      };
      for (const hint of hints) if (Object.hasOwn(available, hint)) values[hint] = available[hint];
      return Promise.resolve(values);
    },
  };
  const { location, setHref } = locationBinding(document.URL, hooks.navigate);
  const { History, history, pushEntry } = historyBinding(location, setHref);
  const { Event, CustomEvent, ...uiEvents } = eventConstructors(realm);
  const observers = observerConstructors();
  const network = networkApi();
  const userTiming = userTimingApi();
  const windowEvents = windowEventMethods(realm, null);
  // postMessage, other frames' windows, MessageChannel (see messaging.js).
  const messaging = createMessaging({
    realm, window, pageGlobal: () => pageGlobal, runTask, callPage, DOMException, frames: hooks.frames ?? null,
  });

  const platform = platformObjects({
    eventTargets, userAgent, userAgentDataMembers, mobile: mobileUserAgent, viewport: hooks.viewport,
    performance: userTiming.performance, storages: { local: hostStorage.get(origin), session: new Map() },
    sendBeacon: (url, data) => {
      network.fetch(url, { method: "POST", body: data, mode: "no-cors", credentials: "include", keepalive: true })
        .catch(() => {});
      return true;
    },
  });

  /** Web APIs placed on the page's global object (bindings plus hardened host utilities). */
  const api = {
    document: documentBinding,
    location,
    navigator: platform.navigator,
    History,
    history,
    screen: platform.screen,
    visualViewport: platform.visualViewport,
    localStorage: platform.localStorage,
    sessionStorage: platform.sessionStorage,
    console: pageConsole,
    setTimeout: (handler, delay = 0, ...args) => schedule(handler, delay, args, false),
    setInterval: (handler, delay = 0, ...args) => schedule(handler, delay, args, true),
    clearTimeout: cancel,
    clearInterval: cancel,
    requestAnimationFrame: (callback) => schedule(() => callPage(callback, pageGlobal, [pageNow()]), 16, [], false),
    cancelAnimationFrame: cancel,
    requestIdleCallback: (callback) => schedule(
      () => callPage(callback, pageGlobal, [{ didTimeout: false, timeRemaining: () => 10 }]), 1, [], false),
    cancelIdleCallback: cancel,
    queueMicrotask: (callback) => hostQueueMicrotask(() => runTask(() => callPage(callback, pageGlobal, []))),
    structuredClone: (value) => hostStructuredClone(value),
    atob: (value) => hostAtob(String(value)),
    btoa: (value) => hostBtoa(String(value)),
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    // SES rewrites dynamic import() in evaluated classic scripts to this
    // hook. Resolve it through the same module loader and network boundary as
    // parser-inserted modules.
    __import__: (specifier) => importModule(String(specifier), currentScript?.src || document.URL),
    performance: platform.performance,
    PerformanceObserver: userTiming.PerformanceObserver,
    crypto: platform.crypto,
    ...platform.interfaces,
    CSSStyleDeclaration: cssStyleDeclarationInterface(realm),
    Event,
    CustomEvent,
    ...uiEvents,
    Range: rangeConstructor(realm),
    // new Audio(src): an <audio> element, not in the document (HTML §4.8.11).
    Audio: function Audio(src = undefined) {
      if (!new.target) throw new TypeError("Constructor Audio requires 'new'");
      const audio = documentBinding.createElement("audio");
      audio.setAttribute("preload", "auto");
      if (src !== undefined) audio.setAttribute("src", String(src));
      return audio;
    },
    MediaSource: mediaScope.MediaSource,
    SourceBuffer: mediaScope.SourceBuffer,
    ...observers,
    ...network,
    CSS: {
      escape: cssEscape,
      supports(property, value) {
        // The one-argument condition grammar is not modelled yet. Returning
        // false is the safe feature-detection result for unsupported syntax.
        if (value === undefined) return false;
        const name = String(property);
        const camel = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        const style = documentBinding.body?.style ?? documentBinding.documentElement?.style;
        return Boolean(style && (name in style || camel in style));
      },
    },
    CSSRule,
    CSSStyleRule,
    CSSGroupingRule,
    CSSStyleSheet,
    NodeFilter,
    // Collections are represented by snapshot arrays internally. Expose the
    // standard collection prototypes used by compatibility shims; their
    // Array methods are generic and work with those snapshots.
    NodeList: class NodeList extends Array {},
    HTMLCollection: class HTMLCollection extends Array {},
    Image: function Image(width, height) {
      if (!new.target) throw new TypeError("Constructor Image requires 'new'");
      const image = document.createElement("img");
      if (width !== undefined) image.setAttribute("width", String(width));
      if (height !== undefined) image.setAttribute("height", String(height));
      return realm.wrap(image);
    },
    customElements: {
      define(name, constructor) {
        const tag = String(name).toLowerCase();
        if (typeof constructor !== "function") throw new TypeError("Custom element constructor must be a function");
        if (customElementConstructors.has(tag)) throw new DOMException("Custom element already defined", "NotSupportedError");
        const Adapter = class extends window.HTMLElement {
          constructor() {
            super();
            const wrapper = realm.wrap(this);
            Object.setPrototypeOf(wrapper, constructor.prototype);
            const previous = constructingElement;
            constructingElement = this;
            try { Reflect.construct(constructor, []); }
            finally { constructingElement = previous; }
          }
          connectedCallback() {
            const wrapper = realm.wrap(this);
            if (typeof wrapper.connectedCallback === "function") callPage(wrapper.connectedCallback, wrapper, []);
          }
          disconnectedCallback() {
            const wrapper = realm.wrap(this);
            if (typeof wrapper.disconnectedCallback === "function") callPage(wrapper.disconnectedCallback, wrapper, []);
          }
        };
        window.customElements.define(tag, Adapter);
        customElementConstructors.set(tag, constructor);
        // Upgrades change :defined without a DOM mutation.
        hooks.definedChanged?.(tag);
      },
      get: (name) => customElementConstructors.get(String(name).toLowerCase()),
      whenDefined(name) {
        const tag = String(name).toLowerCase();
        return window.customElements.whenDefined(tag).then(() => customElementConstructors.get(tag));
      },
      upgrade(root) {
        const node = nodeOf(root);
        if (node) window.customElements.upgrade(node);
      },
    },
    ...INTERFACES,
    Node: NodeInterface,
    Text: TextInterface,
    CharacterData: CharacterDataInterface,
    Element: ElementInterface,
    HTMLElement: HTMLElementInterface,
    Document: DocumentInterface,
    HTMLDocument: DocumentInterface,
    DocumentFragment: DocumentFragmentInterface,
    ...typeCheckInterfaces(),
    addEventListener: windowEvents.addEventListener,
    removeEventListener: windowEvents.removeEventListener,
    dispatchEvent: windowEvents.dispatchEvent,
    getComputedStyle: (element) => {
      const node = nodeOf(element);
      const style = hooks.computedStyle(node);
      return computedStyleBinding(style, {
        custom: hooks.customProperties?.(node) ?? null,
        bounds: style && style.display !== "none" && node?.isConnected ? hooks.boundsOf(node) : null,
        element: node,
      });
    },
    getSelection: () => ({
      anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0,
      isCollapsed: true, rangeCount: 0, type: "None",
      addRange() {}, collapse() {}, collapseToEnd() {}, collapseToStart() {},
      containsNode: () => false, deleteFromDocument() {}, empty() {}, extend() {},
      getRangeAt: () => { throw new DOMException("Index out of range", "IndexSizeError"); },
      modify() {}, removeAllRanges() {}, removeRange() {}, selectAllChildren() {}, setBaseAndExtent() {},
      toString: () => "",
    }),
    matchMedia: (query) => {
      const { width, height, mobile } = hooks.viewport();
      return {
        media: String(query),
        matches: mediaQueryMatches(String(query), { width, height, mobile }),
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      };
    },
    scrollTo: (x, y) => scrollArguments(hooks, x, y, false),
    scroll: (x, y) => scrollArguments(hooks, x, y, false),
    scrollBy: (x, y) => scrollArguments(hooks, x, y, true),
    alert: () => {},
    confirm: () => false,
    prompt: () => null,
    print: () => {},
    focus: () => {},
    blur: () => {},
    close: () => {},
    open: () => null,
    postMessage: messaging.postMessage,
    MessageChannel: messaging.MessageChannel,
    MessagePort: messaging.MessagePort,
  };
  const accessors = {
    innerWidth: viewportValue("width"),
    innerHeight: viewportValue("height"),
    outerWidth: viewportValue("width"),
    outerHeight: viewportValue("height"),
    devicePixelRatio: viewportValue("devicePixelRatio"),
    scrollX: viewportValue("scrollX"),
    scrollY: viewportValue("scrollY"),
    pageXOffset: viewportValue("scrollX"),
    pageYOffset: viewportValue("scrollY"),
    // The number of child frames (window[i] is not provided).
    length: () => hooks.frames?.self.children().length ?? 0,
  };

  let workers = null;
  if (mode === "ses") {
    hardenBindings();
    // Dedicated workers get a compartment each, with these of the page's utilities.
    workers = createWorkers({
      realm, documentUrl: () => document.URL, fetchScript: hooks.fetchScript, runTask, callPage, reportError, DOMException,
      constructorHelper,
      pagePorts: messaging.ports,
      globals: Object.fromEntries(["console", "atob", "btoa", "TextEncoder", "TextDecoder", "URL", "URLSearchParams",
        "structuredClone", "performance", "crypto", "navigator", "fetch", "Headers", "Request", "Response", "Blob",
        "File", "FormData", "AbortController", "AbortSignal", "DOMException"]
        .filter((name) => api[name] !== undefined).map((name) => [name, api[name]])
        .concat([["Math", Math], ["Date", Date], ["Intl", Intl], ...Object.entries(HOST_LANGUAGE_GLOBALS)])),
    });
    api.Worker = workers.Worker;
    // Host utilities are hardened before a page can see them: the engine
    // itself uses URL, TextEncoder and Intl, so pages must not change them.
    for (const value of [TextEncoder, TextDecoder, URL, URLSearchParams, Intl, Headers, Request, Response,
      AbortController, AbortSignal, FormData, Blob, File, DOMException,
      ...Object.values(HOST_LANGUAGE_GLOBALS), ...Object.values(HOST_STREAM_GLOBALS)]) {
      harden(value);
    }
    // Everything in `api` is created per document; only shared host classes
    // (above) and the binding classes need hardening.
    const compartment = new Compartment({
      globals: { ...api, Math, Date, Intl, ...HOST_LANGUAGE_GLOBALS, ...HOST_STREAM_GLOBALS },
      __options__: true,
    });
    pageGlobal = compartment.globalThis;
    // SES's own globals are not Web APIs; a browser has none of them.
    // (__import__ stays, hidden: SES rewrites import() in classic scripts to it.)
    for (const name of ["Compartment", "harden", "lockdown", "assert"]) {
      if (Object.getOwnPropertyDescriptor(pageGlobal, name)?.configurable) delete pageGlobal[name];
    }
    Object.defineProperty(pageGlobal, "__import__", { enumerable: false });
    // window → Window.prototype → EventTarget.prototype, as in browsers.
    Object.setPrototypeOf(pageGlobal, WindowInterface.prototype);
    // Libraries wrap promise callbacks to propagate asynchronous context.
    // Give each page its own methods while keeping SES's shared intrinsic frozen.
    const PagePromise = compartment.evaluate("(class Promise extends globalThis.Promise {})");
    const IntrinsicPromise = pageGlobal.Promise;
    for (const name of ["then", "catch", "finally"]) {
      Object.defineProperty(PagePromise.prototype, name, {
        value: pageGlobal.Promise.prototype[name], writable: true, configurable: true,
      });
    }
    // async functions and host Web APIs still create intrinsic promises.
    Object.defineProperty(PagePromise, Symbol.hasInstance, {
      value(value) {
        return Function.prototype[Symbol.hasInstance].call(this === PagePromise ? IntrinsicPromise : this, value);
      }, configurable: true,
    });
    pageGlobal.Promise = PagePromise;
    // Namespace objects that libraries extend (reflect-metadata adds to
    // Reflect, polyfills to JSON and Math): each page gets its own mutable
    // copy with the same functions; the shared frozen intrinsics stay as they are.
    for (const name of ["Reflect", "JSON", "Math"]) {
      const shared = pageGlobal[name];
      const descriptors = Object.getOwnPropertyDescriptors(shared);
      for (const descriptor of Object.values(descriptors)) {
        descriptor.configurable = true;
        if ("value" in descriptor) descriptor.writable = true;
      }
      Object.defineProperty(pageGlobal, name, {
        value: Object.create(Object.getPrototypeOf(shared), descriptors), writable: true, configurable: true,
      });
    }
    const helper = constructorHelper(compartment);
    Object.defineProperty(pageGlobal, CONSTRUCTOR_HELPER, { value: helper });
    // Indirect eval runs code as a classic script does: in the global scope,
    // its var and function declarations becoming globals, and its own direct
    // evals rewritten. A method has no prototype, like the built-in.
    const pageEval = { eval(source) { return typeof source === "string" ? evaluate(source) : source; } }.eval;
    Object.defineProperty(pageGlobal, "eval", { value: markNative(pageEval, "eval"), writable: true, configurable: true });
    Object.defineProperty(pageGlobal, DIRECT_EVAL_HELPER, { value: directEvalHelper(compartment, pageGlobal) });
    // A sloppy-mode function called without a receiver must see the page
    // global, never the engine's: the rewrite routes every such `this` here.
    const hostGlobal = globalThis;
    Object.defineProperty(pageGlobal, THIS_HELPER, {
      value: (value) => value === undefined || value === null || value === hostGlobal ? pageGlobal : value,
    });
    Object.defineProperty(pageGlobal, "Function", { value: helper.Function, writable: true, configurable: true });
    installGlobalAccessors(pageGlobal, accessors);
    for (const alias of ["window", "self", "top", "parent", "frames"]) {
      Object.defineProperty(pageGlobal, alias, { value: pageGlobal, writable: true, configurable: true });
    }
    defineFrameWindows(pageGlobal);
    evaluate = (source) => {
      const classic = rewriteClassicScript(rewriteConstructorReads(rewriteDirectEval(source).code).code);
      return compartment.evaluate(escapeSesHtmlComments(classic.code), {
        sloppyGlobalsMode: true,
        // Classic scripts are sloppy-mode code, as in browsers, once the
        // rewrite has given every sloppy function's `this` the page global.
        __sloppyCode__: classic.parsed && !classic.strict,
      __evadeImportExpressionTest__: true,
      __evadeHtmlCommentTest__: true,
        // `eval(...)` in page code still goes through the compartment's safe
        // evaluator; rejecting every source that mentions it breaks real sites.
        __rejectSomeDirectEvalExpressions__: false,
      });
    };
    // Module code is already strict with its own scope; no global lifting.
    evaluateModuleCode = (code) => compartment.evaluate(escapeSesHtmlComments(code, "module"), {
      __evadeImportExpressionTest__: true,
      __rejectSomeDirectEvalExpressions__: false,
    });
  } else {
    // Host mode: the renderer's own global object becomes the page global.
    pageGlobal = globalThis;
    for (const [name, value] of Object.entries(api)) {
      Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
    }
    installGlobalAccessors(globalThis, accessors);
    for (const alias of ["window", "self", "top", "parent", "frames"]) {
      Object.defineProperty(globalThis, alias, { value: globalThis, writable: true, configurable: true });
    }
    defineFrameWindows(globalThis);
    // No SES: constructors are the real ones.
    Object.defineProperty(globalThis, CONSTRUCTOR_HELPER, {
      value: (value, call = false) => call ? (...args) => Reflect.apply(value.constructor, value, args) : value.constructor,
      configurable: true,
    });
    // Indirect eval: sloppy mode in the global scope, exactly like a <script>.
    evaluate = (source) => (0, eval)(source);
    evaluateModuleCode = (code) => (0, eval)(code);
  }

  for (const type of WINDOW_HANDLER_EVENTS) {
    defineEventHandlerProperty(pageGlobal, type, () => window, () => realm);
  }
  // Before any page script: the Web APIs print and name themselves as built-ins,
  // and the global has a browser's tags and enumerability.
  markNativeApi(pageGlobal);
  applyGlobalShape(pageGlobal, [Object.prototype, Function.prototype, Array.prototype, Error.prototype,
    Promise.prototype, pageGlobal.Promise?.prototype, RegExp.prototype, Date.prototype, Map.prototype, Set.prototype]);

  function startInsertedScripts(nodes) {
    for (const node of nodes) {
      if (node.nodeType !== 1) continue;
      for (const script of [node, ...node.querySelectorAll("script")]) {
        if (script.tagName !== "SCRIPT" || !createdScripts.has(script) || startedScripts.has(script)) continue;
        if (!script.isConnected) continue;
        runInsertedScript(script);
      }
    }
  }

  /**
   * A script element inserted by page code: inline scripts run during the
   * insertion, external ones once fetched, followed by load or error.
   */
  function runInsertedScript(script) {
    const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
    const src = script.getAttribute("src");
    if (type === "module") {
      if (!src && !script.textContent) return;
      startedScripts.add(script);
      trackPendingLoad(runModuleScript(script));
      return;
    }
    if (!CLASSIC_SCRIPT_TYPES.has(type)) return;
    if (!src && !script.textContent) return;
    startedScripts.add(script);
    if (!src) {
      runClassic(script, script.textContent);
      return;
    }
    const pending = hooks.fetchScript(new URL(src, document.URL).href).then(
      (source) => {
        runClassic(script, source);
        runTask(() => script.dispatchEvent(new window.Event("load")));
      },
      (error) => {
        reportError(error);
        runTask(() => script.dispatchEvent(new window.Event("error")));
      },
    );
    trackPendingLoad(pending);
  }

  function trackPendingLoad(pending) {
    if (readyState === "complete") return;
    pendingLoads.add(pending);
    pending.finally(() => pendingLoads.delete(pending));
  }

  // --- ES modules -------------------------------------------------------
  // A record is fetched and transformed once per (URL, type); the graph is
  // then walked breadth-first (so cycles cannot deadlock) and run in two
  // phases, see module-transform.js.

  function ensureFetched(url, type, sourceOverride = null) {
    const key = `${type ?? "js"} ${url}`;
    let record = modules.get(key);
    if (record) return record.fetched;
    record = { url, type, state: "fetching", namespace: Object.create(null), deps: [], error: null };
    modules.set(key, record);
    record.fetched = (async () => {
      const source = sourceOverride ?? await hooks.fetchScript(url);
      if (type === "json") {
        Object.defineProperty(record.namespace, "default", { value: JSON.parse(source), enumerable: true });
        record.state = "evaluated";
        return record;
      }
      if (type !== null) throw new TypeError(`Unsupported module type "${type}" for ${url}`);
      const { code, requests } = transformModule(mode === "ses"
        ? rewriteConstructorReads(rewriteDirectEval(source, "module").code, "module").code : source);
      record.fn = evaluateModuleCode(code);
      record.requests = requests.map((entry) => ({
        url: resolveModuleSpecifier(entry.specifier, url, importMap),
        type: entry.type,
      }));
      record.state = "fetched";
      return record;
    })();
    return record.fetched;
  }

  async function loadGraph(root) {
    const seen = new Set([root]);
    let frontier = [root];
    while (frontier.length) {
      // Each level of the graph is fetched in parallel.
      await Promise.all(frontier.map(async (record) => {
        if (record.requests) record.deps = await Promise.all(record.requests.map((entry) => ensureFetched(entry.url, entry.type)));
      }));
      const next = [];
      for (const record of frontier) {
        for (const dep of record.deps) if (!seen.has(dep)) {
          seen.add(dep);
          next.push(dep);
        }
      }
      frontier = next;
    }
  }

  async function evaluateGraph(root) {
    const order = [];
    const visited = new Set();
    (function visit(record) {
      if (visited.has(record)) return;
      visited.add(record);
      for (const dep of record.deps) visit(dep);
      order.push(record);
    })(root);
    // Phase 1: each module defines its export getters, then waits.
    for (const record of order) {
      if (record.state !== "fetched") continue;
      record.state = "linking";
      let release;
      const linked = new Promise((resolve) => (release = resolve));
      record.release = release;
      record.completion = callModule(record, linked);
    }
    // Phase 2: dependencies first, each module runs to completion (top-level await included).
    for (const record of order) {
      if (record.state !== "linking") continue;
      record.state = "evaluating";
      record.release();
      try {
        await record.completion;
        record.state = "evaluated";
      } catch (error) {
        record.state = "errored";
        record.error = error;
        reportError(error, record.url);
      } finally {
        hooks.afterTask();
      }
    }
    if (root.state === "errored") throw root.error;
    return root.namespace;
  }

  function callModule(record, linked) {
    const namespaces = record.deps.map((dep) => dep.namespace);
    const context = {
      exports: record.namespace,
      namespaces,
      linked,
      meta: {
        url: record.url,
        resolve: (specifier) => resolveModuleSpecifier(String(specifier), record.url, importMap),
      },
      importDynamic: (specifier) => importModule(String(specifier), record.url),
      exportStar: (source) => {
        for (const name of Object.keys(source)) {
          if (name === "default" || Object.hasOwn(record.namespace, name)) continue;
          Object.defineProperty(record.namespace, name, { enumerable: true, configurable: true, get: () => source[name] });
        }
      },
    };
    try {
      // A plain call: module top-level `this` is undefined.
      return Promise.resolve(asIncumbent(hooks.frames?.self, () => Reflect.apply(record.fn, undefined, [context])));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async function importModule(specifier, referrer, type = null, sourceOverride = null) {
    const url = sourceOverride === null ? resolveModuleSpecifier(specifier, referrer, importMap) : specifier;
    const root = await ensureFetched(url, type, sourceOverride);
    await loadGraph(root);
    return evaluateGraph(root);
  }

  /** Runs a <script type="module"> (external or inline); external ones fire load/error. */
  async function runModuleScript(script) {
    const src = script.getAttribute("src");
    try {
      if (src) await importModule(new URL(src, document.URL).href, document.URL);
      else await importModule(`${document.URL}#inline-module-${++inlineModuleCount}`, document.URL, null, script.textContent ?? "");
      if (src) runTask(() => script.dispatchEvent(new window.Event("load")));
    } catch (error) {
      reportError(error, src ? new URL(src, document.URL).href : document.URL);
      if (src) runTask(() => script.dispatchEvent(new window.Event("error")));
    }
  }

  function runClassic(script, source) {
    const previous = currentScript;
    currentScript = script;
    try {
      runTask(() => evaluate(source));
    } finally {
      currentScript = previous;
    }
  }

  /** Compiles on* attributes (e.g. onclick="...") present when the document loads. */
  function compileInlineHandlers() {
    for (const element of document.querySelectorAll("*")) {
      for (const type of INLINE_HANDLER_EVENTS) {
        const code = element.getAttribute(`on${type}`);
        if (code === null) continue;
        let handler;
        try {
          handler = evaluate(`(function (event) {\n${code}\n})`);
        } catch (error) {
          reportError(error);
          continue;
        }
        const binding = type === "load" && element === document.body ? pageGlobal : realm.wrap(element);
        if (binding !== pageGlobal) {
          binding[`on${type}`] = handler;
          continue;
        }
        window.addEventListener(type, (event) => {
          const result = callPage(handler, binding, [realm.wrapEvent(event)]);
          if (result === false) event.preventDefault();
        });
      }
    }
  }

  return {
    get pageGlobal() {
      return pageGlobal;
    },

    /** The page's document object (what a same-origin frame's contentDocument is). */
    get documentBinding() {
      return documentBinding;
    },

    get console() {
      return consoleEntries.slice();
    },

    /**
     * Runs the parser-inserted classic scripts in document order, then fires
     * DOMContentLoaded and load. Module scripts are skipped for now, which
     * makes their `nomodule` fallbacks run instead.
     */
    async runDocumentScripts() {
      compileInlineHandlers();
      const all = [...document.querySelectorAll("script")];
      const mapScript = all.find((script) => (script.getAttribute("type") ?? "").trim().toLowerCase() === "importmap");
      if (mapScript) {
        try {
          importMap = JSON.parse(mapScript.textContent ?? "{}");
        } catch (error) {
          reportError(error);
        }
      }
      // HTML order: blocking classic scripts during parsing, then defer and
      // module scripts in document order, then async scripts.
      const immediate = [];
      const deferred = [];
      const asynchronous = [];
      for (const script of all) {
        const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
        const external = script.hasAttribute("src");
        if (type === "module") {
          (script.hasAttribute("async") ? asynchronous : deferred).push(script);
        } else if (CLASSIC_SCRIPT_TYPES.has(type) && !script.hasAttribute("nomodule")) {
          if (external && script.hasAttribute("async")) asynchronous.push(script);
          else if (external && script.hasAttribute("defer")) deferred.push(script);
          else immediate.push(script);
        }
      }
      // Like a preload scanner: fetch every external script (and module graph)
      // up front, in parallel; execution order is unchanged.
      const preloaded = new Map();
      for (const script of [...immediate, ...deferred, ...asynchronous]) {
        const src = script.getAttribute("src");
        if (!src) continue;
        try {
          const url = new URL(src, document.URL).href;
          if ((script.getAttribute("type") ?? "").trim().toLowerCase() === "module") {
            ensureFetched(resolveModuleSpecifier(url, document.URL, importMap), null).then(loadGraph).catch(() => {});
          } else {
            const source = hooks.fetchScript(url);
            source.catch(() => {});
            preloaded.set(script, source);
          }
        } catch {
          // An unresolvable src is reported when the script runs.
        }
      }
      const run = async (script, parserBlocking = false) => {
        if (disposed) return;
        startedScripts.add(script);
        parsingHead = parserBlocking && document.head?.contains(script);
        if ((script.getAttribute("type") ?? "").trim().toLowerCase() === "module") {
          try {
            await runModuleScript(script);
          } finally {
            parsingHead = false;
          }
          return;
        }
        const src = script.getAttribute("src");
        let source;
        try {
          source = src
            ? await (preloaded.get(script) ?? hooks.fetchScript(new URL(src, document.URL).href))
            : script.textContent ?? "";
        } catch (error) {
          reportError(error);
          parsingHead = false;
          return;
        }
        try {
          runClassic(script, source);
        } finally {
          parsingHead = false;
        }
      };
      for (const script of immediate) await run(script, true);
      for (const script of deferred) await run(script);
      if (disposed) return;
      readyState = "interactive";
      markTiming("domInteractive", "domContentLoadedEventStart");
      runTask(() => fireLifecycle(document, new window.Event("DOMContentLoaded", { bubbles: true })));
      markTiming("domContentLoadedEventEnd");
      hooks.lifecycle?.("DOMContentLoaded");
      for (const script of asynchronous) await run(script);
      // Scripts inserted so far (and any they insert in turn) delay load.
      while (pendingLoads.size && !disposed) await Promise.allSettled([...pendingLoads]);
      // The document's images delay load too (HTML "the end", step 8).
      await hooks.whenImagesLoaded?.();
      if (disposed) return;
      readyState = "complete";
      markTiming("domComplete", "loadEventStart");
      runTask(() => fireLifecycle(window, new window.Event("load")));
      markTiming("loadEventEnd");
      hooks.lifecycle?.("load");
    },

    /** Dispatches a trusted-looking input event at a real element; returns whether default was prevented. */
    dispatch(target, event) {
      let prevented = false;
      runTask(() => {
        realm.markTrusted(event);
        target.dispatchEvent(event);
        prevented = event.defaultPrevented;
      });
      return prevented;
    },

    /**
     * Same-document navigation to a fragment (HTML §7.4.2.3.3): updates
     * location and document.URL, adds a history entry and fires popstate
     * at once; when the fragment changed, Happy DOM then fires hashchange
     * from a zero-delay timer. The promise settles after it.
     */
    navigateToFragment(url) {
      const same = url === location.href;
      setHref(url);
      pushEntry(same);
      runTask(() => window.dispatchEvent(new window.PopStateEvent("popstate", { state: null })));
      window.happyDOM?.setURL?.(url);
      return new Promise((resolve) => hostSetTimeout(resolve, 0));
    },

    /** Runs a classic script (a javascript: URL); errors are reported, not thrown. */
    run(source) {
      runTask(() => evaluate(String(source), "javascript: URL"));
    },

    /** Evaluates an expression in the page (CDP Runtime.evaluate). */
    evaluate(source) {
      return runTask(() => evaluate(source));
    },

    /** A message posted to this document's window by a frame of the page (see messaging.js). */
    receiveMessage(message) {
      messaging.receive(message);
    },

    /** A MediaSource object, or the one registered at a blob URL. */
    isMediaSource(value) {
      return mediaScope.isMediaSource(value);
    },
    mediaSourceAt(url) {
      return mediaScope.mediaSourceAt(url);
    },
    blobEntry(url) {
      return mediaScope.lookup(url);
    },

    dispose() {
      disposed = true;
      if (blobUrlFallback === mediaScope) blobUrlFallback = null;
      messaging.dispose();
      workers?.dispose();
      // Leaving the document closes its WebSockets (1001 "going away").
      for (const close of openSockets) close();
      openSockets.clear();
      for (const handle of timers.values()) hostClearTimeout(handle);
      timers.clear();
    },
  };
}

const NAVIGATION_TIMING_FIELDS = [
  "navigationStart", "unloadEventStart", "unloadEventEnd", "redirectStart", "redirectEnd", "fetchStart",
  "domainLookupStart", "domainLookupEnd", "connectStart", "connectEnd", "secureConnectionStart", "requestStart",
  "responseStart", "responseEnd", "domLoading", "domInteractive", "domContentLoadedEventStart",
  "domContentLoadedEventEnd", "domComplete", "loadEventStart", "loadEventEnd",
];
// Phases before the document exists: no unload, redirect or secure connection
// information is kept, and the network phases start with the navigation.
const AT_START = new Set(["fetchStart", "domainLookupStart", "domainLookupEnd", "connectStart", "connectEnd",
  "requestStart", "responseStart", "responseEnd"]);

/** performance.timing: live getters over the document's lifecycle marks. */
function navigationTiming(start, marks) {
  const timing = {};
  for (const field of NAVIGATION_TIMING_FIELDS) {
    Object.defineProperty(timing, field, {
      enumerable: true,
      get: () => field === "navigationStart" || AT_START.has(field) ? start : marks[field] ?? 0,
    });
  }
  timing.toJSON = () => Object.fromEntries(NAVIGATION_TIMING_FIELDS.map((field) => [field, timing[field]]));
  return Object.freeze(timing);
}

function installGlobalAccessors(target, accessors) {
  for (const [name, get] of Object.entries(accessors)) {
    Object.defineProperty(target, name, { get, configurable: true, enumerable: true });
  }
}

function scrollArguments(hooks, x, y, relative) {
  let left = x;
  let top = y;
  if (x !== null && typeof x === "object") {
    left = x.left;
    top = x.top;
  }
  const { scrollX, scrollY } = hooks.viewport();
  const targetX = Number.isFinite(Number(left)) ? Number(left) + (relative ? scrollX : 0) : scrollX;
  const targetY = Number.isFinite(Number(top)) ? Number(top) + (relative ? scrollY : 0) : scrollY;
  hooks.scrollTo(targetX, targetY);
}

/**
 * `value.constructor` for rewritten page code (see rewriteConstructorReads).
 * Under SES the Function, AsyncFunction, GeneratorFunction and
 * AsyncGeneratorFunction constructors reached through prototypes are inert;
 * these stand-ins compile the same function text in the page's compartment
 * and share the real prototypes, so instanceof and prototype checks hold.
 */
function constructorHelper(compartment) {
  const kinds = [
    [function () {}, "function"],
    [async function () {}, "async function"],
    [function* () {}, "function*"],
    [async function* () {}, "async function*"],
  ];
  const replacements = new Map();
  for (const [sample, keyword] of kinds) {
    const inert = Object.getPrototypeOf(sample).constructor;
    // Functions made from source are sloppy-mode code like classic scripts
    // (see rewriteClassicScript): Function("return this")() is the global.
    const Constructor = function (...args) {
      const body = args.length ? String(args[args.length - 1]) : "";
      const parameters = args.slice(0, -1).map(String).join(",");
      const source = `(${keyword} anonymous(${parameters}\n) {\n${body}\n})`;
      const classic = rewriteClassicScript(rewriteConstructorReads(rewriteDirectEval(source).code).code);
      return compartment.evaluate(escapeSesHtmlComments(classic.code), {
        sloppyGlobalsMode: true,
        __sloppyCode__: classic.parsed && !classic.strict,
        __evadeImportExpressionTest__: true,
        __evadeHtmlCommentTest__: true,
        __rejectSomeDirectEvalExpressions__: false,
      });
    };
    Object.defineProperty(Constructor, "prototype", { value: Object.getPrototypeOf(sample) });
    Object.defineProperty(Constructor, "name", { value: inert.name });
    replacements.set(inert, Constructor);
  }
  // call: `value.constructor(...)`, where an ordinary constructor keeps `value` as `this`.
  const helper = (value, call = false) => {
    const constructor = value.constructor;
    const replacement = replacements.get(constructor);
    if (replacement) return replacement;
    return call && typeof constructor === "function" ? (...args) => Reflect.apply(constructor, value, args) : constructor;
  };
  /** The global Function constructor for the compartment. */
  helper.Function = replacements.get(Object.getPrototypeOf(function () {}).constructor);
  return helper;
}

/**
 * What a direct `eval(...)` in page code calls (see rewriteDirectEval):
 * the caller's names arrive as accessors and become lexical bindings of the
 * evaluated code. As in browsers, a page that replaced `eval` gets an
 * ordinary call of its replacement, and a non-string argument is returned.
 */
function directEvalHelper(compartment, pageGlobal) {
  const intrinsicEval = pageGlobal.eval;
  return function (scope, ...args) {
    const target = pageGlobal.eval;
    if (target !== intrinsicEval) return Reflect.apply(target, undefined, args);
    const [source] = args;
    if (typeof source !== "string") return source;
    const names = Object.keys(scope);
    const prepared = prepareDirectEvalSource(source, names, scope[DIRECT_EVAL_STRICT] === true);
    return compartment.evaluate(escapeSesHtmlComments(rewriteConstructorReads(prepared.code).code), {
      sloppyGlobalsMode: true,
      __sloppyCode__: prepared.parsed && !prepared.strict,
      __moduleShimLexicals__: scope,
      __evadeImportExpressionTest__: true,
      __evadeHtmlCommentTest__: true,
      __rejectSomeDirectEvalExpressions__: false,
    });
  };
}

/**
 * window.History and window.history for one document. The methods live on a
 * per-document History.prototype that pages may wrap (dev servers do, to see
 * client-side routing). pushState/replaceState change the URL and state
 * without navigating or firing events; traversal is not modelled.
 */
function historyBinding(location, setHref) {
  let state = null;
  let length = 1;
  const change = (data, url) => {
    if (url === undefined || url === null) return;
    const target = new URL(String(url), location.href);
    if (target.origin !== new URL(location.href).origin) {
      throw new DOMException(`A history state object with URL '${target.href}' cannot be created in a document with origin '${new URL(location.href).origin}'.`, "SecurityError");
    }
    setHref(target.href);
  };
  function History() {
    throw new TypeError("Illegal constructor");
  }
  History.prototype = {
    constructor: History,
    get length() {
      return length;
    },
    get state() {
      return state;
    },
    scrollRestoration: "auto",
    back() {},
    forward() {},
    go() {},
    pushState(data, _title, url = undefined) {
      change(data, url);
      state = data ?? null;
      length++;
    },
    replaceState(data, _title, url = undefined) {
      change(data, url);
      state = data ?? null;
    },
  };
  // A fragment navigation adds an entry with no state (a same-URL one replaces it).
  const pushEntry = (replace) => {
    state = null;
    if (!replace) length++;
  };
  return { History, history: Object.create(History.prototype), pushEntry };
}

/** window.location; `setHref` moves it for same-document (fragment) navigations. */
function locationBinding(href, navigate) {
  const url = () => new URL(href);
  const location = {
    get href() {
      return href;
    },
    set href(value) {
      navigate(new URL(String(value), href).href);
    },
    get protocol() {
      return url().protocol;
    },
    get host() {
      return url().host;
    },
    get hostname() {
      return url().hostname;
    },
    get port() {
      return url().port;
    },
    get pathname() {
      return url().pathname;
    },
    get search() {
      return url().search;
    },
    get hash() {
      return url().hash;
    },
    set hash(value) {
      const next = url();
      next.hash = String(value);
      navigate(next.href);
    },
    get origin() {
      return url().origin;
    },
    assign: (value) => navigate(new URL(String(value), href).href),
    replace: (value) => navigate(new URL(String(value), href).href),
    reload: () => navigate(href),
    toString: () => href,
  };
  return { location, setHref: (value) => { href = value; } };
}

/** navigator.platform as Chromium reports it for the user agent's OS. */
function navigatorPlatform(userAgent) {
  if (/Android/.test(userAgent)) return "Linux armv81";
  if (/Windows/.test(userAgent)) return "Win32";
  if (/Macintosh/.test(userAgent)) return "MacIntel";
  if (/CrOS/.test(userAgent)) return "Linux x86_64";
  return `Linux ${/Linux (x86_64|aarch64|armv\w+|i686)/.exec(userAgent)?.[1] ?? "x86_64"}`;
}

/**
 * navigator, screen, visualViewport, the storages, performance and crypto as
 * platform objects (see interfaces.js), with the interface objects the page
 * global exposes for them. Desktop Chromium lists five PDF viewer plugins
 * and their two MIME types whatever is installed (HTML §8.9.1.6).
 */
function platformObjects({ eventTargets, userAgent, userAgentDataMembers, mobile, viewport, performance, storages, sendBeacon }) {
  const EventTargetPrototype = eventTargets.EventTarget.prototype;
  // An instance an event target's listeners can be added to.
  const eventTarget = (prototype) => {
    const Target = function () {};
    Target.prototype = prototype;
    return Reflect.construct(eventTargets.EventTarget, [], Target);
  };
  const targetOptions = { parent: EventTargetPrototype, base: eventTarget };
  const interfaces = {};
  const define = (name, members, options) => {
    const made = platformObject(name, members, options);
    interfaces[name] = made.Interface;
    return made;
  };
  // Indexed members are own, enumerable properties; named ones are own and not enumerable.
  const listObject = (made, slots, items, nameOf) => {
    const list = made.create(slots);
    items.forEach((item, index) => Object.defineProperty(list, index, { value: item, enumerable: true, configurable: true }));
    for (const item of items) {
      const name = nameOf(item);
      if (!Object.hasOwn(list, name)) Object.defineProperty(list, name, { value: item, configurable: true });
    }
    return list;
  };
  // Templates are merged by descriptor: spreading would read their getters.
  const members = (...parts) => Object.defineProperties({}, Object.assign({},
    ...parts.map((part) => Object.getOwnPropertyDescriptors(part))));
  const listMembers = {
    get length() { return this.items?.length ?? 0; },
    item(index) { return this.items?.[Number(index) >>> 0] ?? null; },
    namedItem(name) { return this.items?.find((item) => this.nameOf(item) === String(name)) ?? null; },
  };

  const pdfNames = mobile ? [] : ["PDF Viewer", "Chrome PDF Viewer", "Chromium PDF Viewer", "Microsoft Edge PDF Viewer", "WebKit built-in PDF"];
  const MimeType = define("MimeType", {
    get type() { return this.type; },
    get suffixes() { return "pdf"; },
    get description() { return "Portable Document Format"; },
    get enabledPlugin() { return this.plugin(); },
  });
  const Plugin = define("Plugin", members({
    get name() { return this.name; },
    get filename() { return "internal-pdf-viewer"; },
    get description() { return "Portable Document Format"; },
  }, listMembers));
  const PluginArray = define("PluginArray", members(listMembers, { refresh() {} }));
  const MimeTypeArray = define("MimeTypeArray", listMembers);
  for (const made of [Plugin, PluginArray, MimeTypeArray]) {
    Object.defineProperty(made.prototype, Symbol.iterator, { value: Array.prototype.values, writable: true, configurable: true });
  }
  let firstPlugin = null;
  const mimeTypeList = pdfNames.length ? ["application/pdf", "text/pdf"].map((type) => MimeType.create({ type, plugin: () => firstPlugin })) : [];
  const mimeTypeOf = (item) => Object.getOwnPropertyDescriptor(MimeType.prototype, "type").get.call(item);
  const pluginList = pdfNames.map((name) => listObject(Plugin, { name, items: mimeTypeList, nameOf: mimeTypeOf }, mimeTypeList, mimeTypeOf));
  firstPlugin = pluginList[0] ?? null;
  const pluginName = (item) => Object.getOwnPropertyDescriptor(Plugin.prototype, "name").get.call(item);
  const plugins = listObject(PluginArray, { items: pluginList, nameOf: pluginName }, pluginList, pluginName);
  const mimeTypes = listObject(MimeTypeArray, { items: mimeTypeList, nameOf: mimeTypeOf }, mimeTypeList, mimeTypeOf);

  const PermissionStatus = define("PermissionStatus", {
    get name() { return this.name; },
    get state() { return this.state; },
    onchange: null,
  }, targetOptions);
  const Permissions = define("Permissions", {
    query(descriptor) {
      if (!descriptor || typeof descriptor !== "object" || descriptor.name === undefined) {
        return Promise.reject(new TypeError("Failed to execute 'query' on 'Permissions': required member name is undefined."));
      }
      return Promise.resolve(PermissionStatus.create({ name: String(descriptor.name), state: "prompt" }));
    },
  });
  const NetworkInformation = define("NetworkInformation", {
    effectiveType: "4g", rtt: 50, downlink: 10, saveData: false, onchange: null,
  }, targetOptions);
  const NavigatorUAData = define("NavigatorUAData", userAgentDataMembers);
  const languages = Object.freeze(["en-US"]);
  const Navigator = define("Navigator", {
    userAgent,
    appCodeName: "Mozilla",
    appName: "Netscape",
    appVersion: userAgent.replace(/^Mozilla\//, ""),
    platform: navigatorPlatform(userAgent),
    product: "Gecko",
    productSub: "20030107",
    vendor: "Google Inc.",
    vendorSub: "",
    language: languages[0],
    languages,
    onLine: true,
    cookieEnabled: true,
    webdriver: false,
    doNotTrack: null,
    hardwareConcurrency: globalThis.navigator?.hardwareConcurrency || 4,
    deviceMemory: 8,
    maxTouchPoints: mobile ? 5 : 0,
    pdfViewerEnabled: pdfNames.length > 0,
    plugins,
    mimeTypes,
    userAgentData: NavigatorUAData.instance,
    connection: NetworkInformation.instance,
    permissions: Permissions.instance,
    sendBeacon(url, data = null) { return sendBeacon(url, data); },
    javaEnabled() { return false; },
    getGamepads() { return [null, null, null, null]; },
  });

  const ScreenOrientation = define("ScreenOrientation", {
    get type() { return viewport().width >= viewport().height ? "landscape-primary" : "portrait-primary"; },
    get angle() { return 0; },
    onchange: null,
  }, targetOptions);
  const Screen = define("Screen", {
    get width() { return viewport().width; },
    get height() { return viewport().height; },
    get availWidth() { return viewport().width; },
    get availHeight() { return viewport().height; },
    availLeft: 0,
    availTop: 0,
    colorDepth: 24,
    pixelDepth: 24,
    orientation: ScreenOrientation.instance,
    isExtended: false,
    onchange: null,
  }, targetOptions);
  // No pinch zoom; `scale` is the --mobile scale-up (client CSS pixels per page CSS pixel).
  const VisualViewport = define("VisualViewport", {
    offsetLeft: 0,
    offsetTop: 0,
    get pageLeft() { return viewport().scrollX; },
    get pageTop() { return viewport().scrollY; },
    get width() { return viewport().width; },
    get height() { return viewport().height; },
    get scale() { return viewport().pageScale ?? 1; },
    onresize: null,
    onscroll: null,
    onscrollend: null,
  }, targetOptions);
  const Performance = define("Performance", performance, targetOptions);
  const Crypto = define("Crypto", {
    getRandomValues(array) { return hostCrypto.getRandomValues(array); },
    randomUUID() { return hostCrypto.randomUUID(); },
  });
  const storage = storageInterface();
  interfaces.Storage = storage.Storage;
  return {
    interfaces,
    navigator: Navigator.instance,
    screen: Screen.instance,
    visualViewport: VisualViewport.instance,
    performance: Performance.instance,
    crypto: Crypto.instance,
    localStorage: storage.create(storages.local),
    sessionStorage: storage.create(storages.session),
  };
}

/** A read-only snapshot of the few computed values the engine models. */
/**
 * The page's CSSStyleDeclaration for getComputedStyle (CSSOM §9): resolved
 * values for the longhands the engine computes, by camelCase name and by
 * getPropertyValue, plus the element's custom properties. Width and height
 * are used values (layout's box) when the element is rendered; percentages
 * that depend on layout read as specified otherwise.
 */
function computedStyleBinding(style, { custom = null, bounds = null, element = null } = {}) {
  const px = (value) => `${Math.round(value * 1000) / 1000}px`;
  const length = (value) => typeof value === "number" ? px(value)
    : value?.unit === "%" ? `${value.value}%`
      : value?.unit === "math" && value.kind === "calc" ? `calc(${value.percent}% + ${value.px}px)`
        : value == null ? "auto" : String(value);
  const values = {};
  if (style) {
    const sides = ["Top", "Right", "Bottom", "Left"];
    const borderColor = (index) => style.borderColors?.[index] ?? style.color;
    const borderBox = style.boxSizing === "border-box";
    // Inline boxes (other than replaced elements) have no used width/height to report.
    if (style.display === "inline" && !["IMG", "VIDEO", "CANVAS", "IFRAME", "INPUT", "SELECT", "TEXTAREA", "BUTTON"]
      .includes(element?.tagName)) bounds = null;
    const horizontal = (style.padding[1] ?? 0) + (style.padding[3] ?? 0) + (style.borderWidths[1] ?? 0) + (style.borderWidths[3] ?? 0);
    const vertical = (style.padding[0] ?? 0) + (style.padding[2] ?? 0) + (style.borderWidths[0] ?? 0) + (style.borderWidths[2] ?? 0);
    const transform = style.transform;
    const translate = (value, size) => typeof value === "number" ? value : value?.unit === "%" ? value.value / 100 * size : 0;
    Object.assign(values, {
      display: style.display,
      position: style.position,
      float: style.float,
      color: style.color,
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage == null ? "none" : String(style.backgroundImage),
      fontSize: px(style.fontSize),
      fontWeight: String(style.fontWeight),
      fontFamily: (style.fontFamily ?? []).join(", "),
      lineHeight: style.lineHeight == null ? "normal" : px(style.lineHeight),
      textAlign: style.textAlign,
      whiteSpace: style.whiteSpace,
      verticalAlign: typeof style.verticalAlign === "number" ? px(style.verticalAlign) : String(style.verticalAlign),
      textOverflow: style.textOverflow,
      boxSizing: style.boxSizing,
      // A rendered box reads its used size; one that is not reads as computed.
      width: bounds ? px(Math.max(0, bounds.width - (borderBox ? 0 : horizontal))) : length(style.width),
      height: bounds ? px(Math.max(0, bounds.height - (borderBox ? 0 : vertical))) : length(style.height),
      minWidth: length(style.minWidth),
      maxWidth: style.maxWidth === "none" ? "none" : length(style.maxWidth),
      minHeight: length(style.minHeight),
      maxHeight: style.maxHeight === "none" ? "none" : length(style.maxHeight),
      top: length(style.inset[0]),
      right: length(style.inset[1]),
      bottom: length(style.inset[2]),
      left: length(style.inset[3]),
      zIndex: String(style.zIndex),
      flexDirection: style.flexDirection,
      flexWrap: style.flexWrap,
      flexGrow: String(style.flexGrow),
      flexShrink: String(style.flexShrink),
      flexBasis: length(style.flexBasis),
      justifyContent: style.justifyContent,
      alignContent: style.alignContent,
      alignItems: style.alignItems,
      alignSelf: style.alignSelf,
      rowGap: style.rowGap ? length(style.rowGap) : "normal",
      columnGap: style.columnGap ? length(style.columnGap) : "normal",
      borderRadius: length(style.borderRadius),
      transform: !transform ? "none"
        : `matrix(${transform.scaleX ?? 1}, 0, 0, ${transform.scaleY ?? 1}, ${translate(transform.x, bounds?.width ?? 0)}, ${translate(transform.y, bounds?.height ?? 0)})`,
      visibility: style.visibility ?? "visible",
      opacity: String(style.opacity ?? 1),
      pointerEvents: style.pointerEvents ?? "auto",
      // overflow: hidden and clip both clip; scroll containers report how they scroll.
      overflowX: style.overflowScrollX ?? (style.overflowX === "clip" ? "clip" : "visible"),
      overflowY: style.overflowScrollY ?? (style.overflowY === "clip" ? "clip" : "visible"),
    });
    values.overflow = values.overflowX === values.overflowY ? values.overflowX : `${values.overflowX} ${values.overflowY}`;
    sides.forEach((side, index) => {
      values[`margin${side}`] = length(style.margin[index]);
      values[`padding${side}`] = length(style.padding[index]);
      values[`border${side}Width`] = px(style.borderWidths[index] ?? 0);
      values[`border${side}Style`] = style.borderStyles[index] ?? "none";
      values[`border${side}Color`] = borderColor(index);
    });
    values.margin = sides.map((side) => values[`margin${side}`]).join(" ");
    values.padding = sides.map((side) => values[`padding${side}`]).join(" ");
  }
  const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const byKebab = Object.fromEntries(Object.entries(values).map(([name, value]) => [kebab(name), value]));
  const names = Object.keys(byKebab);
  const customValue = (name) => {
    const value = custom?.get(name);
    return value == null ? "" : resolveVariables(value, custom);
  };
  return {
    ...values,
    length: names.length,
    item: (index) => names[Number(index)] ?? "",
    getPropertyValue: (name) => {
      const key = String(name);
      return key.startsWith("--") ? customValue(key) : byKebab[key.toLowerCase()] ?? "";
    },
    getPropertyPriority: () => "",
    get cssText() {
      return "";
    },
  };
}

function formatConsoleValue(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeOrigin(href) {
  try {
    return new URL(href).origin;
  } catch {
    return "null";
  }
}
