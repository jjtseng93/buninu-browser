/**
 * Cross-document messaging for one document's realm (HTML §9.3, §9.4):
 * window.postMessage between the frames of a page, the WindowProxy-like
 * objects that stand for other frames, and MessageChannel / MessagePort.
 *
 * Frames are reached through window handles (see page-renderer.js): host
 * objects with the frame's origin, its parent and a way to deliver a message
 * into its current realm. Every frame of a page lives in this renderer
 * process, so message ports are host objects too, and a transferred port
 * keeps its queue while it moves to another realm.
 *
 * A same-origin frame's window is its document's own global object (and its
 * document is reachable), as in browsers; any other frame is seen through
 * a proxy that only posts messages.
 */

// Captured before lockdown: messages are cloned by the host.
const hostStructuredClone = globalThis.structuredClone;
const hostSetTimeout = globalThis.setTimeout;

/**
 * One end of a message channel. `owner` is the messaging of the realm that
 * holds the port now (null while it is in transit); messages wait in `queue`
 * until that realm has started the port.
 */
class PortEndpoint {
  peer = null;
  owner = null;
  facade = null;
  queue = [];
  started = false;
  closed = false;

  enqueue(message) {
    if (this.closed) return;
    this.queue.push(message);
    this.flush();
  }

  flush() {
    while (this.owner && this.started && !this.closed && this.queue.length) {
      this.owner.deliverToPort(this, this.queue.shift());
    }
  }
}

// Every realm's port objects, by object: a same-origin frame may pass a port
// of its own realm to another realm's postMessage.
const portEndpoints = new WeakMap();

// The window handles of the realms running page code, innermost last. A
// same-origin frame calls another frame's postMessage directly; the message
// is still from the caller (HTML's incumbent settings object).
const incumbents = [];

/** Runs `task` as code of the realm whose window is `handle`. */
export function asIncumbent(handle, task) {
  if (!handle) return task();
  incumbents.push(handle);
  try {
    return task();
  } finally {
    incumbents.pop();
  }
}

/** The origin a document's URL serializes to ("null" when opaque). */
export function originOf(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : "null";
  } catch {
    return "null";
  }
}

/**
 * Message ports for one realm (a document's or a worker's): MessageChannel,
 * MessagePort, and moving ports in and out of the realm with postMessage.
 * `makeEvent(data, ports)` builds the realm's message event; `queueTask`
 * runs a task of the realm; `call` invokes page functions.
 */
export function createPorts({ makeEvent, queueTask, call, DOMException }) {
  const endpoints = portEndpoints;
  const owned = new Set();
  const listeners = new WeakMap();
  const handlers = new WeakMap();

  function MessagePort() {
    throw new TypeError("Illegal constructor");
  }
  // A port that was transferred away keeps its listeners but no endpoint: it does nothing.
  const endpointOf = (port) => {
    if (!listeners.has(port)) throw new TypeError("Illegal invocation");
    return endpoints.get(port) ?? null;
  };

  /**
   * A message and its transfer list as they leave this realm: the data
   * cloned (other transferables, such as ArrayBuffers, move with it) and the
   * ports taken out. Nothing is taken when cloning fails.
   */
  function pack(message, transfer) {
    const list = transfer == null ? [] : Array.from(transfer);
    const ports = list.filter((item) => endpoints.has(item));
    const others = list.filter((item) => !endpoints.has(item));
    if (new Set(list).size !== list.length) throw new DOMException("An object is transferred twice", "DataCloneError");
    const data = clone(message, DOMException, others);
    return { data, ports: take(ports) };
  }

  /** Takes the ports of a transfer list out of this realm. */
  function take(transfer) {
    const list = transfer == null ? [] : Array.from(transfer);
    const taken = [];
    for (const item of list) {
      const endpoint = endpoints.get(item);
      if (!endpoint) throw new DOMException("Only MessagePort objects can be transferred", "DataCloneError");
      if (taken.includes(endpoint)) throw new DOMException("A port is transferred twice", "DataCloneError");
      taken.push(endpoint);
    }
    for (const endpoint of taken) {
      endpoints.delete(endpoint.facade);
      // The realm holding it may be another frame's.
      endpoint.owner?.release(endpoint);
      Object.assign(endpoint, { owner: null, facade: null, started: false });
    }
    return taken;
  }

  /** This realm's port object for an endpoint (it now holds that end). */
  function adopt(endpoint) {
    if (endpoint.facade && endpoint.owner === api) return endpoint.facade;
    const port = Object.create(MessagePort.prototype);
    listeners.set(port, []);
    handlers.set(port, {});
    endpoints.set(port, endpoint);
    Object.assign(endpoint, { owner: api, facade: port });
    owned.add(endpoint);
    return port;
  }

  function dispatch(port, event) {
    const handler = handlers.get(port)?.[event.type];
    if (handler) call(handler, port, [event]);
    for (const { type, listener } of [...(listeners.get(port) ?? [])]) {
      if (type !== event.type) continue;
      if (typeof listener === "function") call(listener, port, [event]);
      else call(listener.handleEvent, listener, [event]);
    }
  }

  MessagePort.prototype = {
    constructor: MessagePort,
    postMessage(message, options = undefined) {
      const endpoint = endpointOf(this);
      const transfer = Array.isArray(options) ? options : options?.transfer;
      const packed = pack(message, transfer);
      if (!endpoint || endpoint.closed || !endpoint.peer) return;
      endpoint.peer.enqueue(packed);
    },
    start() {
      const endpoint = endpointOf(this);
      if (!endpoint || endpoint.started) return;
      endpoint.started = true;
      endpoint.flush();
    },
    close() {
      const endpoint = endpointOf(this);
      if (!endpoint) return;
      endpoint.closed = true;
      if (endpoint.peer) endpoint.peer.closed = true;
    },
    addEventListener(type, listener) {
      if (typeof listener !== "function" && typeof listener?.handleEvent !== "function") return;
      const list = listeners.get(this);
      if (list && !list.some((entry) => entry.type === type && entry.listener === listener)) list.push({ type, listener });
    },
    removeEventListener(type, listener) {
      const list = listeners.get(this);
      const index = list?.findIndex((entry) => entry.type === type && entry.listener === listener) ?? -1;
      if (index >= 0) list.splice(index, 1);
    },
    dispatchEvent(event) {
      dispatch(this, event);
      return !event?.defaultPrevented;
    },
  };
  for (const type of ["message", "messageerror"]) {
    Object.defineProperty(MessagePort.prototype, `on${type}`, {
      configurable: true,
      enumerable: true,
      get() {
        return handlers.get(this)?.[type] ?? null;
      },
      set(value) {
        const own = handlers.get(this);
        if (!own) return;
        own[type] = typeof value === "function" ? value : null;
        // Setting onmessage starts the port (HTML §9.4.4).
        if (type === "message") this.start();
      },
    });
  }

  function MessageChannel() {
    if (!new.target) throw new TypeError("Constructor MessageChannel requires 'new'");
    const left = new PortEndpoint();
    const right = new PortEndpoint();
    left.peer = right;
    right.peer = left;
    const channel = Object.create(MessageChannel.prototype);
    Object.defineProperty(channel, "port1", { value: adopt(left), enumerable: true });
    Object.defineProperty(channel, "port2", { value: adopt(right), enumerable: true });
    return channel;
  }
  MessageChannel.prototype = { constructor: MessageChannel };

  const api = {
    MessageChannel,
    MessagePort,
    pack,
    take,
    adopt,
    release(endpoint) {
      owned.delete(endpoint);
    },
    /** A message for a port of this realm (see PortEndpoint). */
    deliverToPort(endpoint, { data, ports }) {
      queueTask(() => {
        if (endpoint.owner !== api || !endpoint.facade) return;
        dispatch(endpoint.facade, makeEvent(data, ports.map(adopt)));
      });
    },
    dispose() {
      for (const endpoint of owned) Object.assign(endpoint, { owner: null, facade: null });
      owned.clear();
    },
  };
  return api;
}

/** A host structured clone of a page value (moving `transfer`); failures are the page's DataCloneError. */
export function clone(value, DOMException, transfer = []) {
  try {
    return hostStructuredClone(value, transfer.length ? { transfer } : undefined);
  } catch (error) {
    throw new DOMException(String(error?.message ?? error), "DataCloneError");
  }
}

/**
 * @param {{
 *   realm: object, window: object, pageGlobal(): object, runTask(task: () => void): void,
 *   callPage(fn: Function, thisArg: object, args: unknown[]): unknown, DOMException: Function,
 *   frames: { self: object, parent: object | null, top: object, childOf(node: object): object | null } | null,
 * }} options
 */
export function createMessaging({ realm, window, pageGlobal, runTask, callPage, DOMException, frames }) {
  let disposed = false;
  const proxies = new WeakMap();
  const self = frames?.self ?? null;

  const queueTask = (task) => hostSetTimeout(() => {
    if (!disposed) runTask(task);
  }, 0);
  const ports = createPorts({
    makeEvent: (data, adopted) => realm.messageEvent("message", { data, ports: adopted }),
    queueTask,
    call: callPage,
    DOMException,
  });

  // ---- windows
  /** Whether a frame shows a document of this document's origin. */
  const sameOrigin = (handle) => {
    const origin = self?.origin();
    return Boolean(origin && origin !== "null" && handle.origin() === origin);
  };

  /**
   * window.frames: the window itself, where frames[i] and frames[name] are
   * its child frames (by position, or by browsing context name).
   */
  function framesView(handle, target) {
    const child = (key) => {
      if (typeof key !== "string") return null;
      const children = handle.children();
      return /^(0|[1-9]\d*)$/.test(key) ? children[Number(key)] ?? null : children.find((frame) => frame.name() === key) ?? null;
    };
    // A child may not stand for a fixed property of the window (Proxy invariants).
    const fixed = (key) => Object.getOwnPropertyDescriptor(target, key)?.configurable === false;
    return new Proxy(target, {
      get(object, key) {
        const frame = fixed(key) ? null : child(key);
        return frame ? proxyFor(frame) : Reflect.get(object, key);
      },
      has(object, key) {
        return Boolean(child(key)) || Reflect.has(object, key);
      },
    });
  }

  /** The page's view of a frame: its own window, its global when same-origin, or a proxy that posts to it. */
  function proxyFor(handle) {
    if (!handle) return null;
    if (handle === self) return pageGlobal();
    if (sameOrigin(handle)) {
      const global = handle.global();
      if (global) return global;
    }
    let proxy = proxies.get(handle);
    if (proxy) return proxy;
    proxy = {
      postMessage(message, targetOrigin = undefined, transfer = undefined) {
        post(handle, message, targetOrigin, transfer);
      },
      get closed() {
        return handle.closed();
      },
      get parent() {
        return proxyFor(handle.parent()) ?? proxy;
      },
      get top() {
        return proxyFor(handle.top());
      },
      get length() {
        return handle.children().length;
      },
      focus() {},
      blur() {},
    };
    Object.defineProperty(proxy, "window", { get: () => proxy });
    Object.defineProperty(proxy, "self", { get: () => proxy });
    const frames = framesView(handle, proxy);
    Object.defineProperty(proxy, "frames", { get: () => frames });
    proxies.set(handle, proxy);
    return proxy;
  }

  /** window.postMessage(message, targetOrigin | options, transfer) to the frame behind `handle`. */
  function post(handle, message, targetOrigin, transfer) {
    let target = targetOrigin;
    if (targetOrigin !== null && typeof targetOrigin === "object") {
      target = targetOrigin.targetOrigin;
      transfer = targetOrigin.transfer;
    }
    target = target === undefined ? "/" : String(target);
    const sender = incumbents.at(-1) ?? self;
    const origin = sender?.origin() ?? originOf(window.location?.href ?? "");
    let wanted = null;
    if (target === "/") wanted = origin;
    else if (target !== "*") {
      wanted = originOf(target);
      if (wanted === "null") throw new DOMException(`Invalid target origin '${target}'`, "SyntaxError");
    }
    const { data, ports: taken } = ports.pack(message, transfer);
    // Delivered later, and only if the frame still shows a document of the
    // origin asked for (it may have navigated meanwhile).
    hostSetTimeout(() => {
      if (handle.closed() || (wanted !== null && handle.origin() !== wanted)) return;
      handle.post({ data, origin, source: sender, ports: taken });
    }, 0);
  }

  const api = {
    MessageChannel: ports.MessageChannel,
    MessagePort: ports.MessagePort,
    ports,
    postMessage(message, targetOrigin = undefined, transfer = undefined) {
      if (self) post(self, message, targetOrigin, transfer);
      else {
        // A document without frames (no renderer handle): its own window only.
        const { data, ports: taken } = ports.pack(message, transfer);
        api.receive({ data, origin: originOf(window.location?.href ?? ""), source: null, ports: taken });
      }
    },
    proxyFor,
    /** window.frames for this document's window. */
    framesOf: (global) => self ? framesView(self, global) : global,
    contentWindow: (node) => proxyFor(frames?.childOf(node) ?? null),
    contentDocument(node) {
      const handle = frames?.childOf(node) ?? null;
      return handle && sameOrigin(handle) ? handle.document() : null;
    },
    get parent() {
      return proxyFor(frames?.parent ?? null);
    },
    get top() {
      return frames && frames.top !== self ? proxyFor(frames.top) : null;
    },

    /** A message posted to this document's window. */
    receive({ data, origin, source, ports: endpoints }) {
      queueTask(() => {
        const event = realm.messageEvent("message", {
          data, origin, source: source ? proxyFor(source) : null, ports: endpoints.map(ports.adopt),
        });
        window.dispatchEvent(realm.unwrapEvent(event));
      });
    },

    dispose() {
      disposed = true;
      ports.dispose();
    },
  };
  return api;
}
