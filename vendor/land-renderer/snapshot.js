// A fresh, compositor-owned copy. After filling, snapshots are immutable: workers
// may share them, but never receive writable client SHM or DMA-BUF mappings.
export function allocateSnapshot(length) {
  return typeof SharedArrayBuffer === "function"
    ? Buffer.from(new SharedArrayBuffer(length))
    : Buffer.alloc(length);
}

// Snapshot objects are immutable after publication. Share the opacity result
// between full-frame validation and composition rather than scanning twice.
const opacity = new WeakMap();
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
export function snapshotOpaque(buffer, bytes = buffer.bytes) {
  const cached = opacity.get(buffer);
  if (cached !== undefined) return cached;
  const {width, height, stride} = buffer;
  let opaque = true;
  if (littleEndian && bytes.byteOffset % 4 === 0 && stride % 4 === 0) {
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, stride * height / 4);
    const rowWords = stride / 4;
    for (let row = 0; row < height && opaque; row++) {
      const end = row * rowWords + width;
      for (let i = row * rowWords; i < end; i++) {
        if ((words[i] >>> 24) !== 255) { opaque = false; break; }
      }
    }
  } else {
    for (let row = 0; row < height && opaque; row++) {
      const end = row * stride + width * 4;
      for (let i = row * stride + 3; i < end; i += 4) {
        if (bytes[i] !== 255) { opaque = false; break; }
      }
    }
  }
  opacity.set(buffer, opaque);
  return opaque;
}
