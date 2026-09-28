/**
 * Controller-side handle for a renderer process.
 *
 * Calls are serialised so page state never interleaves, each call has a
 * deadline, and a renderer that misses one is SIGKILLed; the next call starts
 * a fresh renderer and `onRestart` lets the controller restore the page. It
 * receives a direct caller that bypasses the queue, because the restart runs
 * inside the call that found the renderer gone.
 * Everything the renderer sends is treated as untrusted input.
 */
const ALLOWED_SCHEMES = new Set(["http:", "https:", "data:"]);
const RESOURCE_KINDS = new Set(["stylesheet", "image"]);
const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;

const DEFAULT_ENTRY = new URL("./main.js", import.meta.url).pathname;

export class RendererHost {
  #entry;
  #args;
  #timeout;
  #onRestart;
  #fetch;
  #child = null;
  #ready = null;
  #pending = new Map();
  #nextId = 1;
  #queue = Promise.resolve();
  #restarting = false;
  #sandbox = null;

  /**
   * @param {{
   *   entry?: string,
   *   args?: string[],
   *   timeout?: number,
   *   onRestart?: (call: (method: string, ...params: unknown[]) => Promise<unknown>) => Promise<void>,
   *   fetch?: typeof fetch,
   * }} options
   */
  constructor({ entry = DEFAULT_ENTRY, args = [], timeout = 30_000, onRestart = null, fetch: fetchImpl = fetch } = {}) {
    this.#entry = entry;
    this.#args = args;
    this.#timeout = timeout;
    this.#onRestart = onRestart;
    this.#fetch = fetchImpl;
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
    const child = Bun.spawn({
      cmd: [process.execPath, this.#entry, ...this.#args],
      // No inherited environment: nothing from the controller leaks in.
      env: {},
      stdio: ["ignore", "inherit", "inherit"],
      serialization: "advanced",
      ipc: (message) => {
        if (message?.type === "ready") {
          this.#sandbox = sanitizeSandboxReport(message.sandbox);
          resolveReady();
        }
        else this.#handleMessage(child, message);
      },
      onExit: () => {
        if (this.#child !== child) return;
        this.#child = null;
        this.#ready = null;
        rejectReady(new Error("renderer exited during startup"));
        for (const { reject } of this.#pending.values()) reject(new Error("renderer exited"));
        this.#pending.clear();
      },
    });
    this.#child = child;
    return this.#ready;
  }

  /** Invokes a renderer method; calls run one at a time. */
  call(method, ...params) {
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

  close() {
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
      if (message.error) pending.reject(new Error(`renderer: ${String(message.error).split("\n")[0]}`));
      else pending.resolve(message.result);
    } else if (message.type === "fetch" && Number.isInteger(message.id)) {
      this.#fetchForRenderer(child, message);
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
      const response = await this.#fetch(target);
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength > MAX_RESOURCE_BYTES) return reply({ error: "resource too large" });
      reply({
        result: {
          ok: response.ok,
          status: response.status,
          url: response.url || target.href,
          contentType: response.headers.get("content-type") ?? "",
          body,
        },
      });
    } catch (error) {
      reply({ error: String(error?.message ?? error) });
    }
  }
}

/** Keeps only the expected shape of a renderer's (untrusted) sandbox report. */
function sanitizeSandboxReport(report) {
  const seccomp = report?.seccomp;
  return {
    seccomp: {
      installed: seccomp?.installed === true,
      reason: typeof seccomp?.reason === "string" ? seccomp.reason.slice(0, 200) : null,
    },
  };
}
