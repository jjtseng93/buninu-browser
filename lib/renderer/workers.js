/**
 * Dedicated workers (HTML §10.2) for a document's realm. A worker's script
 * runs in a compartment of its own with a worker global scope; messages in
 * both directions are structured clones delivered as tasks.
 *
 * Workers run on the renderer's one thread, interleaved with the page's
 * tasks: a worker that computes for long holds the page up meanwhile.
 *
 * importScripts() loads synchronously, which the renderer's network cannot:
 * the scripts a worker names with string literals (and those they name in
 * turn) are fetched before it starts, and importScripts() runs those.
 */
import { CONSTRUCTOR_HELPER, rewriteClassicScript, rewriteConstructorReads } from "./script-rewrite.js";
import { createPorts } from "./messaging.js";

// Captured before lockdown.
// importScripts('a.js', "b.js"): the literal arguments of each call.
const IMPORT_CALL = /\bimportScripts\s*\(([^)]*)\)/g;
const STRING_LITERAL = /(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const MAX_IMPORTED_SCRIPTS = 32;
const MAX_IMPORT_DEPTH = 4;

/** The script URLs a worker script passes to importScripts() as string literals. */
function literalImports(source, base) {
  const urls = [];
  for (const call of String(source).matchAll(IMPORT_CALL)) {
    for (const literal of call[1].matchAll(STRING_LITERAL)) {
      try {
        urls.push(new URL(literal[2].replace(/\\(.)/g, "$1"), base).href);
      } catch {
        // An invalid URL fails when it is imported.
      }
    }
  }
  return urls;
}
const hostSetTimeout = globalThis.setTimeout;
const hostClearTimeout = globalThis.clearTimeout;

/**
 * @param {{
 *   realm: object, documentUrl(): string, fetchScript(url: string): Promise<string>,
 *   runTask(task: () => void): void, callPage(fn: Function, thisArg: object, args: unknown[]): unknown,
 *   reportError(error: unknown, url?: string): void, DOMException: Function,
 *   globals: object, constructorHelper(compartment: object): Function,
 *   pagePorts: ReturnType<typeof createPorts>,
 * }} options
 * @returns {{ Worker: Function, dispose(): void }}
 */
export function createWorkers({
  realm, documentUrl, fetchScript, runTask, callPage, reportError, DOMException, globals, constructorHelper, pagePorts,
}) {
  const live = new Set();

  /** Listeners and on* handlers of a worker or its global scope. */
  function eventTarget(owner) {
    const listeners = [];
    const handlers = {};
    return {
      add(type, listener) {
        if (typeof listener !== "function" && typeof listener?.handleEvent !== "function") return;
        if (!listeners.some((entry) => entry.type === type && entry.listener === listener)) listeners.push({ type, listener });
      },
      remove(type, listener) {
        const index = listeners.findIndex((entry) => entry.type === type && entry.listener === listener);
        if (index >= 0) listeners.splice(index, 1);
      },
      handler: (type) => handlers[type] ?? null,
      setHandler(type, value) {
        handlers[type] = typeof value === "function" ? value : null;
      },
      dispatch(event, call) {
        const handler = handlers[event.type];
        if (handler) call(handler, owner(), [event]);
        for (const { type, listener } of [...listeners]) {
          if (type !== event.type) continue;
          if (typeof listener === "function") call(listener, owner(), [event]);
          else call(listener.handleEvent, listener, [event]);
        }
      },
    };
  }

  function Worker(scriptURL, options = undefined) {
    if (!new.target) throw new TypeError("Constructor Worker requires 'new'");
    let url;
    try {
      url = new URL(String(scriptURL), documentUrl());
    } catch {
      throw new DOMException(`Failed to construct 'Worker': invalid URL '${scriptURL}'`, "SyntaxError");
    }
    const page = new URL(documentUrl());
    if (!["blob:", "data:"].includes(url.protocol) && url.origin !== page.origin) {
      throw new DOMException(`Script at '${url.href}' cannot be accessed from origin '${page.origin}'`, "SecurityError");
    }
    if (options?.type === "module") throw new TypeError("Module workers are not supported");

    const worker = Object.create(Worker.prototype);
    const outside = eventTarget(() => worker);
    const inside = eventTarget(() => scope);
    const timers = new Map();
    let nextTimer = 1;
    let terminated = false;
    let started = false;
    // Messages to the worker wait until its script has run.
    const pending = [];

    const state = {
      outside,
      terminate() {
        terminated = true;
        workerPorts.dispose();
        for (const handle of timers.values()) hostClearTimeout(handle);
        timers.clear();
        pending.length = 0;
        live.delete(state);
      },
    };
    live.add(state);
    states.set(worker, state);

    // ---- the worker's side
    const workerTask = (task) => {
      if (terminated) return;
      try {
        task();
      } catch (error) {
        workerError(error);
      }
    };
    const workerCall = (fn, thisArg, args) => {
      if (typeof fn === "function") Reflect.apply(fn, thisArg, args);
    };
    const schedule = (handler, delay, args, repeat) => {
      const id = nextTimer++;
      const fire = () => {
        if (!timers.has(id)) return;
        if (repeat) timers.set(id, hostSetTimeout(fire, Math.max(4, Number(delay) || 0)));
        else timers.delete(id);
        workerTask(() => typeof handler === "function" ? Reflect.apply(handler, scope, args) : evaluate(String(handler)));
      };
      timers.set(id, hostSetTimeout(fire, Math.max(0, Number(delay) || 0)));
      return id;
    };
    const cancel = (id) => {
      hostClearTimeout(timers.get(Number(id)));
      timers.delete(Number(id));
    };
    const messageFor = (target, data, ports = []) => Object.freeze({
      type: "message", data, origin: "", lastEventId: "", source: null, ports: Object.freeze([...ports]),
      target, currentTarget: target, bubbles: false, cancelable: false, defaultPrevented: false,
      timeStamp: globals.performance.now(), preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
    });

    const scopeGlobals = {
      ...globals,
      location: Object.freeze({
        href: url.href, origin: url.origin, protocol: url.protocol, host: url.host, hostname: url.hostname,
        port: url.port, pathname: url.pathname, search: url.search, hash: url.hash, toString: () => url.href,
      }),
      postMessage(message, transfer = undefined) {
        const { data, ports: taken } = workerPorts.pack(message, Array.isArray(transfer) ? transfer : transfer?.transfer);
        hostSetTimeout(() => {
          if (terminated) return;
          runTask(() => outside.dispatch(realm.messageEvent("message", { data, ports: taken.map(pagePorts.adopt) }), callPage));
        }, 0);
      },
      MessageChannel: undefined,
      MessagePort: undefined,
      setTimeout: (handler, delay = 0, ...args) => schedule(handler, delay, args, false),
      setInterval: (handler, delay = 0, ...args) => schedule(handler, delay, args, true),
      clearTimeout: cancel,
      clearInterval: cancel,
      queueMicrotask: (callback) => Promise.resolve().then(() => workerTask(() => workerCall(callback, scope, []))),
      close() {
        state.terminate();
      },
      importScripts(...urls) {
        for (const value of urls) {
          let target;
          try {
            target = new URL(String(value), url).href;
          } catch {
            throw new DOMException(`Failed to execute 'importScripts': invalid URL '${value}'`, "SyntaxError");
          }
          const source = imported.get(target);
          if (typeof source !== "string") throw new DOMException(`The script at '${target}' failed to load`, "NetworkError");
          evaluate(source);
        }
      },
      addEventListener: (type, listener) => inside.add(String(type), listener),
      removeEventListener: (type, listener) => inside.remove(String(type), listener),
    };
    // The worker's own message ports; ports move between it and the page.
    const workerPorts = createPorts({
      makeEvent: (data, adopted) => messageFor(scope, data, adopted),
      queueTask: (task) => hostSetTimeout(() => workerTask(task), 0),
      call: workerCall,
      DOMException,
    });
    scopeGlobals.MessageChannel = workerPorts.MessageChannel;
    scopeGlobals.MessagePort = workerPorts.MessagePort;
    const compartment = new Compartment({ globals: scopeGlobals, __options__: true });
    const scope = compartment.globalThis;
    const helper = constructorHelper(compartment);
    Object.defineProperty(scope, CONSTRUCTOR_HELPER, { value: helper });
    Object.defineProperty(scope, "Function", { value: helper.Function, writable: true, configurable: true });
    Object.defineProperty(scope, "self", { value: scope, writable: true, configurable: true });
    for (const type of ["message", "messageerror", "error"]) {
      Object.defineProperty(scope, `on${type}`, {
        configurable: true,
        get: () => inside.handler(type),
        set: (value) => inside.setHandler(type, value),
      });
    }
    const evaluate = (source) => compartment.evaluate(rewriteClassicScript(rewriteConstructorReads(source).code).code, {
      sloppyGlobalsMode: true,
      __evadeImportExpressionTest__: true,
      __evadeHtmlCommentTest__: true,
      __rejectSomeDirectEvalExpressions__: false,
    });

    function workerError(error) {
      reportError(error, url.href);
      const message = String(error?.message ?? error);
      hostSetTimeout(() => {
        if (terminated) return;
        runTask(() => outside.dispatch(Object.freeze({
          type: "error", message, filename: url.href, lineno: 0, colno: 0, error: null,
          target: worker, currentTarget: worker, preventDefault() {}, stopPropagation() {},
        }), callPage));
      }, 0);
    }

    const deliverInside = ({ data, ports }) => {
      hostSetTimeout(() => workerTask(() => inside.dispatch(messageFor(scope, data, ports.map(workerPorts.adopt)), workerCall)), 0);
    };
    state.post = (message) => {
      if (terminated) return;
      if (started) deliverInside(message);
      else pending.push(message);
    };

    // Scripts it imports with literal URLs, fetched ahead (see importScripts).
    const imported = new Map();
    const prefetch = async (source, base, depth) => {
      for (const target of literalImports(source, base)) {
        if (imported.has(target) || imported.size >= MAX_IMPORTED_SCRIPTS) continue;
        imported.set(target, null);
        try {
          const text = await fetchScript(target);
          imported.set(target, text);
          if (depth < MAX_IMPORT_DEPTH) await prefetch(text, target, depth + 1);
        } catch {
          imported.delete(target);
        }
      }
    };

    fetchScript(url.href).then(async (source) => {
      await prefetch(source, url.href, 0);
      if (terminated) return;
      workerTask(() => evaluate(source));
      started = true;
      for (const data of pending.splice(0)) deliverInside(data);
    }, (error) => workerError(error));
    return worker;
  }

  const states = new WeakMap();
  const stateOf = (worker) => {
    const state = states.get(worker);
    if (!state) throw new TypeError("Illegal invocation");
    return state;
  };
  Worker.prototype = {
    constructor: Worker,
    postMessage(message, transfer = undefined) {
      const state = stateOf(this);
      state.post(pagePorts.pack(message, Array.isArray(transfer) ? transfer : transfer?.transfer));
    },
    terminate() {
      stateOf(this).terminate();
    },
    addEventListener(type, listener) {
      stateOf(this).outside.add(String(type), listener);
    },
    removeEventListener(type, listener) {
      stateOf(this).outside.remove(String(type), listener);
    },
  };
  for (const type of ["message", "messageerror", "error"]) {
    Object.defineProperty(Worker.prototype, `on${type}`, {
      configurable: true,
      enumerable: true,
      get() {
        return stateOf(this).outside.handler(type);
      },
      set(value) {
        stateOf(this).outside.setHandler(type, value);
      },
    });
  }

  return {
    Worker,
    dispose() {
      for (const state of [...live]) state.terminate();
    },
  };
}
