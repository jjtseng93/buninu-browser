import { seekVideoKeyframe } from "../media/video-keyframe.js";
import { captureViewport } from "../paint/frame.js";

// Runs in the compositor Worker, never in the page's JavaScript turn. Both
// queue duration and decoded pixel memory are bounded. No audio extrapolation.
export class VideoPresentation {
  constructor(engine, changed, report) {
    this.engine = engine;
    this.changed = changed;
    this.report = report;
    this.epoch = 0;
    this.timer = null;
    this.clocks = new Map();
  }
  async open(config) {
    this.stop();
    const epoch = this.epoch;
    this.config = config;
    config.started = performance.now();
    try {
      const decoder = await this.engine.decode(config.bytes, config.options);
      // WASM opens synchronously: audio timing messages may still be queued
      // behind it. Yield a task before choosing the resumed frame position.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (epoch !== this.epoch) { decoder.close(); return; }
      this.decoder = decoder;
      const startTime = config.startTime ?? 0;
      const endTime = config.endTime ?? Infinity;
      // Opening a growing snapshot can take time while audio keeps playing.
      // Seek against its latest measured clock, not the stale open request.
      // Keep the original clock anchor: changing config.time would count the
      // opening delay twice for a video whose clock advances without audio.
      this.resumeTime = Math.min(endTime, Math.max(config.time, this.time()));
      this.nextTime = this.resumeTime >= endTime ? endTime
        : this.resumeTime > startTime ? seekVideoKeyframe(decoder, this.resumeTime, startTime, config.bytes) : startTime;
      this.width = Math.max(1, Math.min(480, decoder.width));
      this.height = Math.max(1, Math.round(this.width * decoder.height / Math.max(1, decoder.width)));
      if (this.height > 480) {
        this.width = Math.max(1, Math.round(this.width * 480 / this.height));
        this.height = 480;
      }
      this.limit = Math.max(2, Math.min(30, Math.floor(16 * 1024 * 1024 / (this.width * this.height * 4))));
      this.step();
    } catch (error) {
      if (epoch === this.epoch) this.report({ id: config.id, error: String(error) });
    }
  }
  stop(id) {
    if (id !== undefined && this.config?.id !== id) return;
    this.epoch++;
    clearTimeout(this.timer);
    this.decoder?.close();
    this.decoder = null;
    this.queue = [];
    this.frame = null;
    this.eof = false;
    this.reportedEnd = false;
    this.config = null;
  }
  timing(id, seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.clocks.set(id, seconds);
    // Audio stream identifiers increase monotonically within this renderer.
    if (this.clocks.size > 32) this.clocks.delete(this.clocks.keys().next().value);
  }
  bind(id, audioId, audioStart, time, endTime) {
    if (this.config?.id !== id) return;
    if (audioId !== undefined) this.config.audioId = audioId;
    if (audioStart !== undefined) this.config.audioStart = audioStart;
    if (time !== undefined) Object.assign(this.config, { time, started: performance.now() });
    if (endTime !== undefined) {
      this.config.endTime = endTime;
      // These frames may have been queued before the next init's first
      // media segment established where the old configuration stops.
      this.queue = this.queue.filter(frame => frame.time + 1e-6 < endTime);
    }
  }
  time() {
    const c = this.config;
    if (c.audioId != null) return c.audioStart + (this.clocks.get(c.audioId) ?? 0);
    // Until its audio stream exists, a known audio track holds the image.
    if (c.hasAudio) return c.time;
    return c.time + (performance.now() - c.started) / 1000;
  }
  step() {
    if (!this.decoder || !this.config) return;
    const time = this.time();
    const endTime = this.config.endTime ?? Infinity;
    const deadline = performance.now() + 8;
    try {
      while (!this.eof && this.queue.length < this.limit && this.nextTime <= time + 0.75
        && this.nextTime + 1e-6 < endTime) {
        const duration = 1 / (this.decoder.fps || 30);
        const keep = this.nextTime + duration > Math.max(this.config.time, this.resumeTime);
        // Preserve codec dependencies while discarding a reopened GOP's prefix.
        // Only frames that can enter the queue need full-size RGBA conversion.
        const pixels = this.decoder.nextFrame(keep ? this.width : 1, keep ? this.height : 1);
        if (!pixels) { this.eof = true; break; }
        if (keep) this.queue.push({ pixels, time: this.nextTime, width: this.width, height: this.height });
        this.nextTime += duration;
        if (performance.now() >= deadline) break;
      }
    } catch {
      // Growing snapshots can throw at their current end. The main thread
      // owns network/refill policy and decides whether this is EOF or an error.
      this.eof = true;
    }
    // A later init can replace buffered frames before this snapshot's EOF.
    // Finish at that media boundary; the renderer opens its next snapshot.
    if (this.nextTime + 1e-6 >= endTime) {
      this.eof = true;
      this.nextTime = endTime;
    }
    let latest = null;
    while (this.queue.length && this.queue[0].time <= time + 1e-6) latest = this.queue.shift();
    if (latest) {
      this.frame = latest;
      if (this.config.shared) {
        const meta = new Int32Array(this.config.shared, 0, 4);
        Atomics.add(meta, 0, 1);
        new Uint8Array(this.config.shared, 16, latest.pixels.length).set(latest.pixels);
        Atomics.store(meta, 1, latest.width);
        Atomics.store(meta, 2, latest.height);
        Atomics.add(meta, 0, 1);
      }
      this.changed();
      this.report({ id: this.config.id, time: latest.time });
    }
    if (this.eof && !this.queue.length && time >= this.nextTime && !this.reportedEnd) {
      this.reportedEnd = true;
      this.report({ id: this.config.id, end: this.nextTime });
    }
    // Yield to pending captures/audio messages, but do not add another 10ms
    // per decoded frame while playback is behind the measured audio clock.
    const catchingUp = !this.eof && this.queue.length < this.limit && this.nextTime <= this.time();
    this.timer = setTimeout(() => this.step(), catchingUp ? 0 : 10);
  }
}

// Black/white raster passes capture the video's contribution after clipping,
// opacity, subtitles and controls. This preserves foreground pixels instead of
// pasting a rectangular video over the page's UI.
// Layers are immutable raster results. Keep sampling geometry and mask runs
// only as long as their layer lives; a decoded frame never enters this cache.
const videoPlans = new WeakMap();
const bgraBases = new WeakMap();
function videoPlan(tile, frame, region = null) {
  const layer = tile.videoLayer;
  const { x, y, width, height } = layer.rect;
  const crop = region ?? { x: 0, y: 0, width: tile.pixelWidth, height: tile.pixelHeight };
  const key = [tile.pixelWidth, tile.pixelHeight, frame.width, frame.height, x, y, width, height,
    crop.x, crop.y, crop.width, crop.height].join(",");
  const previous = videoPlans.get(layer);
  if (previous?.key === key) return previous;
  const left = Math.max(0, Math.floor(x), crop.x), right = Math.min(tile.pixelWidth, Math.ceil(x + width), crop.x + crop.width);
  const top = Math.max(0, Math.floor(y), crop.y), bottom = Math.min(tile.pixelHeight, Math.ceil(y + height), crop.y + crop.height);
  const xs = new Int32Array(Math.max(0, right - left));
  for (let px = left; px < right; px++)
    xs[px - left] = Math.max(0, Math.min(frame.width - 1, Math.floor((px - x) / width * frame.width)));
  const rows = [];
  for (let py = top; py < bottom; py++) {
    const source = Math.max(0, Math.min(frame.height - 1, Math.floor((py - y) / height * frame.height))) * frame.width;
    const maskTarget = py * tile.pixelWidth + left;
    const target = (py - crop.y) * crop.width + left - crop.x;
    const runs = [];
    let kind = -1, begin = 0;
    for (let i = 0; i < xs.length; i++) {
      const d = (maskTarget + i) * 4, m = layer.mask, b = layer.base;
      const next = !(m[d] || m[d + 1] || m[d + 2]) ? 0
        : m[d] === 255 && m[d + 1] === 255 && m[d + 2] === 255
          && !(b[d] || b[d + 1] || b[d + 2]) ? (b[d + 3] === 255 ? 3 : 1) : 2;
      if (next !== kind) {
        if (kind > 0) runs.push(begin, i, kind);
        begin = i; kind = next;
      }
    }
    if (kind > 0) runs.push(begin, xs.length, kind);
    rows.push({ source, target, maskTarget, runs });
  }
  const repeatedRows = rows.some((row, i) => i > 0 && row.source === rows[i - 1].source);
  const plan = { key, xs, rows, repeatedRows };
  videoPlans.set(layer, plan);
  return plan;
}

function videoBase(layer, bgra) {
  let base = layer.base;
  if (bgra) {
    base = bgraBases.get(layer);
    if (!base) {
      base = new Uint8Array(layer.base);
      const words = new Uint32Array(base.buffer);
      for (let i = 0; i < words.length; i++) {
        const p = words[i];
        words[i] = (p & 0xff00ff00) | ((p & 0xff) << 16) | ((p >>> 16) & 0xff);
      }
      bgraBases.set(layer, base);
    }
  }
  return base;
}

function videoBackground(tile, bgra) {
  return bgra && tile.background
    ? [tile.background[2], tile.background[1], tile.background[0], tile.background[3]] : tile.background;
}

// Only fully opaque video runs replace all four bytes. Copy their complement
// from the immutable base; translucent overlays and preserved alpha still need
// the original pixels. Keep these source views on the existing geometry plan,
// so a new crop/format replaces the cache instead of retaining old captures.
function copyStaticVideoBase(base, plan) {
  let copies = plan.baseCopies;
  if (!copies || copies.buffer !== base.buffer || copies.offset !== base.byteOffset || copies.length !== base.length) {
    const spans = [];
    let copied = 0;
    for (const { target, runs } of plan.rows) for (let r = 0; r < runs.length; r += 3) {
      if (runs[r + 2] !== 3) continue;
      const from = (target + runs[r]) * 4, to = (target + runs[r + 1]) * 4;
      if (from > copied) spans.push([copied, base.subarray(copied, from)]);
      copied = to;
    }
    if (copied < base.length) spans.push([copied, base.subarray(copied)]);
    copies = plan.baseCopies = { buffer: base.buffer, offset: base.byteOffset, length: base.length, spans };
  }
  const pixels = Bun.allocUnsafe(base.length);
  // Captures are transferred/detached after delivery. Never borrow a pool or
  // expose a nonzero offset to the packed-pixel compositor.
  if (!(pixels.buffer instanceof ArrayBuffer) || pixels.byteOffset !== 0 || pixels.buffer.byteLength !== base.length)
    return new Uint8Array(base);
  for (const [offset, span] of copies.spans) pixels.set(span, offset);
  return pixels;
}

function compositeVideoPixels(tile, frame, pixels, format, region = null) {
  const layer = tile.videoLayer;
  const bgra = format === "bgra";
  const { xs, rows, repeatedRows } = videoPlan(tile, frame, region);
  const targetWords = new Uint32Array(pixels.buffer, 0, Math.floor(pixels.byteLength / 4));
  const sourceWords = frame.pixels.byteOffset % 4 === 0
    ? new Uint32Array(frame.pixels.buffer, frame.pixels.byteOffset, Math.floor(frame.pixels.byteLength / 4)) : null;
  // Upscaling often repeats one decoded row several times. Expand it once,
  // then copy opaque spans; keep only one scratch row for this capture.
  let expanded = null, expandedSource = -1;
  // Decode output and raster tiles are RGBA. Preserve the raster's alpha:
  // the black/white mask already accounts for video opacity and overlays.
  for (const { source, target, maskTarget, runs } of rows) {
    for (let r = 0; r < runs.length; r += 3) {
      const end = runs[r + 1];
      const kind = runs[r + 2];
      if (kind === 3 && sourceWords && repeatedRows) {
        if (expandedSource !== source) {
          expanded ??= new Uint32Array(xs.length);
          for (let i = 0; i < xs.length; i++) {
            const p = sourceWords[source + xs[i]];
            expanded[i] = 0xff000000 | (bgra
              ? (p & 0x0000ff00) | ((p & 0xff) << 16) | ((p >>> 16) & 0xff)
              : p & 0x00ffffff);
          }
          expandedSource = source;
        }
        targetWords.set(runs[r] === 0 && end === xs.length
          ? expanded : expanded.subarray(runs[r], end), target + runs[r]);
      } else if ((kind === 1 || kind === 3) && sourceWords) {
        for (let i = runs[r]; i < end; i++) {
          const dst = target + i;
          const p = sourceWords[source + xs[i]];
          targetWords[dst] = (kind === 3 ? 0xff000000 : targetWords[dst] & 0xff000000) | (bgra
            ? (p & 0x0000ff00) | ((p & 0xff) << 16) | ((p >>> 16) & 0xff)
            : p & 0x00ffffff);
        }
      } else if (kind === 1 || kind === 3) {
        for (let i = runs[r]; i < end; i++) {
          const dst = (target + i) * 4, src = (source + xs[i]) * 4;
          pixels[dst] = frame.pixels[src + (bgra ? 2 : 0)];
          pixels[dst + 1] = frame.pixels[src + 1];
          pixels[dst + 2] = frame.pixels[src + (bgra ? 0 : 2)];
          if (kind === 3) pixels[dst + 3] = 255;
        }
      } else {
        for (let i = runs[r]; i < end; i++) {
          const dst = (target + i) * 4, src = (source + xs[i]) * 4, mask = (maskTarget + i) * 4;
          for (let c = 0; c < 3; c++) pixels[dst + (bgra ? 2 - c : c)] = Math.min(255,
            layer.base[mask + c] + Math.round(frame.pixels[src + c] * layer.mask[mask + c] / 255));
        }
      }
    }
  }
}

export function compositeVideo(tile, frame, format = "rgba") {
  if (!tile.videoLayer || !frame) return tile;
  const pixels = new Uint8Array(videoBase(tile.videoLayer, format === "bgra"));
  compositeVideoPixels(tile, frame, pixels, format);
  return { ...tile, pixels, pixelFormat: format, background: videoBackground(tile, format === "bgra") };
}

/**
 * Cut the static base before composing video, avoiding offscreen prepaint
 * pixels on each raw capture. Scaled clips keep the full-composite fallback.
 * Pixel sampling stays in the original tile's coordinates: translating a
 * fractional video rect before nearest-neighbour sampling changes its phase.
 * The result exclusively owns its pixels; neither the tile nor its mask/base
 * can be modified or detached when the caller consumes the capture.
 */
export function captureVideoViewport(tile, frame, x, y, width, height, clip, format = "rgba") {
  if (!tile.videoLayer || !frame || (clip && clip.scale !== 1)) return null;
  const base = videoBase(tile.videoLayer, format === "bgra");
  const captured = captureViewport({ ...tile, pixels: base, background: videoBackground(tile, format === "bgra") },
    x, y, width, height, clip);
  const region = {
    x: Math.round(((clip?.x ?? x) - tile.x) * tile.scale),
    y: Math.round(((clip?.y ?? y) - tile.y) * tile.scale),
    width: captured.width, height: captured.height,
  };
  const pixels = captured.pixels.buffer === base.buffer
    ? copyStaticVideoBase(captured.pixels, videoPlan(tile, frame, region)) : captured.pixels;
  compositeVideoPixels(tile, frame, pixels, format, region);
  return { ...captured, pixels, pixelFormat: format };
}
