import { seekVideoKeyframe } from "../media/video-keyframe.js";

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
      if (epoch !== this.epoch) { decoder.close(); return; }
      this.decoder = decoder;
      this.nextTime = config.time > 0 ? seekVideoKeyframe(decoder, config.time) : 0;
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
  bind(id, audioId, audioStart, time) {
    if (this.config?.id !== id) return;
    Object.assign(this.config, { audioId, audioStart, time });
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
    const deadline = performance.now() + 8;
    try {
      while (!this.eof && this.queue.length < this.limit && this.nextTime <= time + 0.75) {
        const pixels = this.decoder.nextFrame(this.width, this.height);
        if (!pixels) { this.eof = true; break; }
        const frame = { pixels, time: this.nextTime, width: this.width, height: this.height };
        this.nextTime += 1 / (this.decoder.fps || 30);
        // A reopened decoder starts at an earlier keyframe. Decode through
        // that prefix without flashing it over the last displayed picture.
        if (frame.time + 1 / (this.decoder.fps || 30) > this.config.time) this.queue.push(frame);
        if (performance.now() >= deadline) break;
      }
    } catch {
      // Growing snapshots can throw at their current end. The main thread
      // owns network/refill policy and decides whether this is EOF or an error.
      this.eof = true;
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
    this.timer = setTimeout(() => this.step(), 10);
  }
}

// Black/white raster passes capture the video's contribution after clipping,
// opacity, subtitles and controls. This preserves foreground pixels instead of
// pasting a rectangular video over the page's UI.
export function compositeVideo(tile, frame) {
  const layer = tile.videoLayer;
  if (!layer || !frame) return tile;
  const pixels = new Uint8Array(layer.base);
  const { x, y, width, height } = layer.rect;
  for (let py = Math.max(0, Math.floor(y)); py < Math.min(tile.pixelHeight, Math.ceil(y + height)); py++) {
    const sy = Math.max(0, Math.min(frame.height - 1, Math.floor((py - y) / height * frame.height)));
    for (let px = Math.max(0, Math.floor(x)); px < Math.min(tile.pixelWidth, Math.ceil(x + width)); px++) {
      const sx = Math.max(0, Math.min(frame.width - 1, Math.floor((px - x) / width * frame.width)));
      const dst = (py * tile.pixelWidth + px) * 4, src = (sy * frame.width + sx) * 4;
      for (let c = 0; c < 3; c++) pixels[dst + c] = Math.min(255,
        layer.base[dst + c] + Math.round(frame.pixels[src + c] * layer.mask[dst + c] / 255));
    }
  }
  return { ...tile, pixels };
}
