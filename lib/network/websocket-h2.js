/**
 * A page WebSocket carried over HTTP/2 (RFC 8441), for a wss: server that only speaks h2.
 *
 * Bun's WebSocket client offers ALPN http/1.1 alone and upgrades with an HTTP/1.1 GET, so an
 * h2-only server refuses it. This opens an HTTP/2 session with node:http2, waits for the
 * server's SETTINGS_ENABLE_CONNECT_PROTOCOL, sends an extended CONNECT (:protocol websocket)
 * and then speaks RFC 6455 frames over that stream. It presents the small part of the
 * WebSocket interface the renderer host uses (binaryType, protocol, extensions, readyState,
 * send, close and the open/message/error/close events), so the host relays it like Bun's.
 *
 * No extension is offered (permessage-deflate included), so every frame must have RSV1-3
 * clear. Client frames are masked, server frames must not be; control frames are at most 125
 * bytes and never fragmented; text must be valid UTF-8. A protocol violation fails the
 * connection with 1002 (1007 for bad UTF-8), as RFC 6455 §7.1.7 and the WHATWG spec ask.
 */
import http2 from "node:http2";
import { randomFillSync } from "node:crypto";

const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
const CLOSE_TIMEOUT_MS = 5000;
const MAX_MESSAGE = 64 * 1024 * 1024;

function eventOf(type, fields = {}) {
  const event = new Event(type);
  for (const [key, value] of Object.entries(fields)) Object.defineProperty(event, key, { value, enumerable: true });
  return event;
}

// Close codes a peer may send (RFC 6455 §7.4.1 and the IANA registry): 1000-1003, 1007-1014,
// and 3000-4999. 1004-1006 and 1015 are reserved and never appear on the wire.
const validCloseCode = (code) => (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);

export class H2WebSocket extends EventTarget {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSING = CLOSING;
  static CLOSED = CLOSED;

  readyState = CONNECTING;
  protocol = "";
  extensions = "";
  binaryType = "arraybuffer";
  url;
  #session = null;
  #stream = null;
  #pending = Buffer.alloc(0);
  #fragments = null;
  #fragmentOpcode = 0;
  #fragmentSize = 0;
  #receivedClose = null;
  #sentClose = false;
  #closeTimer = null;
  #finished = false;
  #requested;

  /**
   * @param {string} url a wss: URL
   * @param {{ headers?: Record<string,string>, protocols?: string[],
   *   connect?: (authority: string, options: object) => import("node:http2").ClientHttp2Session }} [options]
   */
  constructor(url, { headers = {}, protocols = [], connect = (authority, options) => http2.connect(authority, options) } = {}) {
    super();
    const target = new URL(url);
    if (target.protocol !== "wss:") throw new TypeError("WebSocket over HTTP/2 needs a wss: URL");
    this.url = target.href;
    this.#requested = protocols;
    const authority = `https://${target.host}`;
    let session;
    try {
      session = connect(authority, { ALPNProtocols: ["h2"], servername: target.hostname });
    } catch (error) {
      queueMicrotask(() => this.#fail(1006, error));
      return;
    }
    this.#session = session;
    session.on("error", (error) => this.#fail(1006, error));
    session.on("close", () => this.#finish(this.#receivedClose ? this.#receivedClose.code : 1006, this.#receivedClose?.reason ?? "", Boolean(this.#receivedClose && this.#sentClose)));
    // RFC 8441 §3: extended CONNECT only after the server's SETTINGS enable it.
    session.once("remoteSettings", (settings) => {
      if (this.readyState !== CONNECTING) return;
      if (!settings.enableConnectProtocol) return this.#fail(1006, new Error("the server does not accept WebSocket over HTTP/2"));
      const request = {
        ":method": "CONNECT", ":protocol": "websocket", ":scheme": "https",
        ":path": `${target.pathname}${target.search}`, ":authority": target.host,
        "sec-websocket-version": "13",
      };
      for (const [name, value] of Object.entries(headers)) request[name.toLowerCase()] = String(value);
      if (protocols.length) request["sec-websocket-protocol"] = protocols.join(", ");
      let stream;
      try {
        stream = session.request(request, { endStream: false });
      } catch (error) {
        return this.#fail(1006, error);
      }
      this.#stream = stream;
      stream.on("response", (response) => this.#opened(response));
      stream.on("data", (chunk) => this.#receive(chunk));
      stream.on("error", (error) => this.#fail(1006, error));
      stream.on("close", () => this.#finish(this.#receivedClose ? this.#receivedClose.code : 1006, this.#receivedClose?.reason ?? "", Boolean(this.#receivedClose && this.#sentClose)));
    });
  }

  #opened(response) {
    if (this.readyState !== CONNECTING) return;
    const status = Number(response[":status"]);
    if (status < 200 || status > 299) return this.#fail(1006, new Error(`the server answered ${status}`));
    const chosen = String(response["sec-websocket-protocol"] ?? "");
    // The server may only pick one of the requested subprotocols, or none.
    if (chosen && !this.#requested.includes(chosen)) return this.#fail(1006, new Error("the server chose a subprotocol that was not requested"));
    if (response["sec-websocket-extensions"]) return this.#fail(1006, new Error("the server chose an extension that was not offered"));
    this.protocol = chosen;
    this.readyState = OPEN;
    this.dispatchEvent(eventOf("open"));
  }

  send(data) {
    if (this.readyState === CONNECTING) throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
    if (this.readyState !== OPEN) return;
    if (typeof data === "string") return this.#write(0x1, Buffer.from(data, "utf8"));
    if (data instanceof Blob) {
      data.arrayBuffer().then((buffer) => { if (this.readyState === OPEN) this.#write(0x2, Buffer.from(buffer)); });
      return;
    }
    if (data instanceof ArrayBuffer) return this.#write(0x2, Buffer.from(data.slice(0)));
    if (ArrayBuffer.isView(data)) return this.#write(0x2, Buffer.from(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
    return this.#write(0x1, Buffer.from(String(data), "utf8"));
  }

  close(code = undefined, reason = "") {
    if (this.readyState >= CLOSING) return;
    if (this.readyState === CONNECTING) {
      // Closing before the handshake fails the connection (WHATWG WebSockets "close()" step).
      return this.#fail(1006, null);
    }
    this.readyState = CLOSING;
    this.#sendClose(code, reason);
    this.#closeTimer = setTimeout(() => this.#teardown(), CLOSE_TIMEOUT_MS);
  }

  #sendClose(code, reason) {
    if (this.#sentClose) return;
    this.#sentClose = true;
    let payload = Buffer.alloc(0);
    if (code !== undefined) {
      const text = Buffer.from(String(reason ?? ""), "utf8");
      payload = Buffer.alloc(2 + text.length);
      payload.writeUInt16BE(code, 0);
      text.copy(payload, 2);
    }
    this.#write(0x8, payload);
  }

  // One frame from this client: FIN set, masked (RFC 6455 §5.3).
  #write(opcode, payload) {
    const stream = this.#stream;
    if (!stream || stream.destroyed) return;
    const length = payload.length;
    const header = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    if (length < 126) header[1] = 0x80 | length;
    else if (length < 65536) { header[1] = 0x80 | 126; header.writeUInt16BE(length, 2); }
    else { header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(length), 2); }
    const mask = randomFillSync(Buffer.alloc(4));
    const masked = Buffer.alloc(length);
    for (let i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i & 3];
    stream.write(Buffer.concat([header, mask, masked]));
  }

  #receive(chunk) {
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : Buffer.from(chunk);
    while (this.readyState !== CLOSED && this.#pending.length >= 2) {
      const first = this.#pending[0], second = this.#pending[1];
      const fin = (first & 0x80) !== 0, opcode = first & 0x0f;
      if (first & 0x70) return this.#protocolError("a reserved bit is set");
      if (second & 0x80) return this.#protocolError("the server masked a frame");
      let length = second & 0x7f, offset = 2;
      if (length === 126) {
        if (this.#pending.length < 4) return;
        length = this.#pending.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.#pending.length < 10) return;
        const big = this.#pending.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.#fail(1009, new Error("the message is too big"));
        length = Number(big); offset = 10;
      }
      // Reject advertised oversized frames before buffering their payload.
      if (length > MAX_MESSAGE) return this.#fail(1009, new Error("the message is too big"));
      if (opcode >= 0x8 && (!fin || length > 125)) return this.#protocolError("a control frame is fragmented or too long");
      if (this.#pending.length < offset + length) return;
      const payload = this.#pending.subarray(offset, offset + length);
      this.#pending = this.#pending.subarray(offset + length);
      if (opcode >= 0x8) {
        if (!fin || length > 125) return this.#protocolError("a control frame is fragmented or too long");
        this.#control(opcode, Buffer.from(payload));
        continue;
      }
      if (opcode === 0x0) {
        if (!this.#fragments) return this.#protocolError("a continuation frame without a message");
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (this.#fragments) return this.#protocolError("a new message inside a fragmented one");
        this.#fragments = [];
        this.#fragmentOpcode = opcode;
        this.#fragmentSize = 0;
      } else {
        return this.#protocolError(`unknown opcode ${opcode}`);
      }
      this.#fragmentSize += length;
      if (this.#fragmentSize > MAX_MESSAGE) return this.#fail(1009, new Error("the message is too big"));
      this.#fragments.push(Buffer.from(payload));
      if (!fin) continue;
      const whole = Buffer.concat(this.#fragments), kind = this.#fragmentOpcode;
      this.#fragments = null;
      if (this.readyState !== OPEN) continue;
      if (kind === 0x1) {
        let text;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(whole); }
        catch { return this.#fail(1007, new Error("the text is not UTF-8")); }
        this.dispatchEvent(eventOf("message", { data: text }));
      } else {
        const buffer = whole.buffer.slice(whole.byteOffset, whole.byteOffset + whole.byteLength);
        this.dispatchEvent(eventOf("message", { data: this.binaryType === "blob" ? new Blob([buffer]) : buffer }));
      }
    }
  }

  #control(opcode, payload) {
    if (opcode === 0x9) {
      if (this.readyState === OPEN || this.readyState === CLOSING) this.#write(0xA, payload);
      return;
    }
    if (opcode === 0xA) return;
    if (opcode !== 0x8) return this.#protocolError(`unknown control opcode ${opcode}`);
    if (payload.length === 1) return this.#protocolError("a close frame with a one-byte body");
    let code = 1005, reason = "";
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!validCloseCode(code)) return this.#protocolError(`close code ${code}`);
      try { reason = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2)); }
      catch { return this.#fail(1007, new Error("the close reason is not UTF-8")); }
    }
    this.#receivedClose = { code, reason };
    if (this.readyState === OPEN) this.readyState = CLOSING;
    // Echo the code (RFC 6455 §5.5.1), then end our side of the stream.
    this.#sendClose(code === 1005 ? undefined : code, "");
    this.#teardown();
  }

  #protocolError(message) {
    this.#fail(1002, new Error(message));
  }

  // _Fail the WebSocket Connection_: an error event, then close 1006 (or the given code) unclean.
  #fail(code, error) {
    if (this.#finished) return;
    if (this.readyState === OPEN && code !== 1006) this.#sendClose(code, "");
    this.#failure = error;
    this.#teardown(code, true);
  }
  #failure = null;

  #teardown(code = undefined, failed = false) {
    clearTimeout(this.#closeTimer);
    try { this.#stream?.end(); } catch {}
    try { this.#stream?.close?.(); } catch {}
    try { this.#session?.close(); } catch {}
    if (failed) this.#finish(1006, "", false, true);
    else this.#finish(this.#receivedClose?.code ?? 1006, this.#receivedClose?.reason ?? "", Boolean(this.#receivedClose && this.#sentClose));
  }

  #finish(code, reason, wasClean, failed = false) {
    if (this.#finished) return;
    this.#finished = true;
    clearTimeout(this.#closeTimer);
    this.readyState = CLOSED;
    try { this.#session?.destroy(); } catch {}
    if (failed || !wasClean && code === 1006) this.dispatchEvent(eventOf("error", { message: String(this.#failure?.message ?? "") }));
    this.dispatchEvent(eventOf("close", { code, reason, wasClean }));
  }
}
