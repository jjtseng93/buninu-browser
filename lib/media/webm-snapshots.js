import { ebmlHeader } from './webm-stream.js';

const CLUSTER = 0x1f43b675;
const MAX_RECORDS = 250_000;
const OPUS_RATE = 48_000;
const join = parts => parts.length === 1 ? parts[0] : new Uint8Array(Bun.concatArrayBuffers(parts));

// Decode-time snapshots for a single Opus track. A PCM-only decoder cannot
// represent holes in a WebM timeline: concatenating 0..2s and 6..8s produces
// four seconds of samples, not eight. Keep each contiguous run independently
// decodable, without changing any packet or inventing samples for the hole.
export function createWebMAudioSnapshots() {
  const headers = [], records = [];
  let scale = 1_000_000, track = null, valid = true, runs = null, serial = 0, ordered = true;
  let preroll = 1, cached = null, initHeaders = null;
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
      result.push({ id: head.id, start: at, data, size: head.size, end: data + head.size });
      at = data + head.size;
    }
    return result;
  };
  const payload = bytes => {
    const head = ebmlHeader(bytes);
    if (!head || head.size !== bytes.length - head.length) throw Error('incomplete element');
    return children(bytes, head.length, bytes.length);
  };
  const opusSamples = (bytes, at, end) => {
    if (at >= end) throw Error('empty packet');
    const toc = bytes[at], config = toc >> 3;
    const frame = config >= 16 ? 2.5 * 2 ** (config & 3)
      : config >= 12 ? 10 * 2 ** (config & 1) : [10, 20, 40, 60][config & 3];
    const code = toc & 3;
    if (code === 3 && at + 1 >= end) throw Error('incomplete packet');
    const count = code === 0 ? 1 : code === 3 ? bytes[at + 1] & 63 : 2;
    const samples = frame * count * 48;
    if (!count || samples > 5760) throw Error('invalid Opus duration');
    return samples;
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
    const samples = opusSamples(bytes, at + 3, block.end);
    return { start, end: start + samples / OPUS_RATE, samples };
  };
  const record = (element) => {
    const { bytes, cluster } = element;
    const items = cluster ? children(bytes, 0, bytes.length) : payload(bytes);
    if (!cluster) {
      // A finite Cluster can contain many seconds of Opus. Index its complete
      // packets just like a live Cluster, so reopening keeps the requested
      // preroll instead of decoding everything from the Cluster's beginning.
      // Only the size field changes; timestamps and encoded Blocks stay intact.
      const head = ebmlHeader(bytes), header = bytes.slice(0, head.length);
      const width = head.length - 4; // Cluster ID is always four bytes.
      header[4] = (1 << (9 - width)) - 1;
      header.fill(0xff, 5);
      const prefix = [header], blocks = [];
      let time = null;
      for (const item of items) {
        if (item.id === 0xa3 || item.id === 0xa0) {
          blocks.push(bytes.subarray(item.start, item.end));
        } else if (!blocks.length && (item.id === 0xec || (item.id === 0xe7 && time == null))) {
          if (item.id === 0xe7) time = uint(bytes, item.data, item.size);
          prefix.push(bytes.subarray(item.start, item.end));
        } else {
          // CRC/Position/PrevSize describe the original complete Cluster;
          // encrypted or unknown metadata cannot safely survive this cut.
          throw Error('unsupported finite cluster metadata');
        }
      }
      if (time == null) throw Error('missing cluster time');
      // This prefix cannot grow, unlike a live Cluster's mutable metadata.
      // Share it across packet records instead of copying metadata N times.
      Object.freeze(prefix);
      const token = {};
      for (const block of blocks) record({ bytes: block, cluster: { token, time, prefix, sharedPrefix: true } });
      return;
    }
    let origin = cluster?.time;
    if (origin == null) {
      const time = items.find(item => item.id === 0xe7);
      if (!time) throw Error('missing cluster time');
      origin = uint(bytes, time.data, time.size);
    }
    let start = null, end = null, samples = 0, padded = false;
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
      samples += range.samples;
      padded ||= padding > 0;
    }
    if (start == null) return;
    if (records.length >= MAX_RECORDS) throw Error('too many blocks');
    if ((cluster?.prefix.length ?? 0) > 65_536) throw Error('too much cluster metadata');
    initHeaders ??= headers.slice();
    const inOrder = !records.length || start >= records.at(-1).start;
    if (!inOrder) ordered = false;
    const entry = { id: ++serial, start, end, samples, padded, bytes, token: cluster?.token,
      prefix: cluster && (cluster.sharedPrefix ? cluster.prefix : cluster.prefix.slice()) };
    records.push(entry);
    // Ordered appends update only the final run, even for live Clusters which
    // emit one record per packet. An out-of-order append rebuilds once on use.
    if (runs && inOrder && start >= runs.at(-1).end - scale / 1e9 - 1e-6) addEntry(runs, entry);
    else runs = null;
    cached = null;
  };
  const addEntry = (result, entry) => {
    let run = result.at(-1);
    const tolerance = scale / 1e9 + 1e-6;
    if (run && entry.start < run.end - tolerance) throw Error('overlapping clusters');
    if (!run || entry.start > run.end + tolerance) {
      run = { id: entry.id, startTime: entry.start, end: entry.end,
        startSample: Math.round(entry.start * OPUS_RATE), headers: initHeaders, entries: [], samples: 0, exact: true };
      result.push(run);
    }
    // Packet sample counts are exact; millisecond Block timestamps are not.
    // Reopening reapplies Opus pre-skip, cancelling the initial decoder's
    // pre-skip, so the new origin advances by encoded samples, not rounded PTS.
    const timestamp = run.startTime + run.samples / OPUS_RATE;
    // Round the initial cursor once, as openAudioDecoder does, then add integer
    // samples. Rounding (fractional origin + elapsed time) can move a sample.
    entry.origin = (run.startSample + run.samples) / OPUS_RATE;
    entry.seekable = run.exact && Math.abs(entry.start - timestamp) <= tolerance;
    run.samples += entry.samples;
    run.exact &&= entry.seekable && !entry.padded && Number.isSafeInteger(run.samples);
    run.entries.push(entry);
    run.end = entry.end;
  };
  const buildRuns = () => {
    const sorted = ordered ? records : records.slice().sort((a, b) => a.start - b.start);
    const result = [];
    for (const entry of sorted) addEntry(result, entry);
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
          if (field(0x6d80)) throw Error('encoded or encrypted track');
          const number = field(0xd7), type = field(0x83), codec = field(0x86), priv = field(0x63a2), delay = field(0x56aa);
          if (!number || !type || !codec || !priv || !delay || uint(bytes, type.data, type.size) !== 2
            || new TextDecoder().decode(bytes.subarray(codec.data, codec.end)) !== 'A_OPUS'
            || priv.size < 19 || new TextDecoder().decode(bytes.subarray(priv.data, priv.data + 8)) !== 'OpusHead') throw Error('unsupported audio track');
          const skip = bytes[priv.data + 10] | (bytes[priv.data + 11] << 8);
          // Opening a new run reapplies Opus pre-skip. CodecDelay must match
          // that skip, making the first decoded sample's origin its original
          // Block timestamp; later cuts advance by exact packet sample counts.
          if (Math.abs(uint(bytes, delay.data, delay.size) - skip * 1e9 / 48000) > 1) throw Error('inconsistent codec delay');
          const seek = field(0x56bb);
          // Matroska's Opus SeekPreRoll recommends 80ms. Keep at least one
          // second to restore decoder state before returning audible PCM.
          if (seek) preroll = Math.max(preroll, uint(bytes, seek.data, seek.size) / 1e9);
          track = uint(bytes, number.data, number.size);
          if (!(track > 0)) throw Error('invalid track');
        }
        if (headers.length >= 65_536) throw Error('too many headers');
        headers.push(bytes);
      } catch {
        valid = false;
        headers.length = records.length = 0;
        runs = cached = initHeaders = null;
      }
    },
    at(seconds, fallback) {
      const ordinary = () => ({ id: 0, startTime: 0, endTime: Infinity, bytes: fallback() });
      if (!valid || !records.length) return ordinary();
      try {
        runs ??= buildRuns();
        let low = 0, high = runs.length;
        while (low + 1 < high) {
          const mid = (low + high) >>> 1;
          if (runs[mid].startTime <= seconds + 1e-6) low = mid;
          else high = mid;
        }
        const selected = runs[low], endTime = runs[low + 1]?.startTime ?? Infinity;
        const entries = selected.entries, count = entries.length;
        let first = 0;
        high = count;
        const latest = seconds - preroll;
        while (first + 1 < high) {
          const mid = (first + high) >>> 1;
          if (entries[mid].origin <= latest) first = mid;
          else high = mid;
        }
        if (!entries[first].seekable) first = 0;
        if (!first && runs.length === 1 && ordered) {
          // Keep the initial full-file path, pre-skip and trailing metadata.
          return { id: selected.id, startTime: selected.startTime, endTime, bytes: fallback() };
        }
        if (cached?.run === selected && cached.first === first && cached.count === count && cached.endTime === endTime) return cached.snapshot;
        let bytes;
        const snapshot = { id: selected.id, startTime: first ? entries[first].origin : selected.startTime, endTime,
          get bytes() {
            if (!bytes) {
              const parts = selected.headers.slice();
              let token = null;
              for (let i = first; i < count; i++) {
                const entry = entries[i];
                if (entry.token && entry.token !== token) for (const part of entry.prefix) parts.push(part);
                parts.push(entry.bytes);
                token = entry.token;
              }
              bytes = join(parts);
            }
            return bytes;
          } };
        // Metadata notifications only read id/endTime; do not copy the audio
        // there. The getter's fixed record count keeps its snapshot immutable
        // if more packets append before decoding. Cache only the latest view.
        cached = { run: selected, first, count, endTime, snapshot };
        return snapshot;
      } catch {
        valid = false;
        headers.length = records.length = 0;
        runs = cached = initHeaders = null;
        return ordinary();
      }
    },
  };
}
