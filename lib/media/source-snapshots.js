import { createBytePipe } from './byte-pipe.js';

// MSE may replace an MP4 initialization segment while old frames are still
// buffered. A file demuxer cannot consume that sequence as one MP4: keep each
// initialization and its fragments together, sharing the original byte views.
export function createSourceSnapshots(inspect) {
  const epochs = [];
  const pending = [];
  let pendingSize = 0, headers = [], candidate = null, current = null;
  let skipMedia = false, serial = 0, fragment = null, openEnded = false;
  const join = parts => parts.length === 1 ? parts[0] : Bun.concatArrayBuffers(parts);
  const bytesOf = parts => {
    const bytes = join(parts);
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  };
  const same = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);
  const take = count => {
    const parts = [];
    pendingSize -= count;
    while (count > 0) {
      const first = pending.shift(), length = Math.min(count, first.length);
      parts.push(first.subarray(0, length));
      if (length < first.length) pending.unshift(first.subarray(length));
      count -= length;
    }
    return bytesOf(parts);
  };
  const peekHeader = () => {
    if (pending[0].length >= Math.min(16, pendingSize)) return pending[0];
    const header = new Uint8Array(Math.min(16, pendingSize));
    let offset = 0;
    for (const part of pending) {
      const length = Math.min(part.length, header.length - offset);
      header.set(part.subarray(0, length), offset); offset += length;
      if (offset === header.length) break;
    }
    return header;
  };
  const activate = start => {
    if (!candidate) return current;
    candidate.startTime = Number.isFinite(start) ? start : 0;
    epochs.push(candidate);
    current = candidate;
    candidate = null;
    return current;
  };
  const accept = (type, bytes) => {
    if (type === 'ftyp') { headers = [bytes]; return true; }
    if (type === 'moov') {
      if (current && same(current.header, bytes)) { headers = []; candidate = null; return false; }
      if (candidate && same(candidate.header, bytes)) { headers = []; return false; }
      const pipe = createBytePipe(), state = {};
      for (const header of headers) pipe.append(header);
      pipe.append(bytes);
      inspect(bytes, state);
      candidate = { id: ++serial, pipe, state, header: bytes.slice(), startTime: 0, covered: [], fragments: [], cached: null };
      headers = [];
      fragment = null;
      skipMedia = false;
      return true;
    }
    if (type === 'moof') {
      const epoch = candidate ?? current;
      if (!epoch) { headers.push(bytes); return true; }
      const end = inspect(bytes, epoch.state), start = epoch.state.appendStart;
      activate(start);
      skipMedia = Number.isFinite(start) && Number.isFinite(end)
        && current.covered.some(([from, to]) => from <= start + 0.002 && to + 0.002 >= end);
      if (!skipMedia) {
        if (Number.isFinite(start)) current.startTime = Math.min(current.startTime, start);
        fragment = { start: Number.isFinite(start) ? start : current.startTime, pipe: createBytePipe() };
        fragment.pipe.append(bytes);
        current.fragments.push(fragment);
        current.cached = null;
        if (Number.isFinite(start) && Number.isFinite(end)) current.covered.push([start, end]);
      }
      return !skipMedia;
    }
    if (type === 'mdat') {
      activate(0); // A non-fragmented MP4 has no tfdt/moof timeline.
      if (!current) { headers.push(bytes); return true; }
      if (!skipMedia) { (fragment?.pipe ?? current.pipe).append(bytes); current.cached = null; }
      return !skipMedia;
    }
    if (candidate) candidate.pipe.append(bytes);
    else if (current && !skipMedia) { (fragment?.pipe ?? current.pipe).append(bytes); current.cached = null; }
    else headers.push(bytes);
    return true;
  };
  return {
    append(bytes) {
      if (openEnded && current) { (fragment?.pipe ?? current.pipe).append(bytes); current.cached = null; return true; }
      if (bytes.length) { pending.push(bytes); pendingSize += bytes.length; }
      let accepted = false;
      while (pendingSize >= 8) {
        const header = peekHeader(), view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        let size = view.getUint32(0), headerSize = 8;
        const type = String.fromCharCode(...header.subarray(4, 8));
        // A zero-sized final mdat extends to EOF, including later appends.
        if (size === 0 && type === 'mdat') { size = pendingSize; openEnded = true; }
        if (size === 1) {
          if (pendingSize < 16) break;
          const large = view.getBigUint64(8);
          if (large > BigInt(Number.MAX_SAFE_INTEGER)) break;
          size = Number(large); headerSize = 16;
        }
        if (size < headerSize || size > pendingSize) break;
        accepted = accept(type, take(size)) || accepted;
      }
      return accepted || pendingSize > 0;
    },
    at(seconds = 0) {
      let selected = null;
      for (const epoch of epochs) {
        if (epoch.startTime <= seconds + 1e-6 && (!selected || epoch.startTime >= selected.startTime)) selected = epoch;
      }
      selected ??= epochs[0] ?? candidate;
      if (!selected) return { id: 0, startTime: 0, endTime: Infinity, bytes: bytesOf([...headers, ...pending]) };
      let endTime = Infinity;
      for (const epoch of epochs) if (epoch.startTime > selected.startTime && epoch.startTime < endTime) endTime = epoch.startTime;
      selected.cached ??= bytesOf([selected.pipe.bytes(), ...selected.fragments.slice()
        .sort((a, b) => a.start - b.start).map(fragment => fragment.pipe.bytes())]);
      return { id: selected.id, startTime: selected.startTime, endTime, bytes: selected.cached };
    },
  };
}
