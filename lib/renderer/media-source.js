/**
 * Media Source Extensions, enough for a page to append one container at a
 * time and play it while later segments are still arriving.
 *
 * The event order follows the Media Source spec: appendBuffer returns with
 * updating set, and a later task runs updatestart, the append, then update
 * and updateend. sourceopen fires when an element attaches, not at
 * construction. remove() and abort() do not cut bytes out of the
 * concatenation — splicing an fMP4 or WebM would break the container, and
 * the decoder reopens on the whole snapshot.
 *
 * Codec claims stay inside what this build can demux and decode. Types the
 * engine cannot play are rejected so a page picks another one.
 */
import { createBytePipe } from "../media/byte-pipe.js";

const BRAND = Symbol("MediaSource");
const BUFFER_BRAND = Symbol("SourceBuffer");
/** One page cannot grow the concatenated snapshot without bound. */
const APPEND_QUOTA = 256 * 1024 * 1024;

// Family → the token is fully specified only with a profile/level suffix.
const CODEC_FAMILIES = {
  avc1: true, avc3: true, av01: true, vp09: true, mp4a: true,
  vp8: false, vp9: false, opus: false, vorbis: false, flac: false, mp3: false,
};
const CONTAINERS = {
  "video/mp4": ["avc1", "avc3", "av01", "vp09", "vp9", "mp4a"],
  "audio/mp4": ["mp4a", "flac", "opus"],
  "video/webm": ["vp8", "vp9", "vp09", "av01", "opus", "vorbis"],
  "audio/webm": ["opus", "vorbis"],
  "audio/mpeg": ["mp3", "mp4a"],
  "audio/aac": ["mp4a"],
  "audio/ogg": ["opus", "vorbis", "flac"],
  "video/ogg": ["opus", "vorbis"],
  "audio/wav": [],
  "audio/wave": [],
  "audio/x-wav": [],
  "audio/flac": ["flac"],
};

/** Demuxer name for a MIME type, when the URL itself has no extension. */
export function containerFormat(mime) {
  const base = String(mime ?? "").split(";")[0].trim().toLowerCase();
  if (base === "video/mp4" || base === "audio/mp4" || base === "audio/aac") return "mp4";
  if (base === "video/webm" || base === "audio/webm") return "webm";
  if (base === "video/ogg" || base === "audio/ogg") return "ogg";
  if (base === "audio/mpeg" || base === "audio/mp3") return "mp3";
  if (base === "audio/wav" || base === "audio/wave" || base === "audio/x-wav") return "wav";
  if (base === "audio/flac") return "flac";
  return undefined;
}

function parseMime(type) {
  const raw = String(type ?? "").trim().toLowerCase();
  if (!raw || /[\u0000\r\n]/.test(raw)) return null;
  const parts = raw.split(";").map((part) => part.trim()).filter(Boolean);
  const base = parts[0];
  if (!/^(video|audio)\/[a-z0-9.+-]+$/.test(base)) return null;
  let codecs = null;
  for (const part of parts.slice(1)) {
    const match = part.match(/^codecs\s*=\s*"?([^"]+)"?$/);
    if (match) codecs = match[1].split(",").map((token) => token.trim()).filter(Boolean);
  }
  return { base, codecs };
}

function codecKnown(token, families) {
  const name = token.split(".")[0];
  if (!Object.hasOwn(CODEC_FAMILIES, name)) return false;
  if (families.length && !families.includes(name)) return false;
  return true;
}

function codecFullySpecified(token) {
  const name = token.split(".")[0];
  if (!Object.hasOwn(CODEC_FAMILIES, name)) return false;
  if (CODEC_FAMILIES[name]) return token.includes(".");
  return true;
}

/**
 * @param {string} type
 * @param {{ requireCodecs?: boolean }} [options]
 */
export function mimeSupported(type, { requireCodecs = false } = {}) {
  const parsed = parseMime(type);
  if (!parsed || !Object.hasOwn(CONTAINERS, parsed.base)) return false;
  const families = CONTAINERS[parsed.base];
  if (!parsed.codecs || !parsed.codecs.length) return !requireCodecs;
  const check = requireCodecs ? codecFullySpecified : (token) => codecKnown(token, families);
  if (requireCodecs && parsed.codecs.some((token) => !codecKnown(token, families))) return false;
  return parsed.codecs.every((token) => check(token));
}

function copyBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  throw new TypeError("The provided value is not of type ArrayBuffer or ArrayBufferView.");
}

function timeRanges(start, end) {
  const length = end > start ? 1 : 0;
  return {
    length,
    start(index) {
      if (index !== 0 || !length) throw new DOMException("The index provided is out of range.", "IndexSizeError");
      return start;
    },
    end(index) {
      if (index !== 0 || !length) throw new DOMException("The index provided is out of range.", "IndexSizeError");
      return end;
    },
  };
}

function uint32(bytes, offset) {
  return offset + 4 <= bytes.byteLength
    ? new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0)
    : null;
}

/** Reads an EBML variable-size integer. IDs retain their marker; sizes do not. */
function ebmlVint(bytes, offset, id = false) {
  const first = bytes[offset];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || offset + length > bytes.byteLength) return null;
  let value = id ? first : first & ((1 << (8 - length)) - 1);
  for (let index = 1; index < length; index++) value = value * 256 + bytes[offset + index];
  return { value, length };
}

function ebmlUint(bytes, offset, length) {
  if (length < 1 || length > 6 || offset + length > bytes.byteLength) return null;
  let value = 0;
  for (let index = 0; index < length; index++) value = value * 256 + bytes[offset + index];
  return value;
}

/** Actual buffered end of WebM clusters (nanosecond TimecodeScale, millisecond default). */
function inspectWebMAppend(bytes, state) {
  for (let offset = 0; offset + 4 < bytes.byteLength; offset++) {
    if (bytes[offset] !== 0x2a || bytes[offset + 1] !== 0xd7 || bytes[offset + 2] !== 0xb1) continue;
    const size = ebmlVint(bytes, offset + 3);
    const value = size && ebmlUint(bytes, offset + 3 + size.length, size.value);
    if (value) state.scale = value;
  }
  const scale = state.scale || 1_000_000;
  let latest = null;
  let first = null;
  state.appendHasHeader = bytes.byteLength >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  for (let offset = 0; offset + 4 < bytes.byteLength;) {
    if (!(bytes[offset] === 0x1f && bytes[offset + 1] === 0x43
      && bytes[offset + 2] === 0xb6 && bytes[offset + 3] === 0x75)) {
      offset++;
      continue;
    }
    const size = ebmlVint(bytes, offset + 4);
    if (!size) break;
    let cursor = offset + 4 + size.length;
    const limit = Math.min(bytes.byteLength, cursor + size.value);
    let clusterTime = 0;
    while (cursor < limit) {
      const element = ebmlVint(bytes, cursor, true);
      const length = element && ebmlVint(bytes, cursor + element.length);
      if (!element || !length) break;
      const data = cursor + element.length + length.length;
      const end = Math.min(limit, data + length.value);
      if (element.value === 0xe7) {
        clusterTime = ebmlUint(bytes, data, length.value) ?? clusterTime;
        first ??= clusterTime;
        latest = Math.max(latest ?? 0, clusterTime);
      } else if (element.value === 0xa3 || element.value === 0xa1) {
        const track = ebmlVint(bytes, data);
        const timeAt = track ? data + track.length : end;
        if (timeAt + 2 <= end) {
          let relative = (bytes[timeAt] << 8) | bytes[timeAt + 1];
          if (relative & 0x8000) relative -= 0x10000;
          // Opus packets are normally 20 ms; this small tail keeps buffered
          // from ending at the start timestamp of its final packet.
          latest = Math.max(latest ?? 0, clusterTime + relative + 20);
        }
      }
      cursor = end;
    }
    offset = Math.max(offset + 4, limit);
  }
  state.appendStart = first == null ? null : first * scale / 1e9;
  return latest == null ? null : latest * scale / 1e9;
}

// Segment times from different appends may differ by rounding.
const COVER_TOLERANCE = 0.002;

/** Whether the merged ranges in `covered` hold all of [start, end]. */
function covers(covered, start, end) {
  return covered.some(([from, to]) => from <= start + COVER_TOLERANCE && end <= to + COVER_TOLERANCE);
}

/** Adds [start, end] to the sorted, merged ranges in `covered`. */
function addCovered(covered, start, end) {
  covered.push([start, end]);
  covered.sort((left, right) => left[0] - right[0]);
  for (let index = covered.length - 1; index > 0; index--) {
    const [from, to] = covered[index];
    const previous = covered[index - 1];
    if (from <= previous[1] + COVER_TOLERANCE) {
      previous[1] = Math.max(previous[1], to);
      covered.splice(index, 1);
    }
  }
}

/** Visits ISO BMFF boxes, including the containers needed by fragmented MP4. */
function mp4Boxes(bytes, start, end, visit) {
  for (let offset = start; offset + 8 <= end;) {
    let size = uint32(bytes, offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return;
      const high = uint32(bytes, offset + 8);
      const low = uint32(bytes, offset + 12);
      if (high == null || low == null || high > 0x1fffff) return;
      size = high * 0x100000000 + low;
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (!Number.isFinite(size) || size < header || offset + size > end) return;
    const data = offset + header;
    const boxEnd = offset + size;
    visit(type, data, boxEnd);
    if (["moov", "trak", "mdia", "mvex", "moof", "traf"].includes(type)) {
      mp4Boxes(bytes, data, boxEnd, visit);
    }
    offset = boxEnd;
  }
}

/** Updates one SourceBuffer's media time from an init or fMP4 media segment. */
function inspectMp4Append(bytes, state) {
  let decodeTime = null;
  let firstDecodeTime = null;
  state.appendHasHeader = false;
  let fragmentDuration = 0;
  let fragmentSamples = 0;
  let fragmentDefault = state.defaultDuration ?? 0;
  mp4Boxes(bytes, 0, bytes.byteLength, (type, data, end) => {
    if (type === "mdat" || type === "moof") state.hasMediaSegment = true;
    if (type === "moov") {
      state.hasMovie = true;
      state.appendHasHeader = true;
    }
    if (type === "mvex") state.fragmented = true;
    if (type === "mdhd" && data + 16 <= end) {
      const version = bytes[data];
      const timescale = uint32(bytes, data + (version === 1 ? 20 : 12));
      if (timescale > 0) state.timescale = timescale;
    } else if (type === "trex" && data + 16 <= end) {
      const duration = uint32(bytes, data + 12);
      if (duration > 0) state.defaultDuration = duration;
    } else if (type === "tfhd" && data + 8 <= end) {
      const flags = (bytes[data + 1] << 16) | (bytes[data + 2] << 8) | bytes[data + 3];
      let cursor = data + 8;
      if (flags & 0x000001) cursor += 8;
      if (flags & 0x000002) cursor += 4;
      if ((flags & 0x000008) && cursor + 4 <= end) fragmentDefault = uint32(bytes, cursor) ?? fragmentDefault;
    } else if (type === "tfdt" && data + 8 <= end) {
      if (bytes[data] === 1 && data + 12 <= end) {
        const high = uint32(bytes, data + 4);
        const low = uint32(bytes, data + 8);
        if (high != null && low != null && high <= 0x1fffff) decodeTime = high * 0x100000000 + low;
      } else {
        decodeTime = uint32(bytes, data + 4);
      }
      firstDecodeTime ??= decodeTime;
    } else if (type === "trun" && data + 8 <= end) {
      const flags = (bytes[data + 1] << 16) | (bytes[data + 2] << 8) | bytes[data + 3];
      const count = uint32(bytes, data + 4) ?? 0;
      let cursor = data + 8;
      if (flags & 0x000001) cursor += 4;
      if (flags & 0x000004) cursor += 4;
      let duration = 0;
      for (let index = 0; index < count && cursor <= end; index++) {
        if (flags & 0x000100) {
          const value = uint32(bytes, cursor);
          if (value == null) break;
          duration += value;
          cursor += 4;
        }
        if (flags & 0x000200) cursor += 4;
        if (flags & 0x000400) cursor += 4;
        if (flags & 0x000800) cursor += 4;
      }
      fragmentDuration += duration;
      fragmentSamples += count;
    }
  });
  if (!fragmentDuration && fragmentSamples && fragmentDefault) fragmentDuration = fragmentSamples * fragmentDefault;
  state.appendStart = state.timescale > 0 && firstDecodeTime != null ? firstDecodeTime / state.timescale : null;
  if (state.timescale > 0 && decodeTime != null && fragmentDuration > 0) {
    return (decodeTime + fragmentDuration) / state.timescale;
  }
  return null;
}

/**
 * Per-document MediaSource / SourceBuffer / blob URL registry.
 * `schedule` runs a function as a page task (so a listener added immediately
 * after appendBuffer still observes updateend). `onAppend` and `onDuration`
 * let the renderer probe and update the attached element.
 */
export function createMediaSourceScope({ origin, schedule, DOMException, onAppend, onDuration, appendQuota = APPEND_QUOTA }) {
  const urls = new Map();
  let appended = 0;

  /** Runs the listeners now. One throwing listener does not skip the rest. */
  function emitNow(target, type) {
    const event = { type, target };
    const handler = target._handlers?.get(type);
    if (typeof handler === "function") {
      try {
        handler.call(target, event);
      } catch {}
    }
    const list = target._listeners?.get(type);
    if (!list) return;
    for (const entry of [...list]) {
      try {
        entry.fn.call(target, event);
      } catch {}
      if (entry.once) {
        const index = list.indexOf(entry);
        if (index >= 0) list.splice(index, 1);
      }
    }
  }

  /** A later page task, so a listener registered just after the call still runs. */
  function queueEvent(target, type) {
    schedule(() => emitNow(target, type));
  }

  function listenerApi(target) {
    target._listeners = new Map();
    target._handlers = new Map();
    target.addEventListener = (type, fn, options) => {
      if (typeof fn !== "function") return;
      const name = String(type);
      const list = target._listeners.get(name) ?? [];
      list.push({ fn, once: options === true || Boolean(options?.once) });
      target._listeners.set(name, list);
    };
    target.removeEventListener = (type, fn) => {
      const list = target._listeners.get(String(type));
      if (!list) return;
      const index = list.findIndex((entry) => entry.fn === fn);
      if (index >= 0) list.splice(index, 1);
    };
    target.dispatchEvent = (event) => {
      queueEvent(target, event?.type);
      return true;
    };
  }

  function defineHandler(target, type) {
    Object.defineProperty(target, `on${type}`, {
      configurable: true,
      enumerable: true,
      get() {
        return target._handlers.get(type) ?? null;
      },
      set(value) {
        if (typeof value === "function") target._handlers.set(type, value);
        else target._handlers.delete(type);
      },
    });
  }

  class SourceBufferList {
    constructor() {
      this._items = [];
      listenerApi(this);
      defineHandler(this, "addsourcebuffer");
      defineHandler(this, "removesourcebuffer");
    }

    get length() {
      return this._items.length;
    }

    item(index) {
      return this._items[index] ?? null;
    }

    _add(buffer) {
      this._items.push(buffer);
      this[this._items.length - 1] = buffer;
      queueEvent(this, "addsourcebuffer");
    }

    _remove(buffer) {
      const index = this._items.indexOf(buffer);
      if (index < 0) return;
      this._items.splice(index, 1);
      for (const key of Object.keys(this)) {
        if (/^\d+$/.test(key)) delete this[key];
      }
      this._items.forEach((item, itemIndex) => {
        this[itemIndex] = item;
      });
      queueEvent(this, "removesourcebuffer");
    }
  }

  class SourceBuffer {
    constructor(source, mime) {
      if (!new.target) throw new TypeError("Failed to construct 'SourceBuffer': constructor requires 'new'");
      Object.defineProperty(this, BUFFER_BRAND, { value: true });
      this._source = source;
      this._mime = String(mime);
      this._pipe = createBytePipe();
      this._updating = false;
      this._operation = 0;
      this._removed = false;
      this._end = 0;
      // Media time ranges appended so far, merged, to recognise a segment sent again.
      this._covered = [];
      this._quotaStart = 0;
      this._accountedBytes = 0;
      this._mp4 = {};
      this._webm = {};
      this._hasSegmentTimeline = false;
      this._hasMediaSegment = false;
      this._appendWindowStart = 0;
      this._appendWindowEnd = Infinity;
      this._timestampOffset = 0;
      this.mode = /^audio\/(mpeg|aac)\b/.test(this._mime) ? "sequence" : "segments";
      listenerApi(this);
      for (const type of ["updatestart", "update", "updateend", "error", "abort"]) defineHandler(this, type);
    }

    get updating() {
      return this._updating;
    }

    get buffered() {
      return timeRanges(this._quotaStart, this._end);
    }

    get timestampOffset() {
      return this._timestampOffset;
    }

    set timestampOffset(value) {
      if (this._updating) throw new DOMException("SourceBuffer is updating.", "InvalidStateError");
      const next = Number(value);
      if (!Number.isFinite(next)) throw new TypeError("The provided double value is non-finite.");
      this._timestampOffset = next;
    }

    get appendWindowStart() {
      return this._appendWindowStart;
    }

    set appendWindowStart(value) {
      const next = Number(value);
      if (!Number.isFinite(next) || next < 0 || next >= this._appendWindowEnd) {
        throw new TypeError("The append window start is out of range.");
      }
      this._appendWindowStart = next;
    }

    get appendWindowEnd() {
      return this._appendWindowEnd;
    }

    set appendWindowEnd(value) {
      const next = Number(value);
      if (!Number.isNaN(next) && next <= this._appendWindowStart) throw new TypeError("The append window end is out of range.");
      this._appendWindowEnd = next;
    }

    get mode() {
      return this._mode;
    }

    set mode(value) {
      if (this._updating) throw new DOMException("SourceBuffer is updating.", "InvalidStateError");
      if (value !== "segments" && value !== "sequence") {
        throw new TypeError("The provided value is not a valid enum value.");
      }
      this._mode = value;
    }

    appendBuffer(data) {
      if (this._removed || this._source.readyState !== "open") {
        throw new DOMException("This SourceBuffer is not attached to an open MediaSource.", "InvalidStateError");
      }
      if (this._updating) throw new DOMException("SourceBuffer is updating.", "InvalidStateError");
      const bytes = copyBytes(data);
      const inspected = /^video\/mp4|^audio\/mp4/i.test(this._mime) ? this._mp4
        : /^video\/webm|^audio\/webm/i.test(this._mime) ? this._webm : null;
      const segmentEnd = inspected === this._mp4 ? inspectMp4Append(bytes, this._mp4)
        : inspected === this._webm ? inspectWebMAppend(bytes, this._webm) : null;
      // Media the buffer already holds, sent again (players retry a segment
      // on a slow network): the concatenation would play it twice, so it is
      // left out. Its events fire as for any append.
      const start = inspected && !inspected.appendHasHeader ? inspected.appendStart : null;
      const duplicate = start != null && segmentEnd != null && covers(this._covered, start, segmentEnd);
      const hasWebMCluster = /^video\/webm|^audio\/webm/i.test(this._mime)
        && bytes.indexOf(0x1f) >= 0 && bytes.some((value, index) => value === 0x1f
          && bytes[index + 1] === 0x43 && bytes[index + 2] === 0xb6 && bytes[index + 3] === 0x75);
      if (appended + bytes.byteLength > appendQuota) {
        throw new DOMException("The SourceBuffer is full.", "QuotaExceededError");
      }
      this._updating = true;
      const operation = ++this._operation;
      // One later task: updatestart, the append, then update and updateend.
      // A listener added immediately after appendBuffer() returns is already
      // registered when this task runs.
      schedule(() => {
        if (this._removed || operation !== this._operation) return;
        emitNow(this, "updatestart");
        if (!duplicate) {
          this._pipe.append(bytes);
          appended += bytes.byteLength;
          this._accountedBytes += bytes.byteLength;
          if (start != null && segmentEnd != null) addCovered(this._covered, start, segmentEnd);
        }
        if (this._mp4.hasMediaSegment || hasWebMCluster) this._hasMediaSegment = true;
        if (segmentEnd != null) {
          if (!this._hasSegmentTimeline) this._end = segmentEnd;
          else this._end = Math.max(this._end, segmentEnd);
          this._hasSegmentTimeline = true;
        }
        else if (this._end <= 0 && bytes.byteLength) this._end = 0.001;
        this._updating = false;
        if (!this._source._active._items.includes(this)) this._source._active._add(this);
        emitNow(this, "update");
        emitNow(this, "updateend");
        try {
          onAppend?.(this._source, this);
        } catch {}
      });
    }

    abort() {
      if (this._source.readyState !== "open") {
        throw new DOMException("MediaSource is not open.", "InvalidStateError");
      }
      if (!this._updating) return;
      this._operation += 1;
      this._updating = false;
      queueEvent(this, "abort");
      queueEvent(this, "updateend");
    }

    remove(start, end) {
      if (this._removed || this._source.readyState !== "open") {
        throw new DOMException("This SourceBuffer is not attached to an open MediaSource.", "InvalidStateError");
      }
      if (this._updating) throw new DOMException("SourceBuffer is updating.", "InvalidStateError");
      const from = Number(start);
      const to = Number(end);
      if (!Number.isFinite(from) || from < 0 || from >= to) throw new TypeError("The removal range is invalid.");
      this._updating = true;
      const operation = ++this._operation;
      schedule(() => {
        if (this._removed || operation !== this._operation) return;
        emitNow(this, "updatestart");
        // The decoder still needs the concatenated snapshot, but bytes before
        // the reported buffered range no longer count toward MSE's quota.
        // Prefix eviction is the form adaptive players use while advancing.
        if (from <= this._quotaStart && to > this._quotaStart && this._end > this._quotaStart) {
          const nextStart = Math.min(to, this._end);
          const fraction = (nextStart - this._quotaStart) / (this._end - this._quotaStart);
          const released = Math.min(this._accountedBytes, Math.floor(this._accountedBytes * fraction));
          this._accountedBytes -= released;
          appended = Math.max(0, appended - released);
          this._quotaStart = nextStart;
        }
        // Reported range only. The bytes stay so a later reopen can still seek.
        if (from <= 0 && to >= this._end) this._end = 0;
        this._updating = false;
        emitNow(this, "update");
        emitNow(this, "updateend");
      });
    }

    changeType(type) {
      if (this._updating) throw new DOMException("SourceBuffer is updating.", "InvalidStateError");
      if (!mimeSupported(type)) throw new DOMException("The type is not supported.", "NotSupportedError");
      this._mime = String(type);
    }

    noteEnd(seconds) {
      if (Number.isFinite(seconds) && seconds > this._end) this._end = seconds;
    }
  }

  class MediaSource {
    constructor() {
      if (!new.target) throw new TypeError("Failed to construct 'MediaSource': constructor requires 'new'");
      Object.defineProperty(this, BRAND, { value: true });
      this.readyState = "closed";
      this._duration = NaN;
      this._objectURL = null;
      this._video = null;
      this._audio = null;
      this._buffers = [];
      this.sourceBuffers = new SourceBufferList();
      this.activeSourceBuffers = new SourceBufferList();
      this._active = this.activeSourceBuffers;
      this._live = null;
      listenerApi(this);
      for (const type of ["sourceopen", "sourceended", "sourceclose"]) defineHandler(this, type);
    }

    static isTypeSupported(type) {
      return mimeSupported(type, { requireCodecs: true });
    }

    get duration() {
      return this._duration;
    }

    set duration(value) {
      if (this.readyState !== "open") throw new DOMException("MediaSource is not open.", "InvalidStateError");
      const next = Number(value);
      if (!Number.isFinite(next) || next < 0) throw new TypeError("The provided double value is non-finite.");
      this._duration = next;
      try {
        onDuration?.(this, next);
      } catch {}
    }

    get handle() {
      return null;
    }

    addSourceBuffer(type) {
      if (this.readyState !== "open") throw new DOMException("MediaSource is not open.", "InvalidStateError");
      if (!mimeSupported(type)) throw new DOMException("The type is not supported.", "NotSupportedError");
      const buffer = new SourceBuffer(this, type);
      // audio/* feeds the audio decoder. video/* feeds video, and a lone
      // muxed buffer is also the audio source (see streamPipes).
      if (String(type).trim().toLowerCase().startsWith("audio/")) this._audio = buffer;
      else this._video = buffer;
      this._buffers.push(buffer);
      this._pipesResolve?.();
      this._pipesResolve = null;
      this.sourceBuffers._add(buffer);
      return buffer;
    }

    removeSourceBuffer(buffer) {
      if (!buffer || buffer[BUFFER_BRAND] !== true || buffer._source !== this || buffer._removed) {
        throw new DOMException("The SourceBuffer is not in this MediaSource.", "NotFoundError");
      }
      buffer._removed = true;
      buffer._operation += 1;
      buffer._updating = false;
      appended = Math.max(0, appended - buffer._accountedBytes);
      buffer._accountedBytes = 0;
      if (this._video === buffer) this._video = null;
      if (this._audio === buffer) this._audio = null;
      this._buffers = this._buffers.filter((item) => item !== buffer);
      this.sourceBuffers._remove(buffer);
      this.activeSourceBuffers._remove(buffer);
    }

    endOfStream(error) {
      if (this.readyState !== "open") throw new DOMException("MediaSource is not open.", "InvalidStateError");
      if (this._buffers.some((buffer) => buffer._updating)) {
        throw new DOMException("A SourceBuffer is still updating.", "InvalidStateError");
      }
      if (error !== undefined && error !== "network" && error !== "decode") {
        throw new TypeError("The provided value is not a valid enum value.");
      }
      for (const buffer of this._buffers) {
        if (error) buffer._pipe.fail(new Error(error));
        else buffer._pipe.finish();
      }
      if (!Number.isFinite(this._duration)) {
        const end = Math.max(0, ...this._buffers.map((buffer) => buffer._end));
        if (end > 0) this._duration = end;
      }
      this.readyState = "ended";
      this._pipesResolve?.();
      this._pipesResolve = null;
      queueEvent(this, "sourceended");
      if (Number.isFinite(this._duration)) {
        try {
          onDuration?.(this, this._duration);
        } catch {}
      }
    }

    setLiveSeekableRange(start, end) {
      if (this.readyState !== "open") throw new DOMException("MediaSource is not open.", "InvalidStateError");
      const from = Number(start);
      const to = Number(end);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from >= to) {
        throw new TypeError("The live seekable range is invalid.");
      }
      this._live = { start: from, end: to };
    }

    clearLiveSeekableRange() {
      if (this.readyState !== "open") throw new DOMException("MediaSource is not open.", "InvalidStateError");
      this._live = null;
    }

    /** Closed → open. sourceopen is a task, so it runs after the src setter returns. */
    attach(url) {
      if (this.readyState !== "closed") throw new DOMException("MediaSource is already attached.", "InvalidStateError");
      this._objectURL = url ?? this._objectURL;
      this.readyState = "open";
      queueEvent(this, "sourceopen");
    }

    detach() {
      if (this.readyState === "closed") return;
      for (const buffer of this._buffers) buffer._pipe.fail(new Error("closed"));
      this.readyState = "closed";
      this._pipesResolve?.();
      this._pipesResolve = null;
      queueEvent(this, "sourceclose");
    }

    /** Resolves once addSourceBuffer has created a pipe, or the source is no longer open. */
    waitForPipes() {
      if (this._video || this._audio || this.readyState !== "open") return Promise.resolve();
      if (!this._pipesReady) {
        this._pipesReady = new Promise((resolve) => {
          this._pipesResolve = resolve;
        });
      }
      return this._pipesReady;
    }

    /** Pipes the decoders read. A single muxed buffer serves both. */
    streamPipes() {
      const video = this._video?._pipe ?? this._audio?._pipe ?? null;
      const audio = this._audio?._pipe ?? this._video?._pipe ?? null;
      return {
        video,
        audio,
        videoMime: this._video?._mime ?? this._audio?._mime ?? "",
        audioMime: this._audio?._mime ?? this._video?._mime ?? "",
        audioReady: Boolean((this._audio ?? this._video)?._hasMediaSegment),
      };
    }

    noteBuffered(seconds) {
      for (const buffer of this._buffers) {
        // An ordinary MP4 may have its mdat header split across append calls;
        // inspect the accumulated snapshot once probing succeeds.
        if (!buffer._hasMediaSegment) {
          const bytes = buffer._pipe.bytes();
          if (/^video\/mp4|^audio\/mp4/i.test(buffer._mime)) inspectMp4Append(bytes, buffer._mp4);
          else if (/^video\/webm|^audio\/webm/i.test(buffer._mime)) {
            if (inspectWebMAppend(bytes, buffer._webm) != null) buffer._hasMediaSegment = true;
          }
          if (buffer._mp4.hasMediaSegment) buffer._hasMediaSegment = true;
        }
        // A probe can read the presentation duration from an init segment,
        // but init bytes buffer no media. Only a non-fragmented buffer which
        // has actual media payload may use that duration as its range.
        const completeMp4 = /^video\/mp4|^audio\/mp4/i.test(buffer._mime)
          && buffer._mp4.hasMovie && !buffer._mp4.fragmented;
        if (!buffer._hasSegmentTimeline && (buffer._hasMediaSegment || completeMp4)) buffer.noteEnd(seconds);
      }
    }

    bufferedEnd() {
      const active = this._buffers.map((buffer) => buffer._end).filter((end) => end > 0);
      return active.length ? Math.min(...active) : 0;
    }
  }

  function isMediaSource(value) {
    return Boolean(value && value[BRAND] === true);
  }

  return {
    MediaSource,
    SourceBuffer,
    isMediaSource,
    create(object) {
      const id = crypto.randomUUID();
      const url = `blob:${origin}/${id}`;
      if (isMediaSource(object)) {
        object._objectURL = url;
        urls.set(url, { kind: "media-source", source: object });
        return url;
      }
      if (typeof Blob === "function" && object instanceof Blob) {
        urls.set(url, { kind: "blob", blob: object });
        return url;
      }
      throw new TypeError("URL.createObjectURL: argument is not a Blob or MediaSource.");
    },
    revoke(url) {
      urls.delete(String(url));
    },
    lookup(url) {
      return urls.get(String(url)) ?? null;
    },
    mediaSourceAt(url) {
      const entry = urls.get(String(url));
      return entry?.kind === "media-source" ? entry.source : null;
    },
  };
}
