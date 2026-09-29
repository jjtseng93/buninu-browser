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
  BindingRealm, defineEventHandlerProperty, eventConstructors, hardenBindings, INTERFACES, nodeOf, windowEventMethods,
} from "./bindings.js";
import { resolveModuleSpecifier, transformModule } from "./module-transform.js";
import { CONSTRUCTOR_HELPER, rewriteClassicScript, rewriteConstructorReads } from "./script-rewrite.js";
import { mediaQueryMatches } from "../style/computed-style.js";

// Captured at load, before host mode can install page globals over them.
const hostSetTimeout = globalThis.setTimeout;
const hostClearTimeout = globalThis.clearTimeout;
const hostQueueMicrotask = globalThis.queueMicrotask;
const hostPerformance = globalThis.performance;
const hostCrypto = globalThis.crypto;
const hostStructuredClone = globalThis.structuredClone;
const hostAtob = globalThis.atob;
const hostBtoa = globalThis.btoa;

const CLASSIC_SCRIPT_TYPES = new Set([
  "", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript",
  "application/x-javascript", "text/jscript", "text/livescript",
]);
const INLINE_HANDLER_EVENTS = [
  "click", "dblclick", "mousedown", "mouseup", "input", "change", "submit", "keydown", "keyup",
  "keypress", "focus", "blur", "load",
];
const MAX_CONSOLE_ENTRIES = 500;
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
const LIFECYCLE_EVENT_TYPES = new Set(["load", "DOMContentLoaded", "readystatechange"]);
// window.on* handler properties (window.onerror has a different signature and is not modelled).
const WINDOW_HANDLER_EVENTS = [
  "load", "resize", "scroll", "keydown", "keyup", "keypress", "click", "message", "hashchange",
  "popstate", "beforeunload", "unload", "focus", "blur", "online", "offline",
];
const hostStorage = new Map();

/**
 * @param {{
 *   window: object, document: object, mode: "ses" | "host",
 *   hooks: {
 *     touch(): void, afterTask(): void,
 *     boundsOf(element: object): { left: number, top: number, width: number, height: number } | null,
 *     viewport(): { width: number, height: number, scrollX: number, scrollY: number, devicePixelRatio: number },
 *     scrollTo(x: number, y: number): void,
 *     computedStyle(element: object): object | null,
 *     navigate(url: string): void,
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
  let currentScript = null;
  let pageGlobal = null;
  let evaluate;
  let evaluateModuleCode;
  let importMap = null;
  const modules = new Map();
  let inlineModuleCount = 0;

  const reportError = (error) => {
    // SES "safe" error taming blanks .stack, so fall back to name and message.
    const message = error?.stack || (error?.name ? `${error.name}: ${error.message}` : String(error?.message ?? error));
    consoleEntries.push({ level: "error", text: message });
    hooks.reportError(message);
  };

  /** Runs page code as a task: errors are reported, then the renderer may update. */
  const runTask = (task) => {
    if (disposed) return undefined;
    try {
      return task();
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
    viewport: hooks.viewport,
    scrollTo: hooks.scrollTo,
    call: callPage,
    readyState: () => readyState,
    documentCookie: () => hooks.documentCookie?.() ?? "",
    setDocumentCookie: (value) => hooks.setDocumentCookie?.(value),
    currentScript: () => currentScript,
    pageGlobal: () => pageGlobal,
    targetOf: (real) => real === window ? pageGlobal : null,
    created: (element) => {
      if (element.tagName === "SCRIPT") createdScripts.add(element);
    },
    inserted: (nodes) => startInsertedScripts(nodes),
    acceptEvent: (event) => !LIFECYCLE_EVENT_TYPES.has(event.type)
      || (event.target !== window && event.target !== document)
      || lifecycleEvents.has(event),
  });
  const documentBinding = realm.wrap(document);

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
  pageConsole.table = pageConsole.log;
  pageConsole.dir = pageConsole.log;
  pageConsole.group = pageConsole.log;
  pageConsole.groupEnd = () => {};
  pageConsole.assert = (condition, ...args) => {
    if (!condition) pageConsole.error("Assertion failed:", ...args);
  };

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
        time: hostPerformance.now(),
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
  function networkApi() {
    const abortError = () => new DOMException("The operation was aborted.", "AbortError");

    async function describeRequest(input, init = {}) {
      const source = input instanceof Request ? input : null;
      const url = new URL(source ? source.url : String(input), document.URL);
      const method = String(init.method ?? source?.method ?? "GET").toUpperCase();
      const headers = new Headers(init.headers ?? source?.headers ?? undefined);
      let body = null;
      const bodyInit = init.body !== undefined ? init.body : source && !["GET", "HEAD"].includes(method)
        ? await source.clone().arrayBuffer() : null;
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
        mode: init.mode ?? source?.mode ?? "cors",
        credentials: init.credentials ?? source?.credentials ?? "same-origin",
        redirect: init.redirect ?? source?.redirect ?? "follow",
        signal: init.signal ?? source?.signal ?? null,
      };
    }

    function makeResponse(data) {
      const bytes = data.body instanceof Uint8Array ? data.body : new Uint8Array(0);
      const headers = new Headers(data.headers ?? []);
      let used = false;
      const read = () => {
        if (used) return Promise.reject(new TypeError("Body has already been used"));
        used = true;
        return Promise.resolve(new Response(bytes, { headers: { "content-type": headers.get("content-type") ?? "" } }));
      };
      const response = {
        type: data.type ?? "basic",
        url: data.url ?? "",
        redirected: Boolean(data.redirected),
        status: data.status ?? 200,
        ok: (data.status ?? 200) >= 200 && (data.status ?? 200) <= 299,
        statusText: data.statusText ?? "",
        headers,
        get bodyUsed() {
          return used;
        },
        get body() {
          return used ? null : new Response(bytes).body;
        },
        text: () => read().then((body) => body.text()),
        json: () => read().then((body) => body.json()),
        arrayBuffer: () => read().then((body) => body.arrayBuffer()),
        blob: () => read().then((body) => body.blob()),
        formData: () => read().then((body) => body.formData()),
        bytes: () => read().then((body) => body.bytes()),
        clone: () => {
          if (used) throw new TypeError("Body has already been used");
          return makeResponse(data);
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
      if (scheme === "data:" || scheme === "blob:") {
        pending = fetch(request.url).then(async (local) => ({
          type: "basic", url: request.url, status: local.status, statusText: local.statusText,
          headers: [...local.headers], body: new Uint8Array(await local.arrayBuffer()),
        }));
      } else {
        const { signal: _signal, ...plain } = request;
        // Network and CORS failures reach the page as a bare TypeError, as in
        // browsers; the reason is only logged to the console.
        pending = hooks.pageFetch(plain).catch((error) => {
          const text = `fetch ${plain.url}: ${error?.message ?? error}`;
          consoleEntries.push({ level: "error", text });
          hooks.consoleMessage?.("error", text);
          throw new TypeError("Failed to fetch");
        });
      }
      const aborted = signal
        ? new Promise((_, reject) => signal.addEventListener("abort", () => reject(abortError()), { once: true }))
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
          url = new URL(String(requestUrl), document.URL).href;
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
        target = new URL(String(url), document.URL);
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
          defaultPrevented: false, timeStamp: performance.now(), preventDefault() {}, stopPropagation() {},
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
      fetch: pageFetch,
      XMLHttpRequest,
      WebSocket,
      Headers,
      Request,
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
      Window: make("Window", () => false),
      EventTarget: make("EventTarget", () => true),
      Comment: make("Comment", (node) => node.nodeType === 8),
      DocumentType: make("DocumentType", (node) => node.nodeType === 10),
      ShadowRoot: make("ShadowRoot", () => false),
      SVGElement: make("SVGElement", (node) => node.namespaceURI === SVG_NAMESPACE),
      SVGSVGElement: make("SVGSVGElement", (node) => node.namespaceURI === SVG_NAMESPACE && node.localName === "svg"),
      HTMLUnknownElement: make("HTMLUnknownElement", () => false),
    };
    for (const [name, tags] of Object.entries(ELEMENT_INTERFACES)) {
      interfaces[name] = make(name, (node) => node.nodeType === 1 && tags.includes(node.tagName));
    }
    return interfaces;
  }

  const origin = safeOrigin(document.URL);
  if (!hostStorage.has(origin)) hostStorage.set(origin, new Map());

  const viewportValue = (key) => () => hooks.viewport()[key];
  const { location, setHref } = locationBinding(document.URL, hooks.navigate);
  const { History, history } = historyBinding(location, setHref);
  const { Event, CustomEvent, ...uiEvents } = eventConstructors(realm);
  const observers = observerConstructors();
  const network = networkApi();
  const windowEvents = windowEventMethods(realm, null);

  /** Web APIs placed on the page's global object (bindings plus hardened host utilities). */
  const api = {
    document: documentBinding,
    location,
    navigator: {
      userAgent: hooks.userAgent(),
      language: "en-US",
      languages: ["en-US"],
      platform: "Linux",
      onLine: true,
      cookieEnabled: false,
      webdriver: false,
      hardwareConcurrency: 1,
      maxTouchPoints: 0,
      sendBeacon: (url, data) => {
        network.fetch(url, { method: "POST", body: data, mode: "no-cors", credentials: "include", keepalive: true })
          .catch(() => {});
        return true;
      },
    },
    History,
    history,
    screen: {
      get width() {
        return hooks.viewport().width;
      },
      get height() {
        return hooks.viewport().height;
      },
      colorDepth: 24,
      pixelDepth: 24,
    },
    // No pinch zoom; `scale` is the --mobile scale-up (client CSS pixels per page CSS pixel).
    visualViewport: {
      offsetLeft: 0,
      offsetTop: 0,
      get pageLeft() {
        return hooks.viewport().scrollX;
      },
      get pageTop() {
        return hooks.viewport().scrollY;
      },
      get width() {
        return hooks.viewport().width;
      },
      get height() {
        return hooks.viewport().height;
      },
      get scale() {
        return hooks.viewport().pageScale ?? 1;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    localStorage: storageBinding(hostStorage.get(origin)),
    sessionStorage: storageBinding(new Map()),
    console: pageConsole,
    setTimeout: (handler, delay = 0, ...args) => schedule(handler, delay, args, false),
    setInterval: (handler, delay = 0, ...args) => schedule(handler, delay, args, true),
    clearTimeout: cancel,
    clearInterval: cancel,
    requestAnimationFrame: (callback) => schedule(() => callPage(callback, pageGlobal, [hostPerformance.now()]), 16, [], false),
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
    performance: {
      now: () => hostPerformance.now(),
      timeOrigin: hostPerformance.timeOrigin,
      mark: () => {},
      measure: () => {},
      getEntriesByType: () => [],
      getEntriesByName: () => [],
    },
    crypto: {
      getRandomValues: (array) => hostCrypto.getRandomValues(array),
      randomUUID: () => hostCrypto.randomUUID(),
    },
    Event,
    CustomEvent,
    ...uiEvents,
    ...observers,
    ...network,
    Image: function Image(width, height) {
      if (!new.target) throw new TypeError("Constructor Image requires 'new'");
      const image = document.createElement("img");
      if (width !== undefined) image.setAttribute("width", String(width));
      if (height !== undefined) image.setAttribute("height", String(height));
      return realm.wrap(image);
    },
    customElements: {
      define: () => {},
      get: () => undefined,
      whenDefined: () => Promise.resolve(),
      upgrade: () => {},
    },
    ...INTERFACES,
    ...typeCheckInterfaces(),
    addEventListener: windowEvents.addEventListener,
    removeEventListener: windowEvents.removeEventListener,
    dispatchEvent: windowEvents.dispatchEvent,
    getComputedStyle: (element) => computedStyleBinding(hooks.computedStyle(nodeOf(element))),
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
    postMessage: () => {},
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
  };

  if (mode === "ses") {
    hardenBindings();
    // Host utilities are hardened before a page can see them: the engine
    // itself uses URL, TextEncoder and Intl, so pages must not change them.
    for (const value of [TextEncoder, TextDecoder, URL, URLSearchParams, Intl, Headers, Request, Response,
      AbortController, AbortSignal, FormData, Blob, File, DOMException, ReadableStream]) {
      harden(value);
    }
    // Everything in `api` is created per document; only shared host classes
    // (above) and the binding classes need hardening.
    const compartment = new Compartment({
      globals: { ...api, Math, Date, Intl },
      __options__: true,
    });
    pageGlobal = compartment.globalThis;
    Object.defineProperty(pageGlobal, CONSTRUCTOR_HELPER, { value: constructorHelper(compartment) });
    installGlobalAccessors(pageGlobal, accessors);
    for (const alias of ["window", "self", "top", "parent", "frames"]) {
      Object.defineProperty(pageGlobal, alias, { value: pageGlobal, writable: true, configurable: true });
    }
    evaluate = (source) => compartment.evaluate(rewriteClassicScript(rewriteConstructorReads(source).code).code, {
      sloppyGlobalsMode: true,
      __evadeImportExpressionTest__: true,
      __evadeHtmlCommentTest__: true,
      // `eval(...)` in page code still goes through the compartment's safe
      // evaluator; rejecting every source that mentions it breaks real sites.
      __rejectSomeDirectEvalExpressions__: false,
    });
    // Module code is already strict with its own scope; no global lifting.
    evaluateModuleCode = (code) => compartment.evaluate(code, {
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
      const { code, requests } = transformModule(mode === "ses" ? rewriteConstructorReads(source, "module").code : source);
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
        reportError(error);
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
      return Promise.resolve(Reflect.apply(record.fn, undefined, [context]));
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
      reportError(error);
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
        const target = binding === pageGlobal ? window : element;
        target.addEventListener(type, (event) => {
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
      const run = async (script) => {
        if (disposed) return;
        startedScripts.add(script);
        if ((script.getAttribute("type") ?? "").trim().toLowerCase() === "module") {
          await runModuleScript(script);
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
          return;
        }
        runClassic(script, source);
      };
      for (const script of immediate) await run(script);
      for (const script of deferred) await run(script);
      if (disposed) return;
      readyState = "interactive";
      runTask(() => fireLifecycle(document, new window.Event("DOMContentLoaded", { bubbles: true })));
      hooks.lifecycle?.("DOMContentLoaded");
      for (const script of asynchronous) await run(script);
      // Scripts inserted so far (and any they insert in turn) delay load.
      while (pendingLoads.size && !disposed) await Promise.allSettled([...pendingLoads]);
      readyState = "complete";
      runTask(() => fireLifecycle(window, new window.Event("load")));
      hooks.lifecycle?.("load");
    },

    /** Dispatches a trusted-looking input event at a real element; returns whether default was prevented. */
    dispatch(target, event) {
      let prevented = false;
      runTask(() => {
        target.dispatchEvent(event);
        prevented = event.defaultPrevented;
      });
      return prevented;
    },

    /**
     * Same-document navigation to a fragment: updates location and
     * document.URL. When the fragment changed, Happy DOM fires hashchange
     * (HTML §7.4.2.3.3) from a zero-delay timer; the promise settles after it.
     */
    navigateToFragment(url) {
      setHref(url);
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

    dispose() {
      disposed = true;
      // Leaving the document closes its WebSockets (1001 "going away").
      for (const close of openSockets) close();
      openSockets.clear();
      for (const handle of timers.values()) hostClearTimeout(handle);
      timers.clear();
    },
  };
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
    const Constructor = function (...args) {
      const body = args.length ? String(args[args.length - 1]) : "";
      const parameters = args.slice(0, -1).map(String).join(",");
      return compartment.evaluate(`(${keyword} anonymous(${parameters}\n) {\n${body}\n})`);
    };
    Object.defineProperty(Constructor, "prototype", { value: Object.getPrototypeOf(sample) });
    Object.defineProperty(Constructor, "name", { value: inert.name });
    replacements.set(inert, keyword === "function" ? compartment.globalThis.Function : Constructor);
  }
  // call: `value.constructor(...)`, where an ordinary constructor keeps `value` as `this`.
  return (value, call = false) => {
    const constructor = value.constructor;
    const replacement = replacements.get(constructor);
    if (replacement) return replacement;
    return call && typeof constructor === "function" ? (...args) => Reflect.apply(constructor, value, args) : constructor;
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
  return { History, history: Object.create(History.prototype) };
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

function storageBinding(map) {
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][Number(index)] ?? null,
    getItem: (key) => map.has(String(key)) ? map.get(String(key)) : null,
    setItem: (key, value) => {
      map.set(String(key), String(value));
    },
    removeItem: (key) => {
      map.delete(String(key));
    },
    clear: () => map.clear(),
  };
}

/** A read-only snapshot of the few computed values the engine models. */
function computedStyleBinding(style) {
  const values = style ? {
    display: style.display,
    position: style.position,
    color: style.color,
    backgroundColor: style.backgroundColor,
    fontSize: `${style.fontSize}px`,
    fontWeight: String(style.fontWeight),
    fontFamily: (style.fontFamily ?? []).join(", "),
    lineHeight: style.lineHeight == null ? "normal" : `${style.lineHeight}px`,
    textAlign: style.textAlign,
    whiteSpace: style.whiteSpace,
    boxSizing: style.boxSizing,
    zIndex: String(style.zIndex),
    visibility: "visible",
    opacity: "1",
  } : {};
  const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const byKebab = Object.fromEntries(Object.entries(values).map(([name, value]) => [kebab(name), value]));
  return {
    ...values,
    getPropertyValue: (name) => byKebab[String(name)] ?? "",
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
