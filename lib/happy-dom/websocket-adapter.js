import { Buffer } from "buffer";

const NativeWebSocket = globalThis.WebSocket;

/**
 * Adapts Bun's standards-based WebSocket client to the small EventEmitter-like
 * interface Happy DOM currently consumes from the `ws` package.
 */
export default class BunWebSocketAdapter {
  #socket;
  #listeners = new Map();
  extensions = {};

  constructor(url, protocols = []) {
    this.#socket = new NativeWebSocket(url, protocols);
  }

  get protocol() {
    return this.#socket.protocol;
  }

  on(type, listener) {
    return this.#add(type, listener, false);
  }

  once(type, listener) {
    if (type === "upgrade") return this;
    return this.#add(type, listener, true);
  }

  send(data) {
    this.#socket.send(data);
  }

  close(code, reason) {
    this.#socket.close(code, reason == null ? undefined : String(reason));
  }

  terminate() {
    this.#socket.close();
  }

  #add(type, listener, once) {
    const wrapped = (event) => {
      if (once) this.#socket.removeEventListener(type, wrapped);
      if (type === "message") {
        const data = event.data;
        listener(data, typeof data !== "string");
      } else if (type === "close") {
        listener(event.code, Buffer.from(event.reason));
      } else if (type === "error") {
        listener(event.error ?? new Error("WebSocket error"));
      } else {
        listener();
      }
    };
    this.#socket.addEventListener(type, wrapped);
    this.#listeners.set(listener, wrapped);
    return this;
  }
}

