import {createDirectComposer, downsample, downsampleLinear, type DirectComposer, type DirectScene} from './direct-compositor.ts';
import {encodePng} from './png-fast.js';
import {RawFrames} from './raw-frames.js';
import type {RawFormat} from './render-types.ts';
import { rgbaBitmap } from './frame.js';

/** What the renderer reads: the compositor, or the renderer worker's stand-in for it. */
export interface RenderScene extends DirectScene {
  width: number; height: number; deviceScaleFactor?: number; fastPng?: boolean;
  measure?: (key: string, ms: number) => void;
}
export interface ScreenshotOptions {
  format?: string; quality?: number; maxWidth?: number; maxHeight?: number;
  /** A CSS-pixel crop of the output, rendered at device scale times `scale`. */
  clip?: { x: number; y: number; width: number; height: number; scale: number };
  viewport?: { width?: number; height?: number; deviceScaleFactor?: number };
}
export interface Renderer { close(): void; screenshot(options?: ScreenshotOptions): Promise<string> }

// Options arrive from CDP or a worker message. Each field is read once here; a
// value of another type becomes NaN, which the checks below reject as before.
const optional = (value: unknown): number | undefined => typeof value === 'number' ? value : value === undefined || value === null ? undefined : NaN;
const required = (value: unknown): number => typeof value === 'number' ? value : NaN;
const validSize = (v: number): boolean => Number.isInteger(v) && v > 0 && v <= 8192;
const validLimit = (v: number | undefined): boolean => v === undefined || (Number.isFinite(v) && v > 0);

/** One capture: the requested output, checked, and how to compose it. */
class Capture {
  readonly raw: boolean; readonly label: string;
  constructor(
    readonly format: string, readonly quality: number,
    readonly width: number, readonly height: number, readonly deviceScale: number,
    readonly clipped: boolean, readonly clipX: number, readonly clipY: number,
    readonly factor: number, readonly outWidth: number, readonly outHeight: number,
  ) {
    this.raw = format === 'rgba' || format === 'bgra';
    this.label = `${format}:${outWidth}x${outHeight}`;
  }
}

function readCapture(compositor: RenderScene, options: ScreenshotOptions): Capture {
  const { viewport, clip } = options, format = typeof options.format === 'string' ? options.format : 'png';
  const quality = optional(options.quality) ?? 80, maxWidth = options.maxWidth === undefined ? undefined : required(options.maxWidth), maxHeight = options.maxHeight === undefined ? undefined : required(options.maxHeight);
  const width = optional(viewport?.width) ?? compositor.width, height = optional(viewport?.height) ?? compositor.height;
  if (!validSize(width) || !validSize(height) || width * height > 16777216) throw Error('Invalid capture size');
  if (!validLimit(maxWidth) || !validLimit(maxHeight)) throw Error('Invalid capture limit');
  const deviceScale = optional(viewport?.deviceScaleFactor) ?? compositor.deviceScaleFactor ?? 1;
  if (!Number.isFinite(deviceScale) || deviceScale <= 0 || deviceScale > 8) throw Error('Invalid device scale');
  let clipX = 0, clipY = 0, captureWidth = width, captureHeight = height, clipScale = 1;
  if (clip) {
    clipX = required(clip.x); clipY = required(clip.y); captureWidth = required(clip.width); captureHeight = required(clip.height); clipScale = required(clip.scale);
    if (![clipX, clipY, captureWidth, captureHeight, clipScale].every(Number.isFinite) || captureWidth <= 0 || captureHeight <= 0 || clipScale <= 0 || clipScale > 8) throw Error('Invalid screenshot clip');
  }
  // A supplied clip takes precedence over fallback screencast max limits.
  // Preserve native pixel density: crop, never resize to fit those limits.
  const factor = clip ? deviceScale * clipScale : Math.min(deviceScale, maxWidth ? maxWidth / captureWidth : Infinity, maxHeight ? maxHeight / captureHeight : Infinity);
  const outWidth = Math.max(1, clip ? Math.round(captureWidth * factor) : Math.floor(width * factor)), outHeight = Math.max(1, clip ? Math.round(captureHeight * factor) : Math.floor(height * factor));
  if (outWidth > 8192 || outHeight > 8192 || outWidth * outHeight > 16777216) throw Error('Invalid output size');
  return new Capture(format, quality, width, height, deviceScale, !!clip, clipX, clipY, factor, outWidth, outHeight);
}

class DirectRenderer implements Renderer {
  // SHM snapshots are immutable: each applied buffer commit replaces pixels.
  readonly direct: DirectComposer;
  closed = false;
  constructor(readonly compositor: RenderScene, readonly rawFrames: RawFrames) { this.direct = createDirectComposer(compositor); }
  close(): void {
    if (this.closed) return; this.closed = true;
    this.direct.close();
    this.rawFrames.close();
  }
  /** The output pixels, opaque BGRA words. */
  compose(capture: Capture): Uint32Array {
    const { deviceScale, factor, outWidth, outHeight } = capture;
    // A preview (factor below the device scale) composes the full-size frame
    // and samples it down, as Skia draws a preview from the full image; the
    // full frame stays cached for the next full capture. Below device scale 1
    // downscaled surfaces and previews are filtered.
    const smooth = deviceScale < 1;
    const fullWidth = Math.max(1, Math.floor(capture.width * deviceScale)), fullHeight = Math.max(1, Math.floor(capture.height * deviceScale));
    if (capture.clipped || factor >= deviceScale || fullWidth > 8192 || fullHeight > 8192 || fullWidth * fullHeight > 16777216)
      return this.direct.compose(outWidth, outHeight, factor, capture.clipX, capture.clipY, smooth);
    const full = this.direct.compose(fullWidth, fullHeight, deviceScale, 0, 0, smooth);
    return smooth
      ? downsampleLinear(full, fullWidth, fullHeight, outWidth, outHeight, factor / deviceScale)
      : downsample(full, fullWidth, fullHeight, outWidth, outHeight, factor / deviceScale);
  }
  async screenshot(options: ScreenshotOptions = {}): Promise<string> {
    if (this.closed) throw Error('Renderer is closed');
    const capture = readCapture(this.compositor, options);
    const { format, label, outWidth, outHeight } = capture;
    const measure = this.compositor.measure, started = measure ? performance.now() : 0;
    try {
      const pixels = this.compose(capture);
      measure?.(`${label}:direct-compose`, performance.now() - started);
      const encodeStarted = measure ? performance.now() : 0;
      // Private raw file formats, explicitly negotiated by a cooperating client.
      // Standard screenshot formats and their responses remain unchanged.
      if (capture.raw) {
        const count = pixels.length | 0, rgba = format === 'bgra' ? pixels : new Uint32Array(count);
        if (format === 'rgba')
          for (let i = 0; i < count; i++) {
            const p = pixels[i]! | 0;
            rgba[i] = (p & 0xff00ff00) | ((p & 255) << 16) | ((p >>> 16) & 255);
          }
        measure?.(`${label}:raw-convert`, performance.now() - encodeStarted);
        const writeStarted = measure ? performance.now() : 0;
        const result = this.rawFrames.write(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), outWidth, outHeight, format as RawFormat);
        measure?.(`${label}:raw-file-write`, performance.now() - writeStarted);
        return result;
      }
      let bytes: Uint8Array;
      const kind = format === 'jpeg' || format === 'webp' ? format : 'png';
      // Without Bun.Image, PNG is still available from the built-in encoder.
      if (kind === 'png' && (this.compositor.fastPng || typeof Bun.Image !== 'function')) bytes = encodePng(pixels, outWidth, outHeight, true, true);
      else {
        // One BMP wrapper copy; BGRA masks avoid a channel-conversion pass.
        const bitmap = rgbaBitmap(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), outWidth, outHeight);
        const header = new DataView(bitmap.buffer);
        header.setUint32(54, 0x00ff0000, true); header.setUint32(62, 0x000000ff, true);
        const image = new Bun.Image(bitmap), quality = capture.quality;
        const level = Math.min(100, Math.max(0, Number.isFinite(quality) ? quality : 80));
        bytes = await (kind === 'png' ? image.png().bytes() : image[kind]({quality: level}).bytes());
      }
      const result = Buffer.from(bytes).toString('base64');
      measure?.(`${label}:direct-encode`, performance.now() - encodeStarted);
      return result;
    } finally { measure?.(`${label}:total`,performance.now()-started); }
  }
}

export async function createRenderer(compositor: RenderScene, { rawFrames = new RawFrames() }: { rawFrames?: RawFrames } = {}): Promise<Renderer> {
  return new DirectRenderer(compositor, rawFrames);
}
