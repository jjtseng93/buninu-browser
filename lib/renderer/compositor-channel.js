// Private loopback transport, connected before renderer seccomp. No inherited
// numeric descriptors: node:net also supports Windows sockets.
import {createServer, createConnection} from 'node:net';
import {randomBytes} from 'node:crypto';
const MAX_JSON = 96 * 1024 * 1024;
const MAX_PIXELS = 64 * 1024 * 1024;
const MAX_QUEUE = 128 * 1024 * 1024;

// Length-prefixed JSON followed by optional binary pixels. Copy once into an
// owned packet so a raster lease may be released before the socket drains.
export function encodePacket(message, pixels = null) {
  const json = Buffer.from(JSON.stringify(message));
  const size = pixels?.byteLength ?? 0;
  if (json.length > MAX_JSON || size > MAX_PIXELS || json.length + size > MAX_QUEUE) throw Error('Compositor packet too large');
  const packet = Buffer.allocUnsafe(8 + json.length + size);
  packet.writeUInt32LE(json.length, 0); packet.writeUInt32LE(size, 4);
  packet.set(json, 8); if (size) packet.set(pixels, 8 + json.length);
  return packet;
}

export class PacketReader {
  constructor(receive, limit = MAX_QUEUE) { this.receive = receive; this.limit = limit; this.header = Buffer.alloc(8); this.used = 0; this.packet = null; }
  push(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      const target = this.packet ?? this.header;
      const count = Math.min(target.length - this.used, chunk.length - offset);
      target.set(chunk.subarray(offset, offset + count), this.used);
      this.used += count; offset += count;
      if (this.used !== target.length) continue;
      this.used = 0;
      if (!this.packet) {
        this.jsonLength = this.header.readUInt32LE(0);
        const binaryLength = this.header.readUInt32LE(4);
        const total = this.jsonLength + binaryLength;
        if (!this.jsonLength || this.jsonLength > MAX_JSON || binaryLength > MAX_PIXELS || total > this.limit) throw Error('Invalid compositor packet size');
        this.packet = Buffer.allocUnsafe(total);
      } else {
        const packet = this.packet; this.packet = null;
        const message = JSON.parse(packet.subarray(0, this.jsonLength).toString());
        const pixels = packet.subarray(this.jsonLength);
        this.receive(message, pixels);
      }
    }
  }
}

function attach(socket, receive, closed, limit) {
  socket.setNoDelay(true);
  const reader = new PacketReader(receive, limit);
  socket.on('data', chunk => { try { reader.push(chunk); } catch { socket.destroy(); } });
  socket.on('error', () => {});
  socket.once('close', closed);
  return {
    reader,
    send(message, pixels) {
      if (socket.destroyed) throw Error('Compositor channel closed');
      const packet = encodePacket(message, pixels);
      if (socket.writableLength + packet.length > MAX_QUEUE) { socket.destroy(); throw Error('Compositor channel backpressure limit'); }
      socket.write(packet);
    },
    close() { socket.destroy(); },
  };
}

export async function listenCompositor(receive, closed) {
  const token = randomBytes(32).toString('hex');
  const sockets = new Set(); let peer = null, ended = false;
  const server = createServer(socket => {
    if (ended || peer || sockets.size >= 4) { socket.destroy(); return; }
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), 3000);
    const candidate = attach(socket, (message, pixels) => {
      if (!peer) {
        if (pixels.length || message?.type !== 'hello' || message.token !== token) { socket.destroy(); return; }
        peer = candidate; clearTimeout(timer); candidate.reader.limit = MAX_QUEUE;
        for (const other of sockets) if (other !== socket) other.destroy();
        server.close(); candidate.send({type:'accepted'});
      } else if (peer === candidate) receive(message, pixels);
    }, () => { clearTimeout(timer); sockets.delete(socket); if (peer === candidate && !ended) closed(); }, 4096);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    endpoint: {port:server.address().port, token},
    send(message) { if (!peer || ended) throw Error('Compositor not connected'); peer.send(message); },
    close() { ended = true; server.close(); for (const socket of sockets) socket.destroy(); },
  };
}

export function connectCompositor(endpoint, receive, closed) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({host:'127.0.0.1', port:endpoint.port});
    let accepted = false;
    const timer = setTimeout(() => socket.destroy(), 5000);
    const peer = attach(socket, (message, pixels) => {
      if (!accepted) {
        if (message?.type !== 'accepted' || pixels.length) { socket.destroy(); return; }
        accepted = true; clearTimeout(timer); resolve(peer);
      } else receive(message, pixels);
    }, () => { clearTimeout(timer); if (!accepted) reject(Error('Compositor connection failed')); else closed(); });
    socket.once('connect', () => peer.send({type:'hello', token:endpoint.token}));
  });
}
