/**
 * A minimal PulseAudio native-protocol client for playback, written for the
 * browser's controller (renderers cannot open sockets). It speaks protocol
 * version 8, the subset jspulse (github.com/jjtseng93/jspulse) serves on
 * 127.0.0.1:4713 with anonymous access:
 *
 *   AUTH -> SET_NAME -> CREATE_PLAYBACK -> audio frames as the server sends
 *   REQUEST credits -> DRAIN -> DELETE_PLAYBACK
 *
 * Wire format (PulseAudio's documented pstream/tagstruct): every frame has a
 * 20-byte big-endian header (length, channel, offset hi/lo, flags); channel
 * 0xffffffff carries command packets, which are tagstructs of typed values;
 * other channels carry a stream's audio. Audio is sent as s16le.
 */
import { connect } from "node:net";
import { PlaybackBuffer } from "./playback-buffer.js";

export { floatToS16 } from "./pcm.js";

const PACKET_CHANNEL = 0xffffffff;
const INVALID = 0xffffffff;
const PROTOCOL_VERSION = 8;
const SAMPLE_S16LE = 3;
const COMMAND = {
  ERROR: 0, REPLY: 2, CREATE_PLAYBACK_STREAM: 3, DELETE_PLAYBACK_STREAM: 4, AUTH: 8, SET_CLIENT_NAME: 9,
  DRAIN_PLAYBACK_STREAM: 12, GET_PLAYBACK_LATENCY: 14, REQUEST: 61, UNDERFLOW: 63, PLAYBACK_STREAM_KILLED: 32,
};
const TAG = {
  STRING: 0x74, NULL: 0x4e, U32: 0x4c, U8: 0x42, SAMPLE_SPEC: 0x61, ARBITRARY: 0x78, TRUE: 0x31, FALSE: 0x30,
  CHANNEL_MAP: 0x6d, CVOLUME: 0x76, TIMEVAL: 0x54, USEC: 0x55, S64: 0x72,
};
// PulseAudio channel positions: mono, front-left, front-right, then aux channels.
const POSITION = { MONO: 0, FRONT_LEFT: 1, FRONT_RIGHT: 2, AUX0: 12 };
const VOLUME_NORM = 0x10000;

/** Builds a tagstruct. */
class TagWriter {
  #bytes = [];

  u32(value) {
    this.#bytes.push(TAG.U32, ...u32be(value));
    return this;
  }

  string(value) {
    if (value == null) this.#bytes.push(TAG.NULL);
    else this.#bytes.push(TAG.STRING, ...new TextEncoder().encode(value), 0);
    return this;
  }

  bool(value) {
    this.#bytes.push(value ? TAG.TRUE : TAG.FALSE);
    return this;
  }

  timeval(milliseconds) {
    this.#bytes.push(TAG.TIMEVAL, ...u32be(Math.floor(milliseconds / 1000)), ...u32be((milliseconds % 1000) * 1000));
    return this;
  }

  arbitrary(bytes) {
    this.#bytes.push(TAG.ARBITRARY, ...u32be(bytes.length), ...bytes);
    return this;
  }

  sampleSpec({ format, channels, rate }) {
    this.#bytes.push(TAG.SAMPLE_SPEC, format, channels, ...u32be(rate));
    return this;
  }

  channelMap(channels) {
    const positions = channels === 1 ? [POSITION.MONO]
      : Array.from({ length: channels }, (_, index) =>
        index === 0 ? POSITION.FRONT_LEFT : index === 1 ? POSITION.FRONT_RIGHT : POSITION.AUX0 + index - 2);
    this.#bytes.push(TAG.CHANNEL_MAP, channels, ...positions);
    return this;
  }

  cvolume(channels, volume = VOLUME_NORM) {
    this.#bytes.push(TAG.CVOLUME, channels);
    for (let index = 0; index < channels; index++) this.#bytes.push(...u32be(volume));
    return this;
  }

  finish() {
    return Uint8Array.from(this.#bytes);
  }
}

/** Reads a tagstruct. */
class TagReader {
  #data;
  #index = 0;

  constructor(data) {
    this.#data = data;
  }

  u32() {
    this.#expect(TAG.U32);
    return this.#rawU32();
  }

  bool() {
    const tag = this.#data[this.#index++];
    if (tag !== TAG.TRUE && tag !== TAG.FALSE) throw new Error("pulse: invalid boolean");
    return tag === TAG.TRUE;
  }

  timeval() {
    this.#expect(TAG.TIMEVAL);
    return this.#rawU32() + this.#rawU32() / 1e6;
  }

  integer64(tag, signed = false) {
    this.#expect(tag);
    if (this.#index + 8 > this.#data.length) throw new Error("pulse: truncated timing value");
    const view = new DataView(this.#data.buffer, this.#data.byteOffset + this.#index, 8);
    const value = Number(signed ? view.getBigInt64(0) : view.getBigUint64(0));
    this.#index += 8;
    if (!Number.isSafeInteger(value)) throw new Error("pulse: timing value out of range");
    return value;
  }

  string() {
    if (this.#data[this.#index] === TAG.NULL) {
      this.#index++;
      return null;
    }
    this.#expect(TAG.STRING);
    const end = this.#data.indexOf(0, this.#index);
    if (end < 0) throw new Error("pulse: unterminated string");
    const value = new TextDecoder().decode(this.#data.subarray(this.#index, end));
    this.#index = end + 1;
    return value;
  }

  #expect(tag) {
    if (this.#data[this.#index++] !== tag) throw new Error(`pulse: expected tag ${String.fromCharCode(tag)}`);
  }

  #rawU32() {
    if (this.#index + 4 > this.#data.length) throw new Error("pulse: truncated packet");
    const value = new DataView(this.#data.buffer, this.#data.byteOffset + this.#index, 4).getUint32(0);
    this.#index += 4;
    return value;
  }
}

function u32be(value) {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function frame(channel, payload, offset = 0) {
  const header = new Uint8Array(20);
  const view = new DataView(header.buffer);
  view.setUint32(0, payload.length);
  view.setUint32(4, channel >>> 0);
  view.setUint32(8, Math.floor(offset / 2 ** 32));
  view.setUint32(12, offset >>> 0);
  view.setUint32(16, 0);
  const out = new Uint8Array(20 + payload.length);
  out.set(header);
  out.set(payload, 20);
  return out;
}

/**
 * One connection to a PulseAudio server, for playback streams.
 * `connection` is { host, port } (default 127.0.0.1:4713).
 */
export class PulseClient {
  #socket = null;
  #buffer = new Uint8Array(0);
  #nextTag = 1;
  #nextSyncId = 1;
  #pending = new Map();
  #streams = new Map();
  #closed = false;

  static async connect({ host = "127.0.0.1", port = 4713, name = "buninu-browser" } = {}) {
    const client = new PulseClient();
    await client.#open(host, port);
    await client.#command(COMMAND.AUTH, (w) => w.u32(PROTOCOL_VERSION).arbitrary(new Uint8Array(256)));
    await client.#command(COMMAND.SET_CLIENT_NAME, (w) => w.string(name));
    return client;
  }

  #open(host, port) {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      socket.once("connect", () => {
        socket.off("error", reject);
        socket.on("error", () => this.close());
        resolve();
      });
      socket.once("error", reject);
      socket.on("data", (chunk) => this.#receive(chunk));
      socket.on("close", () => this.close());
      this.#socket = socket;
    });
  }

  /** Sends a command packet; resolves with the reply's reader. */
  #command(command, fill = () => {}, timeout = 0) {
    if (this.#closed) return Promise.reject(new Error("pulse: connection closed"));
    const tag = this.#nextTag++;
    const writer = new TagWriter().u32(command).u32(tag);
    fill(writer);
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => {
        this.#pending.delete(tag);
        reject(new Error("pulse: timing request timed out"));
      }, timeout) : null;
      this.#pending.set(tag, { resolve, reject, command, timer });
      this.#socket.write(frame(PACKET_CHANNEL, writer.finish()));
    });
  }

  #receive(chunk) {
    const joined = new Uint8Array(this.#buffer.length + chunk.length);
    joined.set(this.#buffer);
    joined.set(chunk, this.#buffer.length);
    this.#buffer = joined;
    while (this.#buffer.length >= 20) {
      const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, 20);
      const length = view.getUint32(0);
      const channel = view.getUint32(4);
      if (this.#buffer.length < 20 + length) return;
      const body = this.#buffer.slice(20, 20 + length);
      this.#buffer = this.#buffer.slice(20 + length);
      if (channel === PACKET_CHANNEL) this.#packet(body);
    }
  }

  #packet(body) {
    const reader = new TagReader(body);
    const command = reader.u32();
    const tag = reader.u32();
    if (command === COMMAND.REPLY || command === COMMAND.ERROR) {
      const pending = this.#pending.get(tag);
      this.#pending.delete(tag);
      if (!pending) return;
      clearTimeout(pending.timer);
      if (command === COMMAND.REPLY) pending.resolve(reader);
      else pending.reject(new Error(`pulse: command ${pending.command} server error ${reader.u32()}`));
    } else if (command === COMMAND.REQUEST) {
      const stream = this.#streams.get(reader.u32());
      stream?.grant(reader.u32());
    } else if (command === COMMAND.PLAYBACK_STREAM_KILLED) {
      this.#streams.get(reader.u32())?.kill();
    } else if (command === COMMAND.UNDERFLOW) {
      this.#streams.get(reader.u32())?.updateTiming();
    }
  }

  /**
   * Opens a playback stream of s16le at `rate` Hz with `channels` channels.
   * `onRequest(bytes)` asks for about that much more audio, paced to real time
   * (see PlaybackStream).
   */
  async openPlayback({ rate, channels, name = "audio", onRequest = () => {}, onTiming = null, onTimingError = null, leadSeconds = LEAD_SECONDS }) {
    const spec = { format: SAMPLE_S16LE, channels, rate };
    const frameBytes = channels * 2;
    const bytesForSeconds = (seconds) => Math.max(frameBytes, Math.round(rate * seconds) * frameBytes);
    // Native PulseAudio defaults tlength/prebuf to about two seconds. A piano
    // stream that is deliberately kept only 120 ms ahead would not start until
    // that buffer filled. Request an explicit, short start threshold instead.
    const interactive = leadSeconds <= 0.15;
    const targetLength = bytesForSeconds(interactive ? 0.16 : 0.4);
    const prebuffer = bytesForSeconds(interactive ? 0.04 : 0.08);
    const minimumRequest = bytesForSeconds(0.04);
    const reply = await this.#command(COMMAND.CREATE_PLAYBACK_STREAM, (w) => w
      .string(name).sampleSpec(spec).channelMap(channels)
      .u32(INVALID).string(null) // default sink
      .u32(INVALID).bool(false) // maxlength, not corked
      .u32(targetLength).u32(prebuffer).u32(minimumRequest) // tlength, prebuf, minreq
      .u32(this.#nextSyncId++).cvolume(channels)); // independent sync id, volume
    const index = reply.u32();
    reply.u32(); // sink input index
    const requested = reply.u32();
    const stream = new PlaybackStream(this, index, spec, onRequest, leadSeconds, onTiming, onTimingError);
    this.#streams.set(index, stream);
    stream.grant(requested);
    return stream;
  }

  writeAudio(index, bytes) {
    // pstream flags=0 means PA_SEEK_RELATIVE. Offset 0 appends at the current
    // write index; a cumulative offset would create ever-growing gaps.
    if (!this.#closed) this.#socket.write(frame(index, bytes));
  }

  drain(index) {
    return this.#command(COMMAND.DRAIN_PLAYBACK_STREAM, (w) => w.u32(index));
  }

  /** Protocol v8 timing: the read cursor minus the sink's measured device queue. */
  async playbackTiming(index) {
    const reply = await this.#command(COMMAND.GET_PLAYBACK_LATENCY,
      (w) => w.u32(index).timeval(Date.now()), 2000);
    const sinkSeconds = reply.integer64(TAG.USEC) / 1e6;
    reply.integer64(TAG.USEC); // source latency (recording only)
    const playing = reply.bool();
    reply.timeval(); // echoed request time
    reply.timeval(); // server measurement time; don't assume synchronized wall clocks
    const writeIndex = reply.integer64(TAG.S64, true);
    const readIndex = reply.integer64(TAG.S64, true);
    return { sinkSeconds, playing, writeIndex, readIndex };
  }

  async deleteStream(index) {
    this.#streams.delete(index);
    await this.#command(COMMAND.DELETE_PLAYBACK_STREAM, (w) => w.u32(index)).catch(() => {});
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(new Error("pulse: connection closed"));
    }
    this.#pending.clear();
    for (const stream of this.#streams.values()) stream.kill();
    this.#streams.clear();
    this.#socket?.destroy();
  }
}

/**
 * A playback stream, paced to real time on this side: audio goes out only up
 * to LEAD_SECONDS ahead of the playback clock, whatever the server asks for.
 * Some servers ask for more at once and queue it themselves (jspulse's
 * OpenSL ES backend requests again as soon as it receives), and then a pause
 * would leave everything already sent still playing. The producer prepares a
 * separate bounded PCM reserve here so renderer work cannot immediately starve
 * the output. That reserve is discarded on close, not sent to the device.
 */
const LEAD_SECONDS = 0.5;
const PACE_MS = 50;
const MIN_REQUEST_SECONDS = 0.02;
const MIN_PACKET_SECONDS = 0.04;
const MAX_PACKET_SECONDS = 0.1;

class PlaybackStream {
  #client;
  #onRequest;
  #bytesPerSecond;
  #frameBytes;
  #offset = 0;
  #credit = 0;
  #queue = [];
  #queuedBytes = 0;
  #outstanding = 0;
  #started = null;
  #timer = null;
  #leadSeconds;
  #onTiming;
  #onTimingError;
  #timingPending = false;
  #playedBytes = 0;
  #producerBuffer;
  killed = false;

  constructor(client, index, { rate, channels }, onRequest, leadSeconds, onTiming, onTimingError) {
    this.#client = client;
    this.index = index;
    // Audio is only ever cut at whole frames (one sample of every channel):
    // servers such as jspulse's OpenSL ES backend queue each piece on its
    // own, and half a stereo frame would swap left and right from then on.
    this.#frameBytes = channels * 2;
    this.#bytesPerSecond = rate * this.#frameBytes;
    this.#onRequest = onRequest;
    this.#leadSeconds = leadSeconds;
    this.#producerBuffer = new PlaybackBuffer(this.#bytesPerSecond, this.#frameBytes, leadSeconds);
    this.#onTiming = onTiming;
    this.#onTimingError = onTimingError;
    this.#timer = setInterval(() => { this.#pace(); void this.updateTiming(); }, PACE_MS);
  }

  async updateTiming() {
    if (!this.#onTiming || this.killed || this.#timingPending) return;
    this.#timingPending = true;
    try {
      const timing = await this.#client.playbackTiming(this.index);
      if (this.killed) return;
      // Never count queued PCM or underrun silence as played media. No wall
      // clock extrapolation: an absent/stale report freezes the master clock.
      const end = Math.min(this.#offset, Math.max(0, timing.writeIndex));
      const played = Math.min(end, Math.max(0, Math.min(end, timing.readIndex) - timing.sinkSeconds * this.#bytesPerSecond));
      this.#playedBytes = Math.max(this.#playedBytes, this.#frameAligned(played));
      this.#onTiming({ seconds: this.#playedBytes / this.#bytesPerSecond,
        sentSeconds: this.#offset / this.#bytesPerSecond, sinkSeconds: timing.sinkSeconds, playing: timing.playing,
        bufferedSeconds: this.#queuedBytes / this.#bytesPerSecond });
      this.#pace();
    } catch (error) {
      if (!this.killed) this.#onTimingError?.(error);
    } finally {
      this.#timingPending = false;
    }
  }

  /** The server has room for `bytes` more. */
  grant(bytes) {
    this.#credit += bytes;
    this.#pace();
  }

  /** Queues s16le audio from the producer; it goes out as the clock allows. */
  write(bytes) {
    if (this.killed || !bytes.length) return;
    this.#outstanding = Math.max(0, this.#outstanding - bytes.length);
    this.#queue.push(bytes);
    this.#queuedBytes += bytes.length;
    this.#pace();
  }

  #frameAligned(bytes) {
    return Math.floor(bytes) - (Math.floor(bytes) % this.#frameBytes);
  }

  /** Bytes the playback clock allows to have been sent by now. */
  #allowed() {
    const elapsed = this.#started === null ? 0 : (performance.now() - this.#started) / 1000;
    const bytes = Math.floor(this.#bytesPerSecond * (elapsed + this.#leadSeconds));
    // Device progress is authoritative, with real-time pacing as a second
    // ceiling: a server incorrectly reporting a zero queue cannot flood the
    // device faster than real time. This is a queue limit, not an A/V offset.
    if (this.#onTiming) return this.#frameAligned(Math.min(bytes,
      this.#playedBytes + this.#bytesPerSecond * this.#leadSeconds));
    return bytes - (bytes % this.#frameBytes);
  }

  #pace() {
    if (this.killed) return;
    const allowed = this.#allowed();
    // Pieces are merged into packets of MIN..MAX_PACKET_SECONDS: servers
    // such as jspulse's OpenSL ES backend queue each packet as one buffer
    // (a few at a time), so small packets leave them little to play from.
    const minimum = this.#frameAligned(this.#bytesPerSecond * MIN_PACKET_SECONDS);
    const maximum = this.#frameAligned(this.#bytesPerSecond * MAX_PACKET_SECONDS);
    const inDevice = this.#onTiming ? Math.max(0, this.#offset - this.#playedBytes)
      : this.#started === null ? 0 : Math.max(0, this.#offset - (performance.now() - this.#started) / 1000 * this.#bytesPerSecond);
    const ready = this.#producerBuffer.ready(this.#queuedBytes, inDevice, this.finishing);
    const previousOffset = this.#offset;
    while (ready && this.#credit > 0 && this.#queuedBytes > 0 && this.#offset < allowed) {
      const room = this.#frameAligned(Math.min(this.#credit, allowed - this.#offset, maximum, this.#queuedBytes));
      if (room < this.#frameBytes || (room < minimum && !this.finishing && this.#queuedBytes < minimum)) break;
      const packet = new Uint8Array(room);
      for (let filled = 0; filled < room;) {
        const piece = this.#queue[0];
        const take = Math.min(piece.length, room - filled);
        packet.set(piece.subarray(0, take), filled);
        filled += take;
        if (take === piece.length) this.#queue.shift();
        else this.#queue[0] = piece.subarray(take);
      }
      this.#started ??= performance.now();
      this.#client.writeAudio(this.index, packet);
      this.#offset += room;
      this.#credit -= room;
      this.#queuedBytes -= room;
    }
    // Predecode independently of server credits; only transmission uses the
    // small device budget above. Keep outstanding requests in that budget too.
    const immediateNeed = Math.min(this.#credit, allowed + this.#bytesPerSecond * PACE_MS / 1000 - this.#offset);
    const sentNow = inDevice + this.#offset - previousOffset;
    const need = this.#producerBuffer.request(this.#queuedBytes, this.#outstanding, sentNow, immediateNeed);
    if (need >= this.#bytesPerSecond * MIN_REQUEST_SECONDS && !this.finishing) {
      this.#outstanding += need;
      this.#onRequest(need);
    }
  }

  /**
   * Restarts the pacing clock from what was sent so far. After the writer
   * paused (the output ran dry), sending resumes at the playback rate
   * instead of catching up with the time that passed, which would queue
   * seconds on the server and delay what plays from then on.
   */
  resync() {
    if (this.killed || this.#started === null) return;
    this.#started = performance.now() - this.#offset / this.#bytesPerSecond * 1000;
    this.#pace();
  }

  /** Bytes handed to the server so far: once there, the server may play them even after the stream closes. */
  get sentBytes() {
    return this.#offset;
  }

  /** Bytes queued but not yet sent. */
  get queued() {
    return this.#queuedBytes;
  }

  /** Waits until everything written has played, then removes the stream. */
  async finish() {
    this.finishing = true;
    while (this.#queue.length && !this.killed) await new Promise((resolve) => setTimeout(resolve, PACE_MS));
    if (!this.killed) {
      await this.#client.drain(this.index).catch(() => {});
      if (this.#onTiming) {
        // Some compatible servers acknowledge drain before their device queue
        // empties. Only a measured playback cursor may end synchronized media.
        while (!this.killed && this.#playedBytes < this.#offset) {
          await this.updateTiming();
          await new Promise((resolve) => setTimeout(resolve, PACE_MS));
        }
      }
      if (!this.#onTiming) {
        const end = (this.#started ?? performance.now()) + this.#offset / this.#bytesPerSecond * 1000;
        while (!this.killed && performance.now() < end) await new Promise((resolve) => setTimeout(resolve, PACE_MS));
      }
    }
    await this.close();
  }

  async close() {
    this.kill();
    await this.#client.deleteStream(this.index);
  }

  kill() {
    this.killed = true;
    this.#queue = [];
    this.#queuedBytes = 0;
    clearInterval(this.#timer);
  }
}
