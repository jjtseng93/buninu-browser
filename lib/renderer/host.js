/**
 * Controller-side handle for a renderer process.
 *
 * Calls are serialised so page state never interleaves, each call has a
 * deadline, and a renderer that misses one is SIGKILLed; the next call starts
 * a fresh renderer and `onRestart` lets the controller restore the page. It
 * receives a direct caller that bypasses the queue, because the restart runs
 * inside the call that found the renderer gone.
 * Everything the renderer sends is treated as untrusted input.
 *
 * Besides IPC with the renderer's main thread, each renderer gets a second
 * channel (fd 3) to its compositor thread, which answers screenshots and
 * scrolling even while the main thread is busy (see compositor.js).
 */
import { closeSync } from "node:fs";
import { logEnabled, pipeToLog, RENDERER_LOG_FLAG } from "../log.js";
import { NetworkService } from "../network/network-service.js";
import { COMPOSITOR_FLAG } from "./flags.js";

const ALLOWED_SCHEMES = new Set(["http:", "https:", "data:"]);
const FETCH_MODES = new Set(["cors", "no-cors", "same-origin"]);
const CREDENTIALS_MODES = new Set(["omit", "same-origin", "include"]);
const REDIRECT_MODES = new Set(["follow", "error", "manual"]);
const MAX_REQUEST_HEADERS = 100;
const RESOURCE_KINDS = new Set(["stylesheet", "image", "script"]);
const NAVIGATION_SCHEMES = new Set(["http:", "https:", "about:", "data:"]);
const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
const COMPOSITOR_METHODS = new Set(["screenshot", "scroll", "scrollOffset"]);
const COMPOSITOR_TIMEOUT = 10_000;
const MAX_CHANNEL_LINE = 96 * 1024 * 1024;
const LIFECYCLE_NAMES = new Set(["DOMContentLoaded", "load"]);

const DEFAULT_ENTRY = new URL("./main.js", import.meta.url).pathname;

export class RendererHost {
  #entry;
  #args;
  #timeout;
  #onRestart;
  #onNavigate;
  #network;
  // The document this host asked its renderer to load: the trusted origin
  // for everything the renderer requests.
  #documentUrl = "about:blank";
  #child = null;
  #ready = null;
  #pending = new Map();
  #nextId = 1;
  #queue = Promise.resolve();
  #restarting = false;
  #sandbox = null;
  #compositor;
  #channel = null;
  #onFrame;
  #onLifecycle;
  // The compositor's scroll position not yet passed to the main thread.
  #pendingScroll = null;

  /**
   * @param {{
   *   entry?: string,
   *   args?: string[],
   *   timeout?: number,
   *   onRestart?: (call: (method: string, ...params: unknown[]) => Promise<unknown>) => Promise<void>,
   *   onNavigate?: (url: string) => void,
   *   onFrame?: () => void,
   *   onLifecycle?: (name: "DOMContentLoaded" | "load", generation: number) => void,
   *   compositor?: boolean,
   *   fetch?: typeof fetch,
   *   network?: NetworkService,
   * }} options
   */
  constructor({
    entry = DEFAULT_ENTRY, args = [], timeout = 30_000, onRestart = null, onNavigate = null, fetch: fetchImpl = fetch,
    network = new NetworkService({ fetch: fetchImpl }), onFrame = null, onLifecycle = null,
    compositor = entry === DEFAULT_ENTRY,
  } = {}) {
    this.#onFrame = onFrame;
    this.#onLifecycle = onLifecycle;
    this.#compositor = compositor;
    this.#onNavigate = onNavigate;
    this.#entry = entry;
    this.#args = args;
    this.#timeout = timeout;
    this.#onRestart = onRestart;
    this.#network = network;
  }

  /** Starts the renderer if it is not running and waits until it is ready. */
  start() {
    if (this.#ready) return this.#ready;
    let resolveReady;
    let rejectReady;
    this.#ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const logging = logEnabled();
    const compositor = this.#compositor;
    const child = Bun.spawn({
      cmd: [process.execPath, this.#entry, ...this.#args,
        ...(logging ? [RENDERER_LOG_FLAG] : []), ...(compositor ? [COMPOSITOR_FLAG] : [])],
      // No inherited environment: nothing from the controller leaks in.
      env: {},
      // With BUNINU_LOG, output goes through the controller into the log file.
      // fd 3 is a socket to the renderer's compositor thread.
      stdio: ["ignore", logging ? "pipe" : "inherit", logging ? "pipe" : "inherit", ...(compositor ? ["pipe"] : [])],
      serialization: "advanced",
      ipc: (message) => {
        if (message?.type === "ready") {
          this.#sandbox = sanitizeSandboxReport(message.sandbox);
          resolveReady();
        }
        else this.#handleMessage(child, message);
      },
      onExit: (_process, exitCode, signalCode) => {
        this.#closeChannel(channel);
        if (this.#child !== child) return;
        console.error(`buninu-browser: renderer ${child.pid} exited unexpectedly (${signalCode ?? `code ${exitCode}`})`);
        this.#child = null;
        this.#ready = null;
        rejectReady(new Error("renderer exited during startup"));
        for (const { reject } of this.#pending.values()) reject(new Error("renderer exited"));
        this.#pending.clear();
      },
    });
    this.#child = child;
    const channel = compositor && Number.isInteger(child.stdio[3]) ? this.#openChannel(child.stdio[3]) : null;
    this.#channel = channel;
    if (logging) {
      pipeToLog(child.stdout, `renderer ${child.pid}`, (chunk) => process.stdout.write(chunk));
      pipeToLog(child.stderr, `renderer ${child.pid}`, (chunk) => process.stderr.write(chunk));
    }
    return this.#ready;
  }

  /** The URL of the document the renderer was last asked to show. */
  get documentUrl() {
    return this.#documentUrl;
  }

  /** Invokes a renderer method; calls run one at a time. */
  call(method, ...params) {
    // The main thread learns compositor scrolls asynchronously; pass the
    // latest one first, on the same ordered channel, so this call sees it.
    if (this.#pendingScroll && method !== "applyCompositorScroll") {
      const { x, y } = this.#pendingScroll;
      this.#pendingScroll = null;
      this.call("applyCompositorScroll", x, y).catch(() => {});
    }
    if ((method === "loadDocument" || method === "showFragment") && params[0]) {
      this.#documentUrl = String(method === "loadDocument" ? params[0].url : params[0]);
    }
    const run = () => this.#call(method, params);
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => {});
    return result;
  }

  /** What the renderer reported about its sandbox at startup. */
  get sandbox() {
    return this.#sandbox;
  }

  get pid() {
    return this.#child?.pid ?? null;
  }

  /**
   * Screenshot and scrolling, answered by the compositor thread without
   * waiting for the renderer's main thread or its call queue.
   */
  async composite(method, ...params) {
    if (!this.#compositor || !COMPOSITOR_METHODS.has(method)) return this.call(method, ...params);
    // A dead renderer is restarted (and its page restored) through the call path.
    if (!this.#child) await this.call("url");
    await this.start();
    const channel = this.#channel;
    if (!channel) return this.call(method, ...params);
    const result = await new Promise((resolve, reject) => {
      const id = channel.nextId++;
      const timer = setTimeout(() => {
        channel.pending.delete(id);
        reject(new Error(`compositor ${method} timed out after ${COMPOSITOR_TIMEOUT}ms`));
      }, COMPOSITOR_TIMEOUT);
      channel.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      channel.writer.write(`${JSON.stringify({ id, method, params })}\n`);
      channel.writer.flush();
    });
    const sanitized = sanitizeCompositorResult(method, result);
    if (method === "scroll") this.#pendingScroll = sanitized;
    return sanitized;
  }

  #openChannel(fd) {
    const channel = { writer: Bun.file(fd).writer(), pending: new Map(), nextId: 1, closed: false };
    (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for await (const chunk of Bun.file(fd).stream()) {
          buffer += decoder.decode(chunk, { stream: true });
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            this.#handleCompositorLine(channel, buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
          }
          if (buffer.length > MAX_CHANNEL_LINE) buffer = "";
        }
      } catch {
        // The renderer went away.
      }
      this.#closeChannel(channel);
      // Close everything that refers to the socket once, after end of
      // stream, so no descriptor number can have been reused meanwhile.
      try {
        channel.writer.end();
      } catch {
        // Already closed.
      }
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    })();
    return channel;
  }

  #handleCompositorLine(channel, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (channel.closed || typeof message !== "object" || message === null) return;
    if (message.type === "frame") {
      if (this.#channel === channel) this.#onFrame?.();
    } else if (Number.isInteger(message.id) && channel.pending.has(message.id)) {
      const pending = channel.pending.get(message.id);
      channel.pending.delete(message.id);
      if (Object.hasOwn(message, "error")) pending.reject(new Error(`compositor: ${String(message.error).slice(0, 200)}`));
      else pending.resolve(message.result);
    }
  }

  #closeChannel(channel) {
    if (!channel || channel.closed) return;
    channel.closed = true;
    for (const { reject } of channel.pending.values()) reject(new Error("compositor closed"));
    channel.pending.clear();
    if (this.#channel === channel) this.#channel = null;
  }

  close() {
    this.#closeChannel(this.#channel);
    const child = this.#child;
    this.#child = null;
    this.#ready = null;
    child?.kill();
  }

  async #call(method, params, timeout = this.#timeout) {
    if (!this.#child) await this.#restart();
    await this.start();
    const child = this.#child;
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // Watchdog: a renderer that misses its deadline is killed outright.
        this.#child = null;
        this.#ready = null;
        console.error(`buninu-browser: renderer ${child.pid} missed the ${timeout}ms deadline for ${method}; killing it`);
        child.kill(9);
        reject(new Error(`renderer ${method} timed out after ${timeout}ms`));
      }, timeout);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.send({ type: "call", id, method, params });
    });
  }

  async #restart() {
    await this.start();
    if (this.#restarting || !this.#onRestart) return;
    this.#restarting = true;
    try {
      await this.#onRestart((method, ...params) => this.#call(method, params));
    } finally {
      this.#restarting = false;
    }
  }

  #handleMessage(child, message) {
    if (child !== this.#child || typeof message !== "object" || message === null) return;
    if (message.type === "result" && this.#pending.has(message.id)) {
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      // Any error field is a failure, even an empty one (SES can blank error text).
      if (Object.hasOwn(message, "error")) {
        pending.reject(new Error(`renderer: ${String(message.error).split("\n")[0] || "unknown error"}`));
      }
      else pending.resolve(message.result);
    } else if (message.type === "fetch" && Number.isInteger(message.id)) {
      this.#fetchForRenderer(child, message);
    } else if (message.type === "page-fetch" && Number.isInteger(message.id)) {
      this.#pageFetch(child, message);
    } else if (message.type === "lifecycle" && LIFECYCLE_NAMES.has(message.name) && Number.isInteger(message.generation)) {
      this.#onLifecycle?.(message.name, message.generation);
    } else if (message.type === "cookie" && typeof message.value === "string" && message.value.length <= 4096) {
      this.#network.setDocumentCookie(this.#documentUrl, message.value);
    } else if (message.type === "navigate" && typeof message.url === "string") {
      // A page asked to navigate (location.href = ...): validate before obeying.
      let target;
      try {
        target = new URL(message.url);
      } catch {
        return;
      }
      if (NAVIGATION_SCHEMES.has(target.protocol)) this.#onNavigate?.(target.href);
    }
  }

  async #fetchForRenderer(child, { id, url, kind }) {
    const reply = (payload) => {
      if (this.#child === child) child.send({ type: "fetch-result", id, ...payload });
    };
    let target;
    try {
      target = new URL(String(url));
    } catch {
      return reply({ error: "invalid URL" });
    }
    if (!ALLOWED_SCHEMES.has(target.protocol) || !RESOURCE_KINDS.has(kind)) {
      return reply({ error: `blocked ${kind} request for ${target.protocol}` });
    }
    try {
      const response = target.protocol === "data:"
        ? await dataResponse(target)
        : await this.#network.subresource(target.href, this.#documentUrl);
      if (response.body.byteLength > MAX_RESOURCE_BYTES) return reply({ error: "resource too large" });
      reply({
        result: {
          ok: response.ok,
          status: response.status,
          url: response.url || target.href,
          contentType: response.contentType,
          body: response.body,
        },
      });
    } catch (error) {
      reply({ error: String(error?.message ?? error) });
    }
  }

  /** fetch()/XMLHttpRequest from page script: validated, then CORS-checked by the network service. */
  async #pageFetch(child, { id, request }) {
    const reply = (payload) => {
      if (this.#child === child) child.send({ type: "fetch-result", id, ...payload });
    };
    try {
      const sanitized = sanitizePageRequest(request);
      const response = await this.#network.pageFetch(sanitized, this.#documentUrl);
      const { rawHeaders, ...result } = response;
      reply({ result: { ...result, documentCookie: this.#network.documentCookie(this.#documentUrl) } });
    } catch (error) {
      reply({ error: String(error?.message ?? error) });
    }
  }
}

/** Keeps only the expected shape of a renderer's (untrusted) sandbox report. */
function sanitizeSandboxReport(report) {
  const layer = (value) => ({
    installed: value?.installed === true,
    reason: typeof value?.reason === "string" ? value.reason.slice(0, 200) : null,
  });
  return { seccomp: layer(report?.seccomp), ses: layer(report?.ses) };
}

/** Accepts only the expected shape of a page's request description. */
function sanitizePageRequest(request) {
  if (request === null || typeof request !== "object") throw new TypeError("invalid request");
  const url = new URL(String(request.url)).href;
  const headers = Array.isArray(request.headers) ? request.headers.slice(0, MAX_REQUEST_HEADERS) : [];
  const body = request.body instanceof Uint8Array ? request.body : null;
  if (body && body.byteLength > MAX_RESOURCE_BYTES) throw new TypeError("request body too large");
  const pick = (value, allowed, fallback) => allowed.has(value) ? value : fallback;
  return {
    url,
    method: typeof request.method === "string" ? request.method.slice(0, 32) : "GET",
    headers: headers
      .filter((entry) => Array.isArray(entry) && entry.length === 2)
      .map(([name, value]) => [String(name).slice(0, 256), String(value).slice(0, 8192)]),
    body,
    mode: pick(request.mode, FETCH_MODES, "cors"),
    credentials: pick(request.credentials, CREDENTIALS_MODES, "same-origin"),
    redirect: pick(request.redirect, REDIRECT_MODES, "follow"),
  };
}

async function dataResponse(url) {
  const response = await fetch(url);
  return {
    ok: true,
    status: 200,
    url: url.href,
    contentType: response.headers.get("content-type") ?? "",
    body: new Uint8Array(await response.arrayBuffer()),
  };
}

/** Only well-formed compositor answers reach the controller. */
function sanitizeCompositorResult(method, result) {
  if (method === "screenshot") {
    return typeof result === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(result) ? result : "";
  }
  const x = Number(result?.x);
  const y = Number(result?.y);
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
}
