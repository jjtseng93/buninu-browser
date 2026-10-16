/**
 * Pixel buffers may be reused only after both the renderer's current tile and
 * every compositor lease have let go. The idle cache is bounded; in-flight
 * screenshots keep their own leases until their asynchronous encoder finishes.
 */
export class SharedFramePool {
  #records = new WeakMap();
  #leases = new Map();
  #current = null;
  #idle = [];
  #idleBytes = 0;
  #maxBuffers;
  #maxBytes;

  constructor({ maxBuffers = 3, maxBytes = 64 * 1024 * 1024 } = {}) {
    this.#maxBuffers = maxBuffers;
    this.#maxBytes = maxBytes;
  }

  acquire(bytes) {
    let index = this.#idle.findIndex(record => record.buffer.byteLength === bytes);
    if (index < 0) index = this.#idle.findIndex(record => record.buffer.byteLength >= bytes && record.buffer.byteLength <= bytes * 2);
    let record;
    if (index >= 0) {
      [record] = this.#idle.splice(index, 1);
      this.#idleBytes -= record.buffer.byteLength;
      record.idle = false;
    } else {
      record = { buffer: new SharedArrayBuffer(bytes), leases: 0, idle: false };
      this.#records.set(record.buffer, record);
    }
    return new Uint8Array(record.buffer, 0, bytes);
  }

  publish(serial, pixels) {
    const record = this.#records.get(pixels.buffer);
    if (!record) throw new Error("Published pixels do not belong to the shared frame pool");
    const previous = this.#current;
    this.#current = record;
    record.leases++;
    this.#leases.set(serial, record);
    if (previous !== record) this.#recycle(previous);
  }

  release(serial) {
    const record = this.#leases.get(serial);
    if (!record) return;
    this.#leases.delete(serial);
    record.leases--;
    this.#recycle(record);
  }

  #recycle(record) {
    if (!record || record === this.#current || record.leases || record.idle) return;
    if (this.#maxBuffers <= 0 || record.buffer.byteLength > this.#maxBytes) return;
    // Keep the sizes the renderer is using now. Startup/small viewport
    // buffers must not permanently occupy every slot after a resize.
    while (this.#idle.length >= this.#maxBuffers || this.#idleBytes + record.buffer.byteLength > this.#maxBytes) {
      const old = this.#idle.shift();
      old.idle = false;
      this.#idleBytes -= old.buffer.byteLength;
    }
    record.idle = true;
    this.#idle.push(record);
    this.#idleBytes += record.buffer.byteLength;
  }

  clear() {
    // Dropping an owner never makes outstanding pixels available for reuse.
    this.#records = new WeakMap();
    this.#leases.clear();
    this.#current = null;
    this.#idle = [];
    this.#idleBytes = 0;
  }
}

/** Compositor-side leases, independent of renderer frame acknowledgement. */
export class FrameLeaseTracker {
  #current = null;
  #released;

  constructor(released) { this.#released = released; }

  replace(serial, frame) {
    const previous = this.#current;
    this.#current = { serial, frame, readers: 0, retired: false };
    if (previous) { previous.retired = true; this.#release(previous); }
  }

  async capture(read) {
    const lease = this.#current;
    if (!lease) return read(null);
    lease.readers++;
    try { return await read(lease.frame); }
    finally { lease.readers--; this.#release(lease); }
  }

  #release(lease) {
    if (lease.retired && !lease.readers) {
      lease.retired = false;
      this.#released(lease.serial);
    }
  }
}
