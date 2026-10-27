// Fragmented MP4 sync-sample decode times are seek candidates, not decoded
// presentation timestamps. The caller must verify them against its decoder.
// Unsupported layouts return null and retain the ordinary seek search.
const cache = new WeakMap();
const MAX_BOXES = 32768, MAX_SAMPLES = 250000, MAX_KEYS = 16384;

export function mp4KeyframeBefore(bytes, seconds) {
  if (!(bytes instanceof Uint8Array) || !Number.isFinite(seconds)) return null;
  let index = cache.get(bytes);
  if (index === undefined) {
    try { index = inspect(bytes); } catch { index = null; }
    cache.set(bytes, index);
  }
  if (!index?.length) return null;
  let low = 0, high = index.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (index[mid] <= seconds) low = mid + 1;
    else high = mid;
  }
  return low ? index[low - 1] : null;
}

function inspect(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let boxesSeen = 0, samplesSeen = 0;
  const u32 = (at, end) => {
    if (at < 0 || at + 4 > end) throw Error('short MP4 field');
    return view.getUint32(at);
  };
  const u64 = (at, end) => {
    const value = u32(at, end) * 0x100000000 + u32(at + 4, end);
    if (!Number.isSafeInteger(value)) throw Error('large MP4 timestamp');
    return value;
  };
  const boxes = (from, end) => {
    const result = [];
    for (let at = from; at < end;) {
      if (++boxesSeen > MAX_BOXES) throw Error('too many MP4 boxes');
      let size = u32(at, end), header = 8;
      const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
      if (at + header > end) throw Error('short MP4 box');
      if (size === 1) { size = u64(at + 8, end); header = 16; }
      else if (size === 0) size = end - at;
      if (size < header || size > end - at) throw Error('invalid MP4 box size');
      result.push({ type, data: at + header, end: at + size });
      at += size;
    }
    return result;
  };
  const children = box => boxes(box.data, box.end);
  const one = (list, type) => {
    const matches = list.filter(box => box.type === type);
    if (matches.length !== 1) throw Error(`missing/duplicate ${type}`);
    return matches[0];
  };
  const version = box => {
    u32(box.data, box.end);
    if (bytes[box.data] > 1) throw Error('unknown MP4 version');
    return bytes[box.data];
  };
  const flags = box => u32(box.data, box.end) & 0xffffff;
  const top = boxes(0, bytes.length), movie = children(one(top, 'moov'));
  const defaults = new Map();
  for (const box of children(one(movie, 'mvex'))) if (box.type === 'trex') {
    if (version(box) !== 0 || defaults.size >= 32) return null;
    const id = u32(box.data + 4, box.end);
    if (defaults.has(id) || u32(box.data + 8, box.end) !== 1) return null;
    defaults.set(id, { duration: u32(box.data + 12, box.end), flags: u32(box.data + 20, box.end) });
  }
  let track = null;
  for (const box of movie) if (box.type === 'trak') {
    const nodes = children(box), media = children(one(nodes, 'mdia'));
    const handler = one(media, 'hdlr');
    if (u32(handler.data + 8, handler.end) !== 0x76696465) continue; // vide
    if (track) return null;
    const edits = nodes.filter(box => box.type === 'edts');
    if (edits.length > 1) return null;
    if (edits.length) {
      const edit = one(children(edits[0]), 'elst'), wide = version(edit) === 1;
      if (u32(edit.data + 4, edit.end) !== 1) return null;
      const mediaTimeAt = edit.data + (wide ? 16 : 12), rateAt = edit.data + (wide ? 24 : 16);
      if (u32(mediaTimeAt, edit.end) & 0x80000000 || u32(rateAt, edit.end) !== 0x00010000) return null;
      // Only a single forward unit-rate edit is considered. Its offset is
      // deliberately not presented as a decoder timestamp: seek boundary
      // verification must still succeed before this candidate can be used.
    }
    const header = one(nodes, 'tkhd'), timing = one(media, 'mdhd');
    const id = u32(header.data + (version(header) ? 20 : 12), header.end);
    const timescale = u32(timing.data + (version(timing) ? 20 : 12), timing.end);
    if (!timescale || !defaults.has(id)) return null;
    track = { id, timescale, ...defaults.get(id) };
  }
  if (!track) return null;
  const keys = [];
  let lastDecodeTime = -1;
  for (const moof of top) if (moof.type === 'moof') {
    for (const traf of children(moof)) if (traf.type === 'traf') {
      const nodes = children(traf), header = one(nodes, 'tfhd');
      if (u32(header.data + 4, header.end) !== track.id) continue;
      if (version(header) !== 0 || nodes.some(box => box.type === 'sbgp' || box.type === 'sgpd')) return null;
      const hf = flags(header);
      if (hf & ~0x02003b) return null;
      let cursor = header.data + 8, duration = track.duration, sampleFlags = track.flags;
      if (hf & 1) cursor += 8;
      if (hf & 2) { if (u32(cursor, header.end) !== 1) return null; cursor += 4; }
      if (hf & 8) { duration = u32(cursor, header.end); cursor += 4; }
      if (hf & 16) cursor += 4;
      if (hf & 32) { sampleFlags = u32(cursor, header.end); cursor += 4; }
      if (cursor > header.end) return null;
      const timing = one(nodes, 'tfdt');
      let time = version(timing) ? u64(timing.data + 4, timing.end) : u32(timing.data + 4, timing.end);
      for (const run of nodes) if (run.type === 'trun') {
        version(run);
        const rf = flags(run), count = u32(run.data + 4, run.end);
        if (rf & ~0xf05 || (rf & 4) && (rf & 0x400)) return null;
        samplesSeen += count;
        if (samplesSeen > MAX_SAMPLES) return null;
        cursor = run.data + 8;
        if (rf & 1) cursor += 4;
        let firstFlags = sampleFlags;
        if (rf & 4) { firstFlags = u32(cursor, run.end); cursor += 4; }
        for (let i = 0; i < count; i++) {
          let step = duration, sf = i === 0 ? firstFlags : sampleFlags;
          if (rf & 0x100) { step = u32(cursor, run.end); cursor += 4; }
          if (rf & 0x200) cursor += 4;
          if (rf & 0x400) { sf = u32(cursor, run.end); cursor += 4; }
          if (rf & 0x800) cursor += 4; // composition offset does not change decode time
          if (cursor > run.end || !step || time < lastDecodeTime) return null;
          const depends = (sf >>> 24) & 3;
          if (depends === 3) return null;
          if (!(sf & 0x10000) && depends !== 1) {
            if (keys.length >= MAX_KEYS) return null;
            keys.push(time / track.timescale);
          }
          lastDecodeTime = time;
          time += step;
          if (!Number.isSafeInteger(time)) return null;
        }
      }
    }
  }
  return keys;
}
