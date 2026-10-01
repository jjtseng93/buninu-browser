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
import { PulseClient } from "../audio/pulse-client.js";
import { logEnabled, pipeToLog, RENDERER_LOG_FLAG } from "../log.js";
import { NetworkService } from "../network/network-service.js";
import { COMPOSITOR_FLAG } from "./flags.js";

const ALLOWED_SCHEMES = new Set(["http:", "https:", "data:"]);
const FETCH_MODES = new Set(["cors", "no-cors", "same-origin"]);
const CREDENTIALS_MODES = new Set(["omit", "same-origin", "include"]);
const REDIRECT_MODES = new Set(["follow", "error", "manual"]);
const MAX_REQUEST_HEADERS = 100;
const RESOURCE_KINDS = new Set(["stylesheet", "image", "script", "metadata", "video", "audio"]);
const NAVIGATION_SCHEMES = new Set(["http:", "https:", "about:", "data:"]);
const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
// Audio output: one PulseAudio native-protocol connection (jspulse or a
// PulseAudio daemon on 127.0.0.1:4713) shared by every renderer, opened on
// first use. Renderers cannot open sockets, so their audio comes through here.
let pulse = null;
function pulseClient() {
  pulse ??= PulseClient.connect().catch((error) => {
    pulse = null;
    throw new Error(`no PulseAudio server at 127.0.0.1:4713 (start jspulse): ${error.message}`);
  });
  return pulse;
}
const MAX_AUDIO_STREAMS = 8;
const MAX_AUDIO_CHUNK = 4 * 1024 * 1024;

// WebSockets page script may hold open per renderer, and the largest message either way.
const MAX_WEB_SOCKETS = 64;
const MAX_WEB_SOCKET_MESSAGE = 16 * 1024 * 1024;
const COMPOSITOR_METHODS = new Set(["screenshot", "scroll", "scrollOffset"]);
const COMPOSITOR_TIMEOUT = 10_000;
const MAX_CHANNEL_LINE = 96 * 1024 * 1024;
const LIFECYCLE_NAMES = new Set(["DOMContentLoaded", "load"]);

// A file path, not a URL's pathname ("/C:/..." on Windows).
const DEFAULT_ENTRY = Bun.fileURLToPath(new URL("./main.js", import.meta.url));

export class RendererHost {
  #entry;
  #args;
  #timeout;
  #onRestart;
  #onNavigate;
  #onDownload;
  #network;
  // The document this host asked its renderer to load: the trusted origin
  // for everything the renderer requests.
  #documentUrl = "about:blank";
  #child = null;
  #ready = null;
  #pending = new Map();
  // Page WebSockets: id -> { child, socket } (Bun's WebSocket, opened here)
  #sockets = new Map();
  // Audio streams: id -> { child, stream } (PulseAudio playback streams)
  #audio = new Map();
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
   *   onNavigate?: (url: string, downloadName: string | null, fragmentFrom: { x: number, y: number } | null) => void,
   *   onDownload?: (payload: { url: string, name: string, data: Uint8Array }) => void,
   *   onFrame?: () => void,
   *   onLifecycle?: (name: "DOMContentLoaded" | "load", generation: number) => void,
   *   compositor?: boolean,
   *   fetch?: typeof fetch,
   *   network?: NetworkService,
   * }} options
   */
  constructor({
    entry = DEFAULT_ENTRY, args = [], timeout = 30_000, onRestart = null, onNavigate = null, onDownload = null,
    fetch: fetchImpl = fetch,
    network = new NetworkService({ fetch: fetchImpl }), onFrame = null, onLifecycle = null,
    // The compositor's channel is an extra stdio pipe used as fd 3, which
    // Windows does not have (Bun hands out libuv pipes there, not file
    // descriptors): there the main thread answers screenshots and scrolling.
    compositor = entry === DEFAULT_ENTRY && process.platform !== "win32",
  } = {}) {
    this.#onFrame = onFrame;
    this.#onLifecycle = onLifecycle;
    this.#compositor = compositor;
    this.#onNavigate = onNavigate;
    this.#onDownload = onDownload;
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
      // Windows programs need SystemRoot to load system libraries.
      env: process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
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
        this.#closeSockets(child);
        this.#closeAudio(child);
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
    this.#closeSockets(child);
    this.#closeAudio(child);
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
    } else if (message.type === "ws-open" && Number.isInteger(message.id)) {
      this.#openSocket(child, message);
    } else if (message.type === "ws-send" && Number.isInteger(message.id)) {
      const entry = this.#sockets.get(message.id);
      const { data } = message;
      const size = typeof data === "string" ? data.length : data instanceof Uint8Array ? data.byteLength : Infinity;
      if (entry?.child === child && size <= MAX_WEB_SOCKET_MESSAGE && entry.socket.readyState === WebSocket.OPEN) {
        entry.socket.send(data);
      }
    } else if (message.type === "ws-close" && Number.isInteger(message.id)) {
      const entry = this.#sockets.get(message.id);
      if (entry?.child !== child) return;
      const code = Number.isInteger(message.code) ? message.code : undefined;
      entry.socket.close(code, typeof message.reason === "string" ? message.reason.slice(0, 123) : undefined);
    } else if (message.type === "audio-open" && Number.isInteger(message.id)) {
      this.#openAudio(child, message);
    } else if (message.type === "audio-data" && Number.isInteger(message.id)) {
      const entry = this.#audio.get(message.id);
      if (entry?.child === child && message.data instanceof Uint8Array && message.data.byteLength <= MAX_AUDIO_CHUNK) {
        // Audio that arrives before the stream is open waits for it.
        if (entry.stream) entry.stream.write(message.data);
        else entry.early.push(message.data);
      }
    } else if (message.type === "audio-finish" && Number.isInteger(message.id)) {
      const entry = this.#audio.get(message.id);
      if (entry?.child !== child) return;
      const send = (payload) => this.#child === child && child.send({ type: "audio-event", id: message.id, ...payload });
      (entry.opened ?? Promise.resolve()).then(() => entry.stream?.finish()).then(() => {
        this.#audio.delete(message.id);
        send({ event: "ended" });
      }, () => this.#audio.delete(message.id));
    } else if (message.type === "audio-close" && Number.isInteger(message.id)) {
      const entry = this.#audio.get(message.id);
      if (entry?.child !== child) return;
      this.#audio.delete(message.id);
      (entry.opened ?? Promise.resolve()).then(() => entry.stream?.close()).catch(() => {});
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
      if (NAVIGATION_SCHEMES.has(target.protocol)) {
        const download = typeof message.download === "string" ? message.download.slice(0, 200) : null;
        const from = message.fragmentFrom;
        const fragmentFrom = from && Number.isFinite(from.x) && Number.isFinite(from.y) ? { x: from.x, y: from.y } : null;
        this.#onNavigate?.(target.href, download, fragmentFrom);
      }
    } else if (message.type === "download-data" && typeof message.url === "string"
      && message.data instanceof Uint8Array && message.data.byteLength <= 64 * 1024 * 1024) {
      let target;
      try { target = new URL(message.url); } catch { return; }
      if (target.protocol !== "blob:") return;
      this.#onDownload?.({ url: target.href, name: typeof message.name === "string" ? message.name.slice(0, 200) : "",
        data: message.data });
    }
  }

  /** new WebSocket() from page script: opened here with Bun's WebSocket, events relayed back. */
  #openSocket(child, { id, url, protocols }) {
    const send = (payload) => {
      if (this.#child === child) child.send({ type: "ws-event", id, ...payload });
    };
    if (this.#sockets.has(id)) return;
    const owned = [...this.#sockets.values()].filter((entry) => entry.child === child).length;
    let socket;
    try {
      if (owned >= MAX_WEB_SOCKETS) throw new Error("too many WebSockets");
      const list = Array.isArray(protocols) ? protocols.slice(0, 16).map((value) => String(value).slice(0, 256)) : [];
      socket = this.#network.webSocket(String(url), list, this.#documentUrl);
    } catch (error) {
      send({ event: "error", message: String(error?.message ?? error) });
      send({ event: "close", code: 1006, reason: "", wasClean: false });
      return;
    }
    socket.binaryType = "arraybuffer";
    this.#sockets.set(id, { child, socket });
    socket.addEventListener("open", () => send({ event: "open", protocol: socket.protocol ?? "", extensions: socket.extensions ?? "" }));
    socket.addEventListener("message", ({ data }) => {
      const payload = typeof data === "string" ? data : new Uint8Array(data);
      if ((payload.length ?? payload.byteLength) > MAX_WEB_SOCKET_MESSAGE) return socket.close(1009);
      send({ event: "message", data: payload });
    });
    socket.addEventListener("error", () => send({ event: "error" }));
    socket.addEventListener("close", ({ code, reason, wasClean }) => {
      this.#sockets.delete(id);
      send({ event: "close", code, reason, wasClean });
    });
  }

  /** A renderer's audio element starts playing: a PulseAudio stream relays its PCM. */
  #openAudio(child, { id, rate, channels, name }) {
    const send = (payload) => {
      if (this.#child === child) child.send({ type: "audio-event", id, ...payload });
    };
    const owned = [...this.#audio.values()].filter((entry) => entry.child === child).length;
    if (this.#audio.has(id) || owned >= MAX_AUDIO_STREAMS
      || !(Number.isInteger(rate) && rate >= 1000 && rate <= 384000) || !(Number.isInteger(channels) && channels >= 1 && channels <= 8)) {
      send({ event: "error", message: "invalid audio stream" });
      return;
    }
    const entry = { child, stream: null, early: [] };
    entry.opened = pulseClient()
      .then((client) => client.openPlayback({
        rate, channels, name: String(name ?? "audio").slice(0, 200),
        leadSeconds: name === "piano" ? 0.12 : undefined,
        onRequest: (bytes) => send({ event: "request", bytes }),
      }))
      .then((stream) => {
        if (this.#audio.get(id) !== entry) return stream.close();
        entry.stream = stream;
        for (const data of entry.early.splice(0)) stream.write(data);
      }, (error) => {
        this.#audio.delete(id);
        send({ event: "error", message: String(error?.message ?? error) });
      });
    this.#audio.set(id, entry);
  }

  #closeAudio(child) {
    for (const [id, entry] of this.#audio) {
      if (entry.child !== child) continue;
      this.#audio.delete(id);
      (entry.opened ?? Promise.resolve()).then(() => entry.stream?.close()).catch(() => {});
    }
  }

  #closeSockets(child) {
    for (const [id, entry] of this.#sockets) {
      if (entry.child !== child) continue;
      this.#sockets.delete(id);
      try {
        entry.socket.close();
      } catch {}
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
          documentCookie: this.#network.documentCookie(this.#documentUrl),
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
