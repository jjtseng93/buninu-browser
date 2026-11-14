import { afterAll, beforeAll, expect, test } from "bun:test";
import http2 from "node:http2";
import { NetworkService } from "../lib/network/network-service.js";
import { RendererHost } from "../lib/renderer/host.js";

// WebSocket over HTTP/2 (RFC 8441, lib/network/websocket-h2.js) against an h2-only server that
// answers extended CONNECT and speaks RFC 6455 frames, as the WPT ?wpt_flags=h2 server does.
const key = await Bun.file(new URL("./fixtures/tls/localhost.key", import.meta.url)).text();
const cert = await Bun.file(new URL("./fixtures/tls/localhost.pem", import.meta.url)).text();

let server, port;
const seen = [];

// Server side framing: client frames arrive masked, server frames go out unmasked.
function frame(opcode, payload, { masked = false, fin = true } = {}) {
  const body = Buffer.from(payload);
  const length = body.length;
  const header = length < 126 ? Buffer.from([0, length]) : Buffer.from([0, 126, length >> 8, length & 255]);
  header[0] = (fin ? 0x80 : 0) | opcode;
  if (!masked) return Buffer.concat([header, body]);
  header[1] |= 0x80;
  const mask = Buffer.from([1, 2, 3, 4]);
  return Buffer.concat([header, mask, Buffer.from(body.map((b, i) => b ^ mask[i & 3]))]);
}
function frames(stream, onFrame) {
  let pending = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      let length = pending[1] & 0x7f, offset = 2;
      if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }
      const masked = (pending[1] & 0x80) !== 0;
      if (pending.length < offset + (masked ? 4 : 0) + length) return;
      const mask = masked ? pending.subarray(offset, offset + 4) : null;
      offset += masked ? 4 : 0;
      const payload = Buffer.from(pending.subarray(offset, offset + length).map((b, i) => (mask ? b ^ mask[i & 3] : b)));
      onFrame({ opcode: pending[0] & 0x0f, masked, payload });
      pending = pending.subarray(offset + length);
    }
  });
}

beforeAll(async () => {
  server = http2.createSecureServer({ key, cert, allowHTTP1: false, settings: { enableConnectProtocol: true }, unknownProtocolTimeout: 200 });
  server.on("stream", (stream, headers) => {
    seen.push({ method: headers[":method"], protocol: headers[":protocol"], path: headers[":path"], origin: headers.origin,
      version: headers["sec-websocket-version"], protocols: headers["sec-websocket-protocol"] });
    if (headers[":method"] !== "CONNECT" || headers[":protocol"] !== "websocket") { stream.respond({ ":status": 400 }); stream.end(); return; }
    const offered = String(headers["sec-websocket-protocol"] ?? "").split(/,\s*/).filter(Boolean);
    stream.respond({ ":status": 200, ...(offered.length ? { "sec-websocket-protocol": offered.at(-1) } : {}) });
    const path = headers[":path"];
    if (path === "/masked") return stream.write(frame(0x1, "bad", { masked: true }));
    if (path === "/badutf8") return stream.write(frame(0x1, Buffer.from([0xff, 0xfe])));
    // Echo: text and binary back, a fragmented greeting first, a ping, and close echoed.
    stream.write(frame(0x1, "hel", { fin: false }));
    stream.write(frame(0x0, "lo"));
    stream.write(frame(0x9, "p"));
    frames(stream, ({ opcode, masked, payload }) => {
      if (!masked) return stream.close();
      if (opcode === 0x1 || opcode === 0x2) stream.write(frame(opcode, payload));
      else if (opcode === 0xA) stream.write(frame(0x1, "pong:" + payload.toString()));
      else if (opcode === 0x8) { stream.write(frame(0x8, payload)); stream.end(); }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});
afterAll(() => server?.close());

const trusting = () => new NetworkService({
  // The fixture certificate is self-signed: trust it for the h2 session and the HTTP/1.1 try alike.
  http2Connect: (authority, options) => http2.connect(authority, { ...options, rejectUnauthorized: false }),
  webSocket: (url, options) => new WebSocket(url, { ...options, tls: { rejectUnauthorized: false } }),
});

const collect = (socket) => new Promise((resolve) => {
  const events = [];
  socket.addEventListener("open", () => events.push(["open", socket.protocol]));
  socket.addEventListener("message", ({ data }) => {
    events.push(["message", typeof data === "string" ? data : [...new Uint8Array(data)]]);
    if (data === "hello") { socket.send("text"); socket.send(new Uint8Array([1, 2, 3])); }
    if (data === "pong:p") socket.close(4000, "done");
  });
  socket.addEventListener("error", () => events.push(["error"]));
  socket.addEventListener("close", ({ code, reason, wasClean }) => { events.push(["close", code, reason, wasClean]); resolve(events); });
});

test("a WebSocket over HTTP/2 sends extended CONNECT, carries frames both ways and closes cleanly", async () => {
  seen.length = 0;
  const socket = trusting().webSocketOverH2(`wss://localhost:${port}/echo?x=1`, ["chat", "superchat"], "https://page.test/");
  const events = await collect(socket);
  expect(seen[0]).toEqual({ method: "CONNECT", protocol: "websocket", path: "/echo?x=1", origin: "https://page.test",
    version: "13", protocols: "chat, superchat" });
  // The replies to "hello" go out while it is handled, before the ping behind it is read.
  expect(events).toEqual([["open", "superchat"], ["message", "hello"], ["message", "text"], ["message", [1, 2, 3]],
    ["message", "pong:p"], ["close", 4000, "done", true]]);
});

test("a masked server frame or invalid UTF-8 fails the connection", async () => {
  for (const path of ["/masked", "/badutf8"]) {
    const events = await collect(trusting().webSocketOverH2(`wss://localhost:${port}${path}`, [], "https://page.test/"));
    expect(events).toEqual([["open", ""], ["error"], ["close", 1006, "", false]]);
  }
});

test("a page's wss: socket to an h2-only server opens over HTTP/2, and an ordinary one does not", async () => {
  const host = new RendererHost({ timeout: 20_000, network: trusting() });
  const plain = Bun.serve({ port: 0, fetch(request, server) { return server.upgrade(request) ? undefined : new Response("no"); },
    websocket: { message(socket, message) { socket.send("plain:" + message); } } });
  try {
    await host.start();
    seen.length = 0;
    await host.call("loadDocument", {
      url: "https://page.test/", contentType: "text/html", status: 200,
      source: `<script>
        var log = [];
        const run = (url, done) => { const ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
          ws.onopen = () => log.push(url.split(':')[0] + ':open');
          ws.onmessage = (e) => { log.push(e.data); if (e.data === 'hello') ws.close(1000); else if (String(e.data).startsWith('plain:')) ws.close(); };
          ws.onerror = () => log.push('error');
          ws.onclose = (e) => { log.push('close:' + e.code); done && done(); }; ws.addEventListener('open', () => url.startsWith('ws:') && ws.send('x')); };
        run('wss://localhost:${port}/echo', () => run('ws://127.0.0.1:${plain.port}/'));
      </script>`,
    });
    let log = [];
    for (let i = 0; i < 100 && !(log = await host.call("evaluate", "log")).includes("close:1005"); i++) await Bun.sleep(50);
    expect(log).toEqual(["wss:open", "hello", "close:1000", "ws:open", "plain:x", "close:1005"]);
    expect(seen.map((s) => s.method)).toEqual(["CONNECT"]);
  } finally {
    host.close();
    plain.stop(true);
  }
}, 30000);

test("a wss: server that is not there still fails once: one error, one close 1006", async () => {
  const host = new RendererHost({ timeout: 20_000, network: trusting() });
  try {
    await host.start();
    await host.call("loadDocument", {
      url: "https://page.test/", contentType: "text/html", status: 200,
      source: `<script>var log = []; const ws = new WebSocket('wss://127.0.0.1:1/');
        ws.onopen = () => log.push('open'); ws.onerror = () => log.push('error'); ws.onclose = (e) => log.push('close:' + e.code + ':' + e.wasClean);</script>`,
    });
    let log = [];
    for (let i = 0; i < 100 && !(log = await host.call("evaluate", "log")).some((e) => e.startsWith("close")); i++) await Bun.sleep(50);
    await Bun.sleep(300);
    expect(await host.call("evaluate", "log")).toEqual(["error", "close:1006:false"]);
  } finally {
    host.close();
  }
}, 30000);
