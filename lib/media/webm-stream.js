/** EBML element header, without reading or scanning the element's payload. */
export function ebmlHeader(bytes, offset = 0) {
  const vint = (at, id = false) => {
    if (at >= bytes.length || bytes[at] === 0) return null;
    let length = 1, mask = 0x80;
    while (!(bytes[at] & mask)) { length++; mask >>= 1; }
    if (at + length > bytes.length) return null;
    let value = id ? bytes[at] : bytes[at] & (mask - 1);
    let unknown = !id && value === mask - 1;
    for (let i = 1; i < length; i++) {
      value = value * 256 + bytes[at + i];
      unknown &&= bytes[at + i] === 0xff;
    }
    return { length, value, unknown };
  };
  const id = vint(offset, true);
  const size = id && vint(offset + id.length);
  if (!size || (!size.unknown && !Number.isSafeInteger(size.value))) return null;
  return { id: id.value, length: id.length + size.length, size: size.unknown ? Infinity : size.value };
}

const SEGMENT = 0x18538067, CLUSTER = 0x1f43b675;
// An unknown-size Cluster ends at another Segment child, never at an ID
// which merely happens to occur inside an encoded audio/video packet.
const LEVEL_ONE = new Set([0x1a45dfa3, SEGMENT, CLUSTER, 0x114d9b74,
  0x1549a966, 0x1654ae6b, 0x1c53bb6b, 0x1941a469, 0x1043a770, 0x1254c367]);

/** Reassembles complete WebM elements across arbitrary SourceBuffer appends.
 * Segment headers are emitted separately; their children (especially each
 * Cluster) remain separate so retries can be discarded without new media.
 * Pending input is kept as views and copied only when an element completes.
 */
export function createWebMStream() {
  const chunks = [];
  let available = 0, unknown = null;
  const peek = count => {
    count = Math.min(count, available);
    if (chunks[0]?.length >= count) return chunks[0].subarray(0, count);
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) {
      const n = Math.min(chunk.length, count - offset);
      bytes.set(chunk.subarray(0, n), offset); offset += n;
      if (offset === count) break;
    }
    return bytes;
  };
  const take = count => {
    const bytes = peek(count);
    available -= count;
    for (let left = count; left > 0;) {
      const chunk = chunks[0];
      if (left < chunk.length) { chunks[0] = chunk.subarray(left); break; }
      chunks.shift(); left -= chunk.length;
    }
    return bytes;
  };
  const parse = (final = false) => {
    const result = [];
    while (available) {
      const header = ebmlHeader(peek(16));
      if (!header) break;
      if (unknown && LEVEL_ONE.has(header.id)) {
        result.push({ closedCluster: unknown }); unknown = null; continue;
      }
      if (unknown) {
        const size = header.length + header.size;
        if (!Number.isFinite(size) || size > available) break;
        const bytes = take(size);
        if (header.id === 0xe7) {
          let time = 0;
          for (let i = header.length; i < bytes.length; i++) time = time * 256 + bytes[i];
          unknown.time = time;
          unknown.prefix.push(bytes);
        } else if (header.id === 0xa3 || header.id === 0xa0) {
          // Live streams may use one Cluster indefinitely. A complete Block
          // is independently delimited, so expose it without waiting for the
          // next Cluster. The writer inserts its original prefix only once.
          result.push({ id: CLUSTER, bytes, cluster: { token: unknown, time: unknown.time, prefix: unknown.prefix } });
          unknown.delivered = true;
        } else if (!unknown.delivered) unknown.prefix.push(bytes);
      } else if (header.id === SEGMENT) {
        result.push({ id: SEGMENT, bytes: take(header.length) });
      } else if (header.id === CLUSTER && !Number.isFinite(header.size)) {
        unknown = { prefix: [take(header.length)], time: 0, delivered: false, accepted: false };
      } else {
        const size = header.length + header.size;
        if (!Number.isFinite(size) || size > available) break;
        result.push({ id: header.id, bytes: take(size) });
      }
    }
    if (final && unknown && !available) { result.push({ closedCluster: unknown }); unknown = null; }
    return result;
  };
  return {
    append(bytes) {
      if (bytes.length) { chunks.push(bytes); available += bytes.length; }
      return parse();
    },
    finish() { return parse(true); },
    get pendingSize() {
      return available + (unknown && !unknown.accepted ? unknown.prefix.reduce((sum, part) => sum + part.length, 0) : 0);
    },
    reset() { chunks.length = 0; available = 0; unknown = null; },
  };
}
