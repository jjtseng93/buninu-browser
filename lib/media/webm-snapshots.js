import { ebmlHeader } from './webm-stream.js';

const CLUSTER = 0x1f43b675;
const MAX_RECORDS = 250_000;
const join = parts => parts.length === 1 ? parts[0] : new Uint8Array(Bun.concatArrayBuffers(parts));

// Decode-time snapshots for a single Opus track. A PCM-only decoder cannot
// represent holes in a WebM timeline: concatenating 0..2s and 6..8s produces
// four seconds of samples, not eight. Keep each contiguous run independently
// decodable, without changing any packet or inventing samples for the hole.
export function createWebMAudioSnapshots() {
  const headers = [], records = [];
  let scale = 1_000_000, track = null, valid = true, runs = null, serial = 0, ordered = true;
  const uint = (bytes, from, size) => {
    if (size < 1 || size > 6 || from + size > bytes.length) throw Error('invalid integer');
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + bytes[from + i];
    return value;
  };
  const children = (bytes, from, end) => {
    const result = [];
    for (let at = from; at < end;) {
      if (result.length >= 65_536) throw Error('too many elements');
      const head = ebmlHeader(bytes, at);
      if (!head || !Number.isFinite(head.size) || head.size > end - at - head.length) throw Error('incomplete element');
      const data = at + head.length;
      result.push({ id: head.id, data, size: head.size, end: data + head.size });
      at = data + head.size;
    }
    return result;
  };
  const payload = bytes => {
    const head = ebmlHeader(bytes);
    if (!head || head.size !== bytes.length - head.length) throw Error('incomplete element');
    return children(bytes, head.length, bytes.length);
  };
  const opusDuration = (bytes, at, end) => {
    if (at >= end) throw Error('empty packet');
    const toc = bytes[at], config = toc >> 3;
    const frame = config >= 16 ? 2.5 * 2 ** (config & 3)
      : config >= 12 ? 10 * 2 ** (config & 1) : [10, 20, 40, 60][config & 3];
    const code = toc & 3;
    if (code === 3 && at + 1 >= end) throw Error('incomplete packet');
    const count = code === 0 ? 1 : code === 3 ? bytes[at + 1] & 63 : 2;
    const duration = frame * count / 1000;
    if (!count || duration > 0.12) throw Error('invalid Opus duration');
    return duration;
  };
  const blockRange = (bytes, block, origin) => {
    const from = block.data;
    if (!bytes[from]) throw Error('invalid track');
    let length = 1, marker = 0x80;
    while (!(bytes[from] & marker)) { length++; marker >>= 1; }
    if (length > 6 || from + length + 3 > block.end) throw Error('invalid block');
    let number = bytes[from] & (marker - 1);
    for (let i = 1; i < length; i++) number = number * 256 + bytes[from + i];
    if (number !== track) throw Error('another track');
    const at = from + length;
    // Lacing requires a separate packet table; leave that format on the
    // ordinary decoder path until its timing can be proved as well.
    if (bytes[at + 2] & 6) throw Error('laced block');
    const relative = new DataView(bytes.buffer, bytes.byteOffset + at, 2).getInt16(0);
    const start = (origin + relative) * scale / 1e9;
    if (!Number.isFinite(start) || start < 0) throw Error('invalid timestamp');
    return { start, end: start + opusDuration(bytes, at + 3, block.end) };
  };
  const record = (element) => {
    const { bytes, cluster } = element;
    const items = cluster ? children(bytes, 0, bytes.length) : payload(bytes);
    let origin = cluster?.time;
    if (origin == null) {
      const time = items.find(item => item.id === 0xe7);
      if (!time) throw Error('missing cluster time');
      origin = uint(bytes, time.data, time.size);
    }
    let start = null, end = null;
    for (const item of items) {
      let block = item, padding = 0;
      if (item.id === 0xa0) {
        const group = children(bytes, item.data, item.end);
        block = group.find(child => child.id === 0xa1);
        const discard = group.find(child => child.id === 0x75a2);
        if (discard) {
          if (bytes[discard.data] & 0x80) throw Error('negative discard padding');
          padding = uint(bytes, discard.data, discard.size) / 1e9;
        }
      } else if (item.id !== 0xa3) continue;
      if (!block) throw Error('missing block');
      const range = blockRange(bytes, block, origin);
      range.end -= padding;
      if (range.end <= range.start) throw Error('invalid padding');
      if (end != null && Math.abs(range.start - end) > scale / 1e9 + 1e-6) throw Error('discontinuous cluster');
      start ??= range.start;
      end = range.end;
    }
    if (start == null) return;
    if (records.length >= MAX_RECORDS) throw Error('too many blocks');
    if ((cluster?.prefix.length ?? 0) > 65_536) throw Error('too much cluster metadata');
    if (records.length && start < records.at(-1).start) ordered = false;
    records.push({ id: ++serial, start, end, bytes, token: cluster?.token,
      prefix: cluster?.prefix.slice() });
    runs = null;
  };
  const buildRuns = () => {
    const sorted = ordered ? records : records.slice().sort((a, b) => a.start - b.start);
    const result = [];
    for (const entry of sorted) {
      let run = result.at(-1);
      const tolerance = scale / 1e9 + 1e-6;
      if (run && entry.start < run.end - tolerance) throw Error('overlapping clusters');
      if (!run || entry.start > run.end + tolerance) {
        run = { id: entry.id, startTime: entry.start, end: entry.end, parts: headers.slice(), token: null, bytes: null };
        result.push(run);
      }
      if (entry.token && entry.token !== run.token) run.parts.push(...entry.prefix);
      run.parts.push(entry.bytes);
      run.token = entry.token;
      run.end = entry.end;
    }
    return result;
  };
  return {
    // Called only after SourceBuffer's existing retry/deduplication checks.
    append(element) {
      if (!valid) return;
      try {
        const { id, bytes } = element;
        if (id === CLUSTER) {
          if (track == null) throw Error('missing supported track');
          record(element);
          return;
        }
        if (records.length) {
          // Metadata at EOF does not belong in a run; a new initialization
          // needs a separate codec epoch, which this small index declines.
          if ([0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b].includes(id)) throw Error('new initialization');
          return;
        }
        if (id === 0x1549a966) {
          const time = payload(bytes).find(item => item.id === 0x2ad7b1);
          if (time) scale = uint(bytes, time.data, time.size);
          if (!(scale > 0)) throw Error('invalid timestamp scale');
        } else if (id === 0x1654ae6b) {
          const tracks = payload(bytes).filter(item => item.id === 0xae);
          if (tracks.length !== 1 || track != null) throw Error('multiple tracks');
          const fields = children(bytes, tracks[0].data, tracks[0].end);
          const field = id => fields.find(item => item.id === id);
          const number = field(0xd7), type = field(0x83), codec = field(0x86), priv = field(0x63a2), delay = field(0x56aa);
          if (!number || !type || !codec || !priv || !delay || uint(bytes, type.data, type.size) !== 2
            || new TextDecoder().decode(bytes.subarray(codec.data, codec.end)) !== 'A_OPUS'
            || priv.size < 19 || new TextDecoder().decode(bytes.subarray(priv.data, priv.data + 8)) !== 'OpusHead') throw Error('unsupported audio track');
          const skip = bytes[priv.data + 10] | (bytes[priv.data + 11] << 8);
          // Opening a new run reapplies Opus pre-skip. CodecDelay must match
          // that skip, making the first decoded sample's origin its original
          // Block timestamp. Keep all available prefix in this run for preroll.
          if (Math.abs(uint(bytes, delay.data, delay.size) - skip * 1e9 / 48000) > 1) throw Error('inconsistent codec delay');
          track = uint(bytes, number.data, number.size);
          if (!(track > 0)) throw Error('invalid track');
        }
        if (headers.length >= 65_536) throw Error('too many headers');
        headers.push(bytes);
      } catch {
        valid = false;
        headers.length = records.length = 0;
        runs = null;
      }
    },
    at(seconds, fallback) {
      const ordinary = () => ({ id: 0, startTime: 0, endTime: Infinity, bytes: fallback() });
      if (!valid || !records.length) return ordinary();
      try {
        runs ??= buildRuns();
        let selected = runs[0];
        for (const run of runs) if (run.startTime <= seconds + 1e-6) selected = run;
        const index = runs.indexOf(selected);
        // The uninterrupted route remains byte-for-byte unchanged, including
        // its initialization, trailing metadata and existing Opus decode state.
        const bytes = runs.length === 1 && ordered ? fallback() : (selected.bytes ??= join(selected.parts));
        return { id: selected.id, startTime: selected.startTime, endTime: runs[index + 1]?.startTime ?? Infinity, bytes };
      } catch {
        valid = false;
        headers.length = records.length = 0;
        runs = null;
        return ordinary();
      }
    },
  };
}
