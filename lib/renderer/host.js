import { RENDER_INTERVAL_FLAG, renderMinInterval } from "./render-interval.js";
import {writeClipboard, readClipboard} from '../clipboard.js';
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
 * authenticated loopback channel to its compositor thread, which answers screenshots and
 * scrolling even while the main thread is busy (see compositor.js).
 */
import {listenCompositor} from "./compositor-channel.js";
import {RawFrames} from "../paint/raw-frames.js";
import { PulseClient } from "../audio/pulse-client.js";
import { SharedAudioConnection } from "../audio/shared-connection.js";
import { logEnabled, pipeToLog, RENDERER_LOG_FLAG, writeLog } from "../log.js";
import { NetworkService } from "../network/network-service.js";
import { COMPOSITOR_FLAG, FULL_STYLE_FLAG, VERIFY_STYLE_FLAG } from "./flags.js";

const ALLOWED_SCHEMES = new Set(["http:", "https:", "data:"]);
const FETCH_MODES = new Set(["cors", "no-cors", "same-origin"]);
const CREDENTIALS_MODES = new Set(["omit", "same-origin", "include"]);
const REDIRECT_MODES = new Set(["follow", "error", "manual"]);
const MAX_REQUEST_HEADERS = 100;
const RESOURCE_KINDS = new Set(["stylesheet", "image", "script", "metadata", "video", "audio", "iframe"]);
const NAVIGATION_SCHEMES = new Set(["http:", "https:", "about:", "data:"]);
// The largest form body a page may POST in a navigation.
const MAX_POST_BYTES = 16 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
// Audio output: one PulseAudio native-protocol connection (jspulse or a
// PulseAudio daemon on 127.0.0.1:4713) shared by every renderer, opened on
// first use. Renderers cannot open sockets, so their audio comes through here.
const pulse = new SharedAudioConnection(() => PulseClient.connect().catch((error) => {
  throw new Error(`no PulseAudio server at 127.0.0.1:4713 (start jspulse): ${error.message}`);
}));
const MAX_AUDIO_STREAMS = 8;
const MAX_AUDIO_CHUNK = 4 * 1024 * 1024;

// WebSockets page script may hold open per renderer, and the largest message either way.
const MAX_WEB_SOCKETS = 64;
const MAX_WEB_SOCKET_MESSAGE = 16 * 1024 * 1024;
const COMPOSITOR_METHODS = new Set(["screenshot", "scroll", "scrollOffset"]);
const COMPOSITOR_TIMEOUT = 10_000;
const LIFECYCLE_NAMES = new Set(["DOMContentLoaded", "load"]);

// A file path, not a URL's pathname ("/C:/..." on Windows).
const DEFAULT_ENTRY = Bun.fileURLToPath(new URL("./main.js", import.meta.url));

export class RendererHost {
  #clipboardRead = readClipboard;
  #clipboardWrite = writeClipboard;
  #clipboardUntil = 0;
  #clipboardPending = false;
  #rawFrames = null;
  #startEpoch = 0;
  #closed = false;
  #rejectStartup = null;
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
  #cookieSequence = 0;
  #cookieRevision = 0;
  #child = null;
  #ready = null;
  #pending = new Map();
  // Page WebSockets: id -> { child, socket } (Bun's WebSocket, opened here)
  #sockets = new Map();
  // Audio streams: id -> { child, stream } (PulseAudio playback streams)
  #audio = new Map();
  // In-flight page fetches, so AbortController reaches the actual HTTP request.
  #pageFetches = new Map();
  #resourceFetches = new Map();
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
   *   onNavigate?: (url: string, downloadName: string | null, fragmentFrom: { x: number, y: number } | null,
   *     post: { method: "POST", body: Uint8Array, contentType: string, referrer: string } | null) => void,
   *   onDownload?: (payload: { url: string, name: string, data: Uint8Array }) => void,
   *   onFrame?: (frame?: { scrollOffset: { x: number, y: number } }) => void,
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
    // A dedicated loopback socket works independently of the main thread on all platforms.
    compositor = entry === DEFAULT_ENTRY,
    clipboardRead = readClipboard,
    clipboardWrite = writeClipboard,
  } = {}) {
    this.#clipboardRead = clipboardRead;
    this.#clipboardWrite = clipboardWrite;
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
    if (this.#closed) return Promise.reject(Error("Renderer is closed"));
    if (this.#ready) return this.#ready;
    let resolveReady;
    let rejectReady;
    this.#ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.#rejectStartup = rejectReady;
    const logging = logEnabled();
    const compositor = this.#compositor;
    const epoch = ++this.#startEpoch;
    void (async () => {
      const channel = compositor ? {pending:new Map(),nextId:1,closed:false,transport:null} : null;
      if (channel) channel.transport = await listenCompositor(
        (message,pixels)=>this.#handleCompositorMessage(channel,message,pixels),
        ()=>this.#closeChannel(channel));
      if (epoch !== this.#startEpoch) { channel?.transport.close(); throw Error('Renderer startup cancelled'); }
      this.#channel = channel;
      // No inherited environment: nothing from the controller leaks in.
      // Windows programs need SystemRoot to load system libraries.
      let env = process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};

      // qml handle begin: applications need HOME/PATH/runtime paths, web pages do not
      if (this.#args.includes("--buninu-qml-host")) env = { ...process.env };
      // qml handle end

      const child = Bun.spawn({
        cmd: [process.execPath, this.#entry, ...this.#args,
          RENDER_INTERVAL_FLAG + renderMinInterval(process.env.BUNINU_RENDER_MIN_INTERVAL),
          ...(logging ? [RENDERER_LOG_FLAG] : []), ...(compositor ? [COMPOSITOR_FLAG, `--compositor-endpoint=${JSON.stringify(channel.transport.endpoint)}`] : []),
          ...(process.env.BUNINU_VERIFY_STYLE ? [VERIFY_STYLE_FLAG] : []), ...(process.env.BUNINU_FULL_STYLE ? [FULL_STYLE_FLAG] : [])],
        env,
        // With BUNINU_LOG, output goes through the controller into the log file.
        stdio: ["ignore", logging ? "pipe" : "inherit", logging ? "pipe" : "inherit"],
        serialization: "advanced",
        ipc: (message) => {
          if (message?.type === "ready") {
            this.#sandbox = sanitizeSandboxReport(message.sandbox);
            this.#rejectStartup=null;
            clearTimeout(startupTimer);
            resolveReady();
          }
          else this.#handleMessage(child, message);
        },
        onExit: (_process, exitCode, signalCode) => {
          clearTimeout(startupTimer);
          this.#closeChannel(channel);
          this.#closeSockets(child);
          this.#closeAudio(child);
          this.#closePageFetches(child);
          rejectReady(new Error("renderer exited during startup"));
          if (this.#child !== child) return;
          console.error(`buninu-browser: renderer ${child.pid} exited unexpectedly (${signalCode ?? `code ${exitCode}`})`);
          this.#child = null;
          this.#ready = null;
          this.#rawFrames?.close(); this.#rawFrames=null;
          for (const { reject } of this.#pending.values()) reject(new Error("renderer exited"));
          this.#pending.clear();
        },
      });
      this.#child = child;
      this.#cookieSequence = 0;
      const startupTimer = setTimeout(() => {
        this.#closeChannel(channel); child.kill(9); rejectReady(Error('Renderer startup timed out'));
      }, this.#timeout);
      if (logging) {
        pipeToLog(child.stdout, `renderer ${child.pid}`, (chunk) => process.stdout.write(chunk));
        pipeToLog(child.stderr, `renderer ${child.pid}`, (chunk) => process.stderr.write(chunk));
      }
    })().catch(error=>{ if(epoch===this.#startEpoch){this.#closeChannel(this.#channel);this.#ready=null;} rejectReady(error); });
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
      if (method === "loadDocument") this.#closeResourceFetches(this.#child);
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
    if (!this.#compositor || !COMPOSITOR_METHODS.has(method)) return this.#captureResult(method, await this.call(method, ...params), params);
    // A dead renderer is restarted (and its page restored) through the call path.
    if (!this.#child) await this.call("url");
    await this.start();
    const channel = this.#channel;
    if (!channel) return this.#captureResult(method, await this.call(method, ...params), params);
    const child = this.#child;
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
      try { channel.transport.send({id,method,params}); }
      catch(error) { channel.pending.get(id).reject(error); channel.pending.delete(id); }
    });
    if (channel.closed || this.#child !== child) throw Error("Renderer closed during capture");
    const sanitized = this.#captureResult(method, result, params, true);
    if (method === "scroll") this.#pendingScroll = sanitized;
    return sanitized;
  }

  #captureResult(method,result,params,ownsPacket=false) {
    if (method === 'screenshot' && ['rgba','bgra'].includes(params[0]?.format)) {
      try {
        if (result?.format !== params[0].format) throw Error('Raw screenshot format mismatch');
        this.#rawFrames ??= new RawFrames();
        return this.#rawFrames.write(result.pixels,result.width,result.height,result.format);
      } finally {
        // PacketReader owns a standalone allocation; write() above is sync.
        // Main-thread IPC fallback buffers have a different ownership contract.
        if (ownsPacket && result?.pixels instanceof Uint8Array) result.pixels.buffer.transfer(0);
      }
    }
    return sanitizeCompositorResult(method,result);
  }

  #handleCompositorMessage(channel, message, pixels) {
    if (channel.closed || typeof message !== "object" || message === null) return;
    if (message.type === "frame") {
      if (this.#channel === channel) {
        const offset = message.scrollOffset;
        const frame = Number.isFinite(offset?.x) && Number.isFinite(offset?.y)
          ? { scrollOffset: { x: offset.x, y: offset.y } } : undefined;
        this.#onFrame?.(frame);
      }
    } else if (Number.isInteger(message.id) && channel.pending.has(message.id)) {
      const pending = channel.pending.get(message.id);
      channel.pending.delete(message.id);
      if (Object.hasOwn(message, "error")) pending.reject(new Error(`compositor: ${String(message.error).slice(0, 200)}`));
      else pending.resolve(pixels.length ? {...message.result,pixels} : message.result);
    }
  }

  #closeChannel(channel) {
    if (!channel || channel.closed) return;
    channel.closed = true;
    channel.transport?.close();
    for (const { reject } of channel.pending.values()) reject(new Error("compositor closed"));
    channel.pending.clear();
    if (this.#channel === channel) this.#channel = null;
  }

  close() {
    this.#closed = true;
    this.#startEpoch++;
    this.#rejectStartup?.(Error("Renderer closed during startup")); this.#rejectStartup=null;
    this.#rawFrames?.close(); this.#rawFrames=null;
    this.#closeChannel(this.#channel);
    const child = this.#child;
    this.#closeSockets(child);
    this.#closeAudio(child);
    this.#closePageFetches(child);
    this.#child = null;
    this.#ready = null;
    for (const {reject} of this.#pending.values()) reject(Error("Renderer closed"));
    this.#pending.clear();
    child?.kill();
  }

  async #call(method, params, timeout = this.#timeout) {
    if (this.#closed) throw Error("Renderer is closed");
    if (!this.#child) await this.#restart();
    await this.start();
    const child = this.#child;
    if (method === 'click' || method === 'press') this.#clipboardUntil = Date.now()+5000;
    if (method === 'loadDocument') this.#clipboardUntil = 0;
    if (method === 'loadDocument' && params[0]) {
      params = [{ ...params[0], cookieState: this.#cookieState() }, ...params.slice(1)];
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // Watchdog: a renderer that misses its deadline is killed outright.
        this.#child = null;
        this.#ready = null;
        console.error(`buninu-browser: renderer ${child.pid} missed the ${timeout}ms deadline for ${method}; killing it`);
        this.#rawFrames?.close(); this.#rawFrames=null;
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
    } else if (['clipboard-read','clipboard-read-input'].includes(message.type) && Number.isInteger(message.id)) {
      const reply = (text, error) => {if(this.#child===child) child.send({type:'clipboard-result',id:message.id,text,error});};
      let secure=false;
      try {const url=new URL(this.#documentUrl); secure=url.protocol==='https:' || (url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname));} catch {}
      if ((!secure && !message.type.endsWith('-input')) || Date.now()>this.#clipboardUntil || this.#clipboardPending) {
        reply(undefined,'Clipboard read requires a recent user action in a secure document'); return;
      }
      this.#clipboardUntil=0; this.#clipboardPending=true;
      Promise.resolve().then(()=>this.#clipboardRead()).then(text=>{
        if(typeof text!=='string'||Buffer.byteLength(text)>1024*1024)throw Error('Clipboard text exceeds limit');
        reply(text);
      }).catch(()=>reply(undefined,'Unable to read system clipboard')).finally(()=>{this.#clipboardPending=false;});
    } else if (['clipboard-write','clipboard-write-input'].includes(message.type) && Number.isInteger(message.id)) {
      const reply = error => { if(this.#child===child)child.send({type:'clipboard-result',id:message.id,...(error?{error}: {})}); };
      let secure=false;
      try { const url=new URL(this.#documentUrl); secure=url.protocol==='https:' || (url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)); } catch {}
      if ((!secure && !message.type.endsWith('-input')) || Date.now()>this.#clipboardUntil || this.#clipboardPending
          || typeof message.text!=='string' || Buffer.byteLength(message.text)>1024*1024) {
        reply('Clipboard write requires a recent user action in a secure document'); return;
      }
      this.#clipboardUntil=0; this.#clipboardPending=true;
      Promise.resolve().then(()=>this.#clipboardWrite(message.text))
        .then(()=>reply(),()=>reply('Unable to write system clipboard'))
        .finally(()=>{this.#clipboardPending=false;});
    } else if (message.type === "fetch" && Number.isInteger(message.id)) {
      this.#fetchForRenderer(child, message);
    } else if (message.type === "page-fetch" && Number.isInteger(message.id)) {
      this.#pageFetch(child, message);
    } else if (message.type === "page-fetch-abort" && Number.isInteger(message.id)) {
      const entry = this.#pageFetches.get(message.id);
      if (entry?.child === child) entry.controller.abort();
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
    } else if (message.type === "audio-resync" && Number.isInteger(message.id)) {
      const entry = this.#audio.get(message.id);
      if (entry?.child === child) (entry.opened ?? Promise.resolve()).then(() => entry.stream?.resync()).catch(() => {});
    } else if (message.type === "audio-close" && Number.isInteger(message.id)) {
      const entry = this.#audio.get(message.id);
      if (entry?.child !== child) return;
      this.#audio.delete(message.id);
      // Tell the renderer how much PCM reached the server: a server may
      // still play what it holds, so the renderer resumes after it.
      (entry.opened ?? Promise.resolve()).then(() => {
        const sentBytes = entry.stream?.sentBytes ?? 0;
        if (this.#child === child) child.send({ type: "audio-event", id: message.id, event: "closed", sentBytes });
        return entry.stream?.close();
      }).catch(() => {
        if (this.#child === child) child.send({ type: "audio-event", id: message.id, event: "closed", sentBytes: 0 });
      });
    } else if (message.type === "lifecycle" && LIFECYCLE_NAMES.has(message.name) && Number.isInteger(message.generation)) {
      this.#onLifecycle?.(message.name, message.generation);
    } else if (message.type === "cookie" && typeof message.value === "string" && message.value.length <= 4096) {
      const url = typeof message.url === "string" ? message.url : this.#documentUrl;
      if (sameOrigin(url, this.#documentUrl)) this.#network.setDocumentCookie(url, message.value);
      if (Number.isSafeInteger(message.sequence) && message.sequence > this.#cookieSequence) {
        this.#cookieSequence = message.sequence;
      }
      child.send({ type: "cookie-state", state: this.#cookieState() });
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
        // A form POST: its body and type from the page; Origin and Referer
        // from the document the renderer shows, which the page cannot choose.
        const post = message.post;
        const request = post && post.method === "POST" && post.body instanceof Uint8Array
          && post.body.byteLength <= MAX_POST_BYTES && typeof post.contentType === "string" && post.contentType.length <= 200
          && !/[\r\n]/.test(post.contentType) && ["http:", "https:"].includes(target.protocol)
          ? { method: "POST", body: post.body, contentType: post.contentType, referrer: this.#documentUrl }
          : null;
        if (post && !request) return;
        this.#onNavigate?.(target.href, download, fragmentFrom, request);
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
      if (this.#child === child) {
        child.send({ type: "audio-event", id, ...payload });
        // The compositor's A/V clock must not wait behind page JavaScript.
        if (payload.event === "timing" && this.#channel && !this.#channel.closed) {
          this.#channel.transport.send({type:"audio-timing",audioId:id,seconds:payload.seconds});
        }
      }
    };
    const owned = [...this.#audio.values()].filter((entry) => entry.child === child).length;
    if (this.#audio.has(id) || owned >= MAX_AUDIO_STREAMS
      || !(Number.isInteger(rate) && rate >= 1000 && rate <= 384000) || !(Number.isInteger(channels) && channels >= 1 && channels <= 8)) {
      send({ event: "error", message: "invalid audio stream" });
      return;
    }
    const entry = { child, stream: null, early: [] };
    entry.opened = pulse.acquire(child)
      .then((client) => {
        if (this.#audio.get(id) !== entry) throw Error("Audio owner closed");
        return client.openPlayback({
        rate, channels, name: String(name ?? "audio").slice(0, 200),
        leadSeconds: name === "piano" ? 0.12 : undefined,
        onRequest: (bytes) => send({ event: "request", bytes }),
        onTiming: name === "piano" ? null : (timing) => send({ event: "timing", ...timing }),
        onTimingError: (error) => send({ event: "timing-error", message: String(error?.message ?? error) }),
      });
      })
      .then((stream) => {
        if (this.#audio.get(id) !== entry) return stream.close();
        entry.stream = stream;
        for (const data of entry.early.splice(0)) stream.write(data);
        send({ event: "ready" });
      }, (error) => {
        if (this.#audio.get(id) !== entry) return;
        this.#audio.delete(id);
        send({ event: "error", message: String(error?.message ?? error) });
      });
    this.#audio.set(id, entry);
  }

  #closeAudio(child) {
    pulse.release(child);
    for (const [id, entry] of this.#audio) {
      if (entry.child !== child) continue;
      this.#audio.delete(id);
      (entry.opened ?? Promise.resolve()).then(() => entry.stream?.close()).catch(() => {});
    }
  }

  #closePageFetches(child) {
    this.#closeResourceFetches(child);
    for (const [id, entry] of this.#pageFetches) {
      if (entry.child !== child) continue;
      this.#pageFetches.delete(id);
      entry.controller.abort();
    }
  }

  #closeResourceFetches(child) {
    for (const [id, entry] of this.#resourceFetches) {
      if (entry.child !== child) continue;
      this.#resourceFetches.delete(id);
      entry.controller.abort();
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
    const entry = { child, controller: new AbortController() };
    this.#resourceFetches.set(id, entry);
    try {
      await this.#fetchResource(child, { id, url, kind }, entry.controller.signal);
    } finally {
      if (this.#resourceFetches.get(id) === entry) this.#resourceFetches.delete(id);
    }
  }

  async #fetchResource(child, { id, url, kind }, signal) {
    const reply = (payload) => {
      if (this.#child === child) child.send({ type: "fetch-result", id, ...payload });
    };
    let target;
    try {
      target = new URL(String(url));
    } catch {
      return reply({ error: "invalid URL" });
    }
    // Local documents may render local resources. Authorize this from the
    // controller's document URL, never from a renderer-supplied referrer.
    const localFile = target.protocol === "file:" && new URL(this.#documentUrl).protocol === "file:";
    if ((!ALLOWED_SCHEMES.has(target.protocol) && !localFile) || !RESOURCE_KINDS.has(kind)) {
      return reply({ error: `blocked ${kind} request for ${target.protocol}` });
    }
    // A renderer only ever holds documents of its own origin (site isolation
    // is by origin): an iframe's document is given to it only when it is
    // same-origin with the page, before and after redirects, and allows
    // being framed.
    const frame = kind === "iframe";
    if (frame && !sameOrigin(target.href, this.#documentUrl)) return reply({ error: "cross-origin frame" });
    // Video and audio over http(s)/file stream. data: stays one response: it is
    // already in hand, and the renderer wraps it in a finished pipe.
    if ((kind === "video" || kind === "audio") && target.protocol !== "data:") {
      const send = (payload) => {
        if (this.#child === child) child.send(payload);
      };
      try {
        await this.#network.streamSubresource(target.href, this.#documentUrl, kind, (event) => {
          if (event.type === "head") {
            send({
              type: "fetch-result", id,
              result: {
                streaming: true,
                ok: event.ok,
                status: event.status,
                statusText: event.statusText ?? "",
                url: event.url || target.href,
                contentType: event.contentType ?? "",
                contentLength: event.contentLength ?? null,
                documentCookie: this.#network.documentCookie(this.#documentUrl), cookieState: this.#cookieState(),
              },
            });
          } else if (event.type === "chunk" && event.data instanceof Uint8Array) {
            send({ type: "fetch-chunk", id, data: event.data });
          } else if (event.type === "end") {
            send({ type: "fetch-end", id });
          } else if (event.type === "error") {
            send({ type: "fetch-error", id, error: String(event.error ?? "media fetch failed") });
          }
        }, { signal });
      } catch (error) {
        send({ type: "fetch-error", id, error: String(error?.message ?? error) });
      }
      return;
    }
    try {
      const response = target.protocol === "data:"
        ? await dataResponse(target)
        : await this.#network.subresource(target.href, this.#documentUrl, kind, { signal });
      if (response.body.byteLength > MAX_RESOURCE_BYTES) return reply({ error: "resource too large" });
      if (frame && !sameOrigin(response.url || target.href, this.#documentUrl)) return reply({ error: "cross-origin frame" });
      if (frame && framingDenied(response.rawHeaders ?? [])) return reply({ error: "framing denied" });
      reply({
        result: {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText ?? "",
          url: response.url || target.href,
          contentType: response.contentType,
          body: response.body,
          documentCookie: this.#network.documentCookie(this.#documentUrl), cookieState: this.#cookieState(),
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
    const started = performance.now();
    const controller = new AbortController();
    const entry = { child, controller };
    this.#pageFetches.set(id, entry);
    let streamHead = false;
    let sanitized = null;
    try {
      sanitized = sanitizePageRequest(request);
      const response = await this.#network.pageFetch(sanitized, this.#documentUrl, {
        signal: controller.signal,
        onChunk: (event) => {
          if (this.#child !== child) return;
          if (event.type === "head") {
            streamHead = true;
            child.send({ type: "page-fetch-head", id, result: {
              ...event.result, documentCookie: this.#network.documentCookie(this.#documentUrl), cookieState: this.#cookieState(),
            } });
          }
          else if (event.type === "chunk") child.send({ type: "page-fetch-chunk", id, data: event.data });
          else if (event.type === "end") child.send({ type: "page-fetch-end", id });
        },
      });
      if (response.streaming) {
        logFetch(sanitized, `${response.status} streaming`, started);
        return;
      }
      const { rawHeaders, ...result } = response;
      logFetch(sanitized, `${response.status} ${response.body?.byteLength ?? 0}B`, started);
      reply({ result: { ...result, documentCookie: this.#network.documentCookie(this.#documentUrl), cookieState: this.#cookieState() } });
    } catch (error) {
      logFetch(sanitized ?? request, `failed: ${error?.message ?? error}`, started);
      if (streamHead && this.#child === child) {
        child.send({ type: "page-fetch-error", id, error: String(error?.message ?? error) });
      } else reply({ error: String(error?.message ?? error) });
    } finally {
      if (this.#pageFetches.get(id) === entry) this.#pageFetches.delete(id);
    }
  }
  #cookieState() {
    return { revision: ++this.#cookieRevision, acknowledged: this.#cookieSequence,
      cookies: this.#network.cookies.scriptSnapshot(this.#documentUrl) };
  }
}

/** With BUNINU_LOG, one line per page fetch()/XMLHttpRequest: method, URL (shortened), outcome, time. */
function logFetch(request, outcome, started) {
  if (!logEnabled()) return;
  const url = String(request?.url ?? "");
  const shown = url.length > 160 ? `${url.slice(0, 160)}…` : url;
  writeLog("fetch", `${request?.method ?? "GET"} ${shown} -> ${outcome} in ${Math.round(performance.now() - started)}ms`);
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

function sameOrigin(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return ["http:", "https:"].includes(a.protocol) && a.origin === b.origin;
  } catch {
    return false;
  }
}

/**
 * Whether a response refuses to be framed (by its own origin, the only case
 * here): X-Frame-Options: DENY, or Content-Security-Policy frame-ancestors 'none'.
 */
function framingDenied(rawHeaders) {
  for (const [name, value] of rawHeaders) {
    const header = String(name).toLowerCase();
    if (header === "x-frame-options" && String(value).trim().toLowerCase() === "deny") return true;
    if (header === "content-security-policy") {
      for (const directive of String(value).split(";")) {
        const [directiveName, ...sources] = directive.trim().toLowerCase().split(/\s+/);
        if (directiveName === "frame-ancestors" && sources.length === 1 && sources[0] === "'none'") return true;
      }
    }
  }
  return false;
}
