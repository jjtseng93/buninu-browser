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
  const packet = Buffer.allocUnsafeSlow(8 + json.length + size);
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
        this.packet = Buffer.allocUnsafeSlow(total);
      } else {
        const packet = this.packet; this.packet = null;
        const message = JSON.parse(packet.subarray(0, this.jsonLength).toString());
        const pixels = packet.subarray(this.jsonLength);
        this.receive(message, pixels);
      }
    }
  }
}

// Serialize complete packets, including their two writes, so control messages
// cannot land between an owned frame's header and pixels. Do not cork these
// writes: Bun's node:net _writev joins chunks with Buffer.concat.
export class PacketWriter {
  constructor(socket, limit = MAX_QUEUE) {
    this.socket = socket; this.limit = limit; this.queue = []; this.bytes = 0;
    this.current = null; this.waiting = false; this.pumping = false; this.closed = false;
    socket.on('error', () => this.close());
    socket.once('close', () => {
      this.close();
      // A destroyed socket can still have a pending native write until its
      // callback/close event. Only now is its last borrowed buffer disposable.
      this.release(this.current); this.current = null;
    });
  }
  release(entry) {
    if (!entry || entry.released) return;
    entry.released = true;
    if (entry.queued) this.bytes -= entry.size;
    for (const buffer of entry.buffers) buffer.transfer(0);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.queue) this.release(entry);
    this.queue.length = 0;
    this.socket.destroy();
  }
  pump() {
    if (this.pumping || this.waiting || this.closed) return;
    this.pumping = true;
    try {
      while (!this.waiting && !this.closed) {
        this.current ??= this.queue.shift();
        const entry = this.current;
        if (!entry) break;
        if (entry.index === entry.parts.length) {
          this.release(entry); this.current = null; continue;
        }
        this.waiting = true;
        try {
          this.socket.write(entry.parts[entry.index++], error => {
            if (entry !== this.current || entry.released) return;
            this.waiting = false;
            if (error || this.closed || this.socket.destroyed) {
              this.close(); this.release(entry); this.current = null;
            } else this.pump();
          });
        } catch (error) {
          // Some header bytes may already be on the wire. Closing is required
          // even when write throws synchronously, or the next packet is corrupt.
          this.close();
          return error;
        }
      }
    } finally { this.pumping = false; }
  }
  send(message, pixels, {takeOwnership = false} = {}) {
    const entry = {parts:[], buffers:[], index:0, size:0, queued:false, released:false};
    try {
      if (takeOwnership) {
        if (!(pixels instanceof Uint8Array) || !(pixels.buffer instanceof ArrayBuffer))
          throw TypeError('Owned compositor pixels must have a private ArrayBuffer');
        // The caller gives up this entire buffer, including on a rejected send.
        entry.buffers.push(pixels.buffer);
      }
      if (this.closed || this.socket.destroyed) throw Error('Compositor channel closed');
      const packet = encodePacket(message, takeOwnership ? null : pixels);
      entry.buffers.push(packet.buffer);
      entry.parts.push(packet);
      if (takeOwnership) {
        const size = pixels.byteLength;
        if (size > MAX_PIXELS || packet.length - 8 + size > MAX_QUEUE) throw Error('Compositor packet too large');
        packet.writeUInt32LE(size, 4);
        if (size) entry.parts.push(pixels);
      }
      entry.size = entry.parts.reduce((size, part) => size + part.byteLength, 0);
      if (this.bytes + entry.size > this.limit) {
        this.close(); throw Error('Compositor channel backpressure limit');
      }
      entry.queued = true; this.bytes += entry.size; this.queue.push(entry);
      const error = this.pump();
      if (error) throw error;
    } catch (error) {
      if (!entry.queued) this.release(entry);
      throw error;
    }
  }
}

function attach(socket, receive, closed, limit) {
  socket.setNoDelay(true);
  const reader = new PacketReader(receive, limit);
  const writer = new PacketWriter(socket);
  socket.on('data', chunk => { try { reader.push(chunk); } catch { socket.destroy(); } });
  socket.once('close', closed);
  return {
    reader,
    send(message, pixels, options) { writer.send(message, pixels, options); },
    close() { writer.close(); },
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
