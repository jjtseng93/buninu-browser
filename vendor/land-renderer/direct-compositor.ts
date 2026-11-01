import { surfaceViewport } from "./viewport.js";
import { snapshotOpaque } from "./snapshot.js";
import type { ViewportSurface } from "./render-types.ts";
import type { Pixels } from "./render-types.ts";

/** A surface as the renderer sees it: the compositor's own, or the renderer worker's copy. */
export interface DirectSurface extends ViewportSurface { fractionalScale?: unknown }
interface Point { x: number; y: number }
/** The parts of a compositor (or the renderer worker's stand-in) that composition reads. */
export interface DirectScene {
  input: { x: number; y: number; pointer?: object | boolean | null; cursor?: { surface: DirectSurface | null; x: number; y: number } | null };
  wm: { renderSurfaces(): Iterable<DirectSurface>; origin(surface: DirectSurface): Point };
}
export interface DirectComposer {
  close(): void;
  /** Opaque BGRA pixels (little-endian words) of the output, or of the clip at `factor`. */
  compose(width: number, height: number, factor?: number, clipX?: number, clipY?: number, smooth?: boolean): Uint32Array;
}

const BACKGROUND = 0xff181b22; // opaque #181b22, BGRA bytes (little endian)

/**
 * Nearest-neighbour downscale of a composed frame, as Skia draws a preview
 * from the full-size image: `scale` (preview factor / full factor) is inverted
 * in float32, and a sample on a pixel edge takes the pixel before it.
 */
export function downsample(src: Uint32Array, srcWidthIn: number, srcHeightIn: number, widthIn: number, heightIn: number, scale: number): Uint32Array {
  // Integer dimensions and indices (`| 0`, Math.imul) for compiled code.
  const srcWidth = srcWidthIn | 0, srcHeight = srcHeightIn | 0, width = widthIn | 0, height = heightIn | 0;
  const inverse = Math.fround(1 / Math.fround(scale));
  const sample = (i: number, limit: number): number => Math.min(limit - 1, Math.ceil(Math.fround(Math.fround(i + 0.5) * inverse)) - 1) | 0;
  const out = new Uint32Array(Math.imul(width, height)), columns = new Int32Array(width);
  for (let x = 0; x < width; x++) columns[x] = sample(x, srcWidth);
  for (let y = 0, di = 0; y < height; y++) {
    const row = Math.imul(sample(y, srcHeight), srcWidth);
    for (let x = 0; x < width; x++, di = (di + 1) | 0) out[di] = src[(row + columns[x]!) | 0]!;
  }
  return out;
}

/**
 * Bilinear downscale of a composed, opaque frame, as Skia draws a filtered
 * preview from the full-size image: each centre is read through the float32
 * inverse scale, and the four pixels around it are blended, clamped at the edges.
 */
export function downsampleLinear(src: Uint32Array, srcWidthIn: number, srcHeightIn: number, widthIn: number, heightIn: number, scale: number): Uint32Array {
  const srcWidth = srcWidthIn | 0, srcHeight = srcHeightIn | 0, width = widthIn | 0, height = heightIn | 0;
  const horizontal = Axis.of(Math.fround(scale), 0, srcWidth, 0, width, true, false);
  const vertical = Axis.of(Math.fround(scale), 0, srcHeight, 0, height, true, false);
  const out = new Uint32Array(Math.imul(width, height));
  for (let y = 0, di = 0; y < height; y++) {
    const r0 = Math.imul(vertical.first[y]!, srcWidth), r1 = Math.imul(vertical.second![y]!, srcWidth), wy = vertical.weight![y]!;
    for (let x = 0; x < width; x++, di = (di + 1) | 0) {
      const c0 = horizontal.first[x]!, c1 = horizontal.second![x]!, wx = horizontal.weight![x]!;
      out[di] = bilinear(src[r0 + c0]! | 0, src[r0 + c1]! | 0, src[r1 + c0]! | 0, src[r1 + c1]! | 0, wx, wy, 0xff000000, false);
    }
  }
  return out;
}

const f32 = Math.fround;
/**
 * A 2D affine matrix in float32, built as Skia's canvas builds its matrix:
 * every operation pre-concatenates. device = (m00 u + m01 v + m03, m10 u + m11 v + m13).
 */
class Matrix {
  m00 = 1; m01 = 0; m03 = 0; m10 = 0; m11 = 1; m13 = 0;
  copy(): Matrix {
    const m = new Matrix();
    m.m00 = this.m00; m.m01 = this.m01; m.m03 = this.m03; m.m10 = this.m10; m.m11 = this.m11; m.m13 = this.m13;
    return m;
  }
  translate(xIn: number, yIn: number): void {
    const x = f32(xIn), y = f32(yIn);
    this.m03 = f32(f32(f32(this.m00 * x) + f32(this.m01 * y)) + this.m03);
    this.m13 = f32(f32(f32(this.m10 * x) + f32(this.m11 * y)) + this.m13);
  }
  scale(xIn: number, yIn: number): void {
    const x = f32(xIn), y = f32(yIn);
    this.m00 = f32(this.m00 * x); this.m10 = f32(this.m10 * x);
    this.m01 = f32(this.m01 * y); this.m11 = f32(this.m11 * y);
  }
  /** A quarter turn by `turns` (counter-clockwise for -1), as Skia's rotate snaps sin/cos to 0 and ±1. */
  rotate(turns: number): void {
    const t = ((turns % 4) + 4) % 4, cos = t === 0 ? 1 : t === 2 ? -1 : 0, sin = t === 1 ? 1 : t === 3 ? -1 : 0;
    const m00 = this.m00, m01 = this.m01, m10 = this.m10, m11 = this.m11;
    this.m00 = f32(m00 * cos + m01 * sin); this.m01 = f32(m00 * -sin + m01 * cos);
    this.m10 = f32(m10 * cos + m11 * sin); this.m11 = f32(m10 * -sin + m11 * cos);
  }
}

/** Device pixels [start, end) covered by an edge pair, rounded as Skia rounds non-antialiased edges. */
function span(a: number, b: number, limit: number): [number, number] {
  return [Math.max(0, Math.round(Math.min(a, b))), Math.min(limit, Math.round(Math.max(a, b)))];
}

/**
 * One device axis of a placed surface: which pixels it covers, and for each the
 * buffer coordinate it samples, read through the inverse float32 matrix at the
 * pixel centre. Nearest samples take the pixel before an exact edge; linear
 * samples blend the two pixels around the centre, clamped at the buffer edges.
 */
class Axis {
  constructor(
    readonly start: number, readonly count: number,
    /** Nearest: one buffer index per pixel. Linear: the lower index. */
    readonly first: Int32Array,
    /** Linear only: the upper index and its weight. */
    readonly second: Int32Array | null, readonly weight: Float32Array | null,
  ) {}
  static of(scale: number, translate: number, size: number, start: number, end: number, linear: boolean, exactInverse: boolean): Axis {
    const count = Math.max(0, end - start) | 0, last = (size - 1) | 0;
    // Skia inverts a scale-translate matrix in float32 and a rotated one through its determinant.
    const inverse = f32(1 / scale), shift = exactInverse ? f32(-translate / scale) : f32(-translate * inverse);
    const first = new Int32Array(count);
    const second = linear ? new Int32Array(count) : null, weight = linear ? new Float32Array(count) : null;
    for (let i = 0; i < count; i++) {
      const u = f32(f32(f32(start + i + 0.5) * inverse) + shift);
      if (!linear) { first[i] = Math.min(last, Math.max(0, Math.ceil(u) - 1)); continue; }
      const t = u - 0.5, low = Math.floor(t);
      first[i] = Math.min(last, Math.max(0, low)); second![i] = Math.min(last, Math.max(0, low + 1)); weight![i] = t - low;
    }
    return new Axis(start, count, first, second, weight);
  }
}

/** How a row's pixels reach the output: copied, copied with alpha forced (XRGB), or blended. */
const OPAQUE = 0, XRGB = 1, BLEND = 2;
/** One surface's validated placement; also part of the scene's cache key. */
class Row {
  constructor(
    readonly buffer: Pixels, readonly words: Uint32Array, readonly stride: number, readonly kind: number,
    readonly m: Matrix, readonly clip: number[] | null, readonly linear: boolean,
    readonly left: number, readonly top: number, readonly right: number, readonly bottom: number,
  ) {}
  equals(o: Row): boolean {
    const a = this.m, b = o.m, c = this.clip, d = o.clip;
    return this.buffer === o.buffer && this.words === o.words && this.kind === o.kind && this.linear === o.linear &&
      a.m00 === b.m00 && a.m01 === b.m01 && a.m03 === b.m03 && a.m10 === b.m10 && a.m11 === b.m11 && a.m13 === b.m13 &&
      (c === null ? d === null : d !== null && c[0] === d[0] && c[1] === d[1] && c[2] === d[2] && c[3] === d[3]);
  }
}
class Scene {
  constructor(readonly width: number, readonly height: number, readonly rows: Row[], readonly pointer: Point | null,
    readonly factor: number, readonly clipX: number, readonly clipY: number) {}
  equals(o: Scene): boolean {
    if (this.width !== o.width || this.height !== o.height || this.rows.length !== o.rows.length ||
        this.factor !== o.factor || this.clipX !== o.clipX || this.clipY !== o.clipY) return false;
    for (let i = 0; i < this.rows.length; i++) if (!this.rows[i]!.equals(o.rows[i]!)) return false;
    const a = this.pointer, b = o.pointer;
    return a === null ? b === null : b !== null && a.x === b.x && a.y === b.y;
  }
}
/** Buffer words, and the stride in words; a misaligned or odd-strided buffer is packed once. */
class Words { constructor(readonly words: Uint32Array, readonly stride: number) {} }

// The software compositor: every surface (any buffer transform, viewport crop
// and scale, translucency, cursor) and the built-in pointer, drawn as Skia draws
// them on a canvas scaled by `factor` and translated by the clip origin: nearest
// sampling, or linear sampling of downscaled surfaces when `smooth`.
export function createDirectComposer(compositor: DirectScene): DirectComposer {
  let cachedScene: Scene | null = null, cachedPixels: Uint32Array | null = null;
  const axes = new Map<string, Axis>();
  const axis: typeof Axis.of = (...args) => {
    const key = args.join(':');
    let value = axes.get(key);
    if (!value) {
      value = Axis.of(...args);
      // Geometry only, never client pixels. Bound memory during resize/drag.
      if (axes.size >= 128) axes.delete(axes.keys().next().value!);
      axes.set(key, value);
    }
    return value;
  };
  let cursorTile: {row: Row; width: number; height: number; samples: Float64Array} | null = null;
  // Buffer snapshots are immutable; replacement commits use a new key.
  // Word views (or packed copies of misaligned buffers) are kept per snapshot.
  let opacity = new WeakMap<Pixels, boolean>(), packed = new WeakMap<Pixels, Words>();
  function words(b: Pixels, bytes: Uint8Array): Words {
    let view = packed.get(b);
    if (!view) {
      if (b.stride % 4 === 0 && bytes.byteOffset % 4 === 0)
        view = new Words(new Uint32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4)), b.stride >> 2);
      else {
        const out = new Uint8Array(b.width * b.height * 4);
        for (let y = 0; y < b.height; y++) out.set(bytes.subarray(y * b.stride, y * b.stride + b.width * 4), y * b.width * 4);
        view = new Words(new Uint32Array(out.buffer), b.width);
      }
      packed.set(b, view);
    }
    return view;
  }
  function opaque(b: Pixels, bytes: Uint8Array): boolean {
    // Share full-frame validation with cursor-tile composition: do not scan the
    // complete client image again just to draw a small cursor rectangle.
    // The generic compositor also accepts buffers without final-row padding.
    if (bytes.byteLength >= b.stride * b.height) return snapshotOpaque(b, bytes);
    let known = opacity.get(b);
    if (known === undefined) {
      known = true;
      // Locals: the buffer may come from JavaScript, whose objects have no layout here.
      const rowsOf = b.height | 0, columnsOf = b.width | 0, strideOf = b.stride | 0;
      for (let row = 0; row < rowsOf && known; row++)
        for (let column = 0, at = (Math.imul(row, strideOf) + 3) | 0; column < columnsOf; column++, at = (at + 4) | 0)
          if (bytes[at] !== 255) { known = false; break; }
      opacity.set(b, known);
    }
    return known;
  }
  return {
    close() {
      cachedScene = cachedPixels = null;
      axes.clear(); cursorTile = null;
      opacity = new WeakMap(); packed = new WeakMap();
    },
    compose(width: number, height: number, factor = 1, clipX = 0, clipY = 0, smooth = false): Uint32Array {
      const input = compositor.input, cursor = input.cursor, rows: Row[] = [];
      const outWidth = width | 0, outHeight = height | 0;
      let cursorRow: Row | null = null;
      const surfaces = [...compositor.wm.renderSurfaces()];
      if (cursor?.surface?.pixels) surfaces.push(cursor.surface);
      for (const surface of surfaces) {
        const b = surface.pixels, bytes: Uint8Array | undefined = b?.bytes;
        if (!b || !bytes || !(b.width > 0) || !(b.height > 0) || bytes.byteLength < b.stride * (b.height - 1) + b.width * 4) continue;
        let { x, y } = surface === cursor?.surface ? { x: input.x - cursor.x, y: input.y - cursor.y } : compositor.wm.origin(surface);
        const viewport = surfaceViewport(surface)!, source = viewport.source;
        const sx = source[0]!, sy = source[1]!, sw = source[2]!, sh = source[3]!;
        let dw = viewport.width, dh = viewport.height;
        const transform = surface.transform | 0, rotation = transform & 3, scale = surface.scale;
        const w = rotation % 2 ? b.height : b.width, h = rotation % 2 ? b.width : b.height;
        if (![x, y, dw, dh, sw, sh].every(Number.isFinite) || dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) continue;
        // Fractional clients round their buffers to physical pixels. Match that
        // rounding when it gives a 1:1 mapping, avoiding a second filter.
        if (surface.fractionalScale && scale === 1 && sx === 0 && sy === 0 && sw === w && sh === h &&
            Math.round(dw * factor) === w && Math.round(dh * factor) === h) {
          x = Math.round(x * factor) / factor; y = Math.round(y * factor) / factor;
          dw = w / factor; dh = h / factor;
        }
        const m = new Matrix();
        m.scale(factor, factor); m.translate(-clipX, -clipY); m.translate(x, y);
        let clip: number[] | null = null;
        if (sx !== 0 || sy !== 0 || sw !== w / scale || sh !== h / scale) {
          const [left, right] = span(m.m03, f32(f32(m.m00 * f32(dw)) + m.m03), outWidth);
          const [top, bottom] = span(m.m13, f32(f32(m.m11 * f32(dh)) + m.m13), outHeight);
          clip = [left, top, right, bottom];
        }
        if (dw !== sw || dh !== sh) m.scale(dw / sw, dh / sh);
        if (sx !== 0 || sy !== 0) m.translate(-sx, -sy);
        m.scale(1 / scale, 1 / scale);
        if (transform & 4) { m.translate(w, 0); m.scale(-1, 1); }
        if (rotation === 1) { m.translate(0, b.width); m.rotate(-1); }
        if (rotation === 2) { m.translate(b.width, b.height); m.rotate(2); }
        if (rotation === 3) { m.translate(b.height, 0); m.rotate(1); }
        // Device bounds of the buffer, as Skia maps and rounds a non-antialiased image rectangle.
        const swap = m.m00 === 0;
        const [left0, right0] = span(m.m03, f32(f32((swap ? m.m01 * b.height : m.m00 * b.width)) + m.m03), outWidth);
        const [top0, bottom0] = span(m.m13, f32(f32((swap ? m.m10 * b.width : m.m11 * b.height)) + m.m13), outHeight);
        const left = Math.max(left0, clip?.[0] ?? 0), top = Math.max(top0, clip?.[1] ?? 0);
        const right = Math.min(right0, clip?.[2] ?? outWidth), bottom = Math.min(bottom0, clip?.[3] ?? outHeight);
        if (left >= right || top >= bottom) continue;
        const linear = smooth && (factor * dw / sw / scale < 1 - 1e-6 || factor * dh / sh / scale < 1 - 1e-6);
        const kind = opaque(b, bytes) ? OPAQUE : b.format === 1 ? XRGB : BLEND;
        const buffer = words(b, bytes);
        const row = new Row(b, buffer.words, buffer.stride, kind, m, clip, linear, left, top, right, bottom);
        rows.push(row);
        if (surface === cursor?.surface) cursorRow = row;
      }
      if (!cursorRow) cursorTile = null;
      const pointer = !cursor && !!input.pointer && Number.isFinite(input.x) && Number.isFinite(input.y);
      const scene = new Scene(width, height, rows, pointer ? { x: input.x, y: input.y } : null, factor, clipX, clipY);
      if (cachedScene?.equals(scene)) return cachedPixels!;
      // For compiled code: integer coordinates (`| 0`, Math.imul) stay 32-bit
      // integers. Outputs are at most 8192 x 8192, so each index fits.
      const out = new Uint32Array(outWidth * outHeight);
      // An opaque surface covering the output 1:1 is already the desktop. Copy it
      // once, then draw only what lies above it. Never modify client snapshots:
      // moving or removing a cursor must reveal them again.
      let base = -1;
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i]!, m = row.m;
        if (row.kind === OPAQUE && !row.linear && m.m00 === 1 && m.m11 === 1 && m.m01 === 0 && m.m10 === 0 && m.m03 === 0 && m.m13 === 0 &&
            row.left === 0 && row.top === 0 && row.right === outWidth && row.bottom === outHeight && row.stride === outWidth &&
            row.buffer.width === outWidth && row.buffer.height >= outHeight) { base = i; break; }
      }
      if (base >= 0) out.set(rows[base]!.words.subarray(0, outWidth * outHeight));
      else out.fill(BACKGROUND);
      for (let index = base + 1; index < rows.length; index++) {
        const row = rows[index]!;
        // Later opaque surfaces spanning these columns hide whole output rows.
        let hidden: Uint8Array | null = null;
        const lines = (row.bottom - row.top) | 0;
        for (let later = index + 1; later < rows.length; later++) {
          const o = rows[later]!;
          if (o.kind === BLEND || o.left > row.left || o.right < row.right) continue;
          const top = Math.max(row.top, o.top), bottom = Math.min(row.bottom, o.bottom);
          if (top < bottom) (hidden ??= new Uint8Array(lines)).fill(1, top - row.top, bottom - row.top);
        }
        if (row === cursorRow && row.right - row.left <= 512 && row.bottom - row.top <= 512) {
          if (!cursorTile || cursorTile.width !== outWidth || cursorTile.height !== outHeight || !cursorTile.row.equals(row))
            cursorTile = {row, width: outWidth, height: outHeight, samples: cursorSamples(row, axis)};
          drawCursor(out, outWidth, row, cursorTile.samples);
        } else {
          if (row === cursorRow) cursorTile = null;
          draw(out, outWidth, row, hidden, axis);
        }
      }
      if (pointer) {
        // Skia draws two non-antialiased rectangles in logical coordinates.
        const m = new Matrix();
        m.scale(factor, factor); m.translate(-clipX, -clipY);
        for (const [w, h] of [[3, 15], [10, 3]] as const) {
          const [x0, x1] = span(f32(f32(m.m00 * f32(input.x)) + m.m03), f32(f32(m.m00 * f32(input.x + w)) + m.m03), outWidth);
          const [y0, y1] = span(f32(f32(m.m11 * f32(input.y)) + m.m13), f32(f32(m.m11 * f32(input.y + h)) + m.m13), outHeight);
          for (let y = y0; y < y1; y++) out.fill(0xffffffff, Math.imul(y, outWidth) + x0, Math.imul(y, outWidth) + x1);
        }
      }
      cachedScene = scene;
      cachedPixels = out;
      return out;
    },
  };
}

/** Wayland ARGB is premultiplied and the destination stays opaque: src + dst * (1 - alpha). */
function blend(p: number, q: number, alpha: number): number {
  const inverse = 255 - alpha;
  const blue = Math.min(255, (p & 255) + Math.round(((q & 255) * inverse) / 255));
  const green = Math.min(255, ((p >> 8) & 255) + Math.round((((q >> 8) & 255) * inverse) / 255));
  const red = Math.min(255, ((p >> 16) & 255) + Math.round((((q >> 16) & 255) * inverse) / 255));
  return (0xff000000 | (red << 16) | (green << 8) | blue) >>> 0;
}

function draw(out: Uint32Array, outWidth: number, row: Row, hidden: Uint8Array | null, axis: typeof Axis.of): void {
  const m = row.m, b = row.buffer, swap = m.m00 === 0, stride = row.stride | 0;
  // Each device axis reads one buffer axis; a rotated surface swaps them.
  const horizontal = axis(swap ? m.m01 : m.m00, m.m03, swap ? b.height : b.width, row.left, row.right, row.linear, swap);
  const vertical = axis(swap ? m.m10 : m.m11, m.m13, swap ? b.width : b.height, row.top, row.bottom, row.linear, swap);
  // Word offsets in the buffer contributed by each axis.
  const across = (axis: Axis, values: Int32Array, rows: boolean): Int32Array => {
    if (!rows) return values;
    const result = new Int32Array(axis.count);
    for (let i = 0; i < axis.count; i++) result[i] = Math.imul(values[i]!, stride);
    return result;
  };
  const h0 = across(horizontal, horizontal.first, swap), v0 = across(vertical, vertical.first, !swap);
  const src = row.words, kind = row.kind, count = horizontal.count | 0, lines = vertical.count | 0, x0 = horizontal.start | 0;
  if (!row.linear) {
    // An unswapped 1:1 column mapping copies whole row spans.
    const first = h0[0]! | 0, contiguous = !swap && h0[count - 1]! - first === count - 1;
    let previousSource = -1, previousOutput = 0;
    for (let line = 0; line < lines; line++) {
      if (hidden !== null && hidden[line]) continue;
      const sourceRow = v0[line]! | 0;
      let di = (Math.imul(vertical.start + line, outWidth) + x0) | 0;
      if (kind === OPAQUE) {
        if (sourceRow === previousSource) out.copyWithin(di, previousOutput, previousOutput + count);
        else if (contiguous) out.set(src.subarray(sourceRow + first, sourceRow + first + count), di);
        else for (let i = 0; i < count; i++) out[di + i] = src[(sourceRow + h0[i]!) | 0]!;
        previousSource = sourceRow; previousOutput = di;
        continue;
      }
      for (let i = 0; i < count; i++, di++) {
        const p = src[(sourceRow + h0[i]!) | 0]! | 0;
        if (kind === XRGB) { out[di] = (p | 0xff000000) >>> 0; continue; }
        const alpha = (p >>> 24) & 255;
        if (alpha === 255) out[di] = p >>> 0;
        else if (alpha !== 0) out[di] = blend(p, out[di]! | 0, alpha);
      }
    }
    return;
  }
  // Linear: blend the four buffer pixels around each centre in premultiplied
  // floats, then composite and round as an 8-bit store does.
  const h1 = across(horizontal, horizontal.second!, swap), v1 = across(vertical, vertical.second!, !swap);
  // A swapped surface's horizontal weight runs along buffer rows, its vertical one along columns.
  const hw = horizontal.weight!, vw = vertical.weight!;
  for (let line = 0; line < lines; line++) {
    if (hidden !== null && hidden[line]) continue;
    const r0 = v0[line]! | 0, r1 = v1[line]! | 0, wy = vw[line]!;
    let di = (Math.imul(vertical.start + line, outWidth) + x0) | 0;
    for (let i = 0; i < count; i++, di++) {
      const c0 = h0[i]! | 0, c1 = h1[i]! | 0, wx = hw[i]!;
      out[di] = bilinear(src[(r0 + c0) | 0]! | 0, src[(r0 + c1) | 0]! | 0, src[(r1 + c0) | 0]! | 0, src[(r1 + c1) | 0]! | 0,
        wx, wy, out[di]! | 0, kind === BLEND);
    }
  }
}

/**
 * Four premultiplied pixels blended with weights `wx`, `wy` in floats, then
 * composited over `q` (when `translucent`) and rounded as an 8-bit store does.
 */
function bilinear(a: number, b: number, c: number, d: number, wx: number, wy: number, q: number, translucent: boolean): number {
  const ka = (1 - wx) * (1 - wy), kb = wx * (1 - wy), kc = (1 - wx) * wy, kd = wx * wy;
  // Unrolled per channel: no closures in the per-pixel path.
  const keep = translucent ? 1 - (((a >>> 24) & 255) * ka + ((b >>> 24) & 255) * kb + ((c >>> 24) & 255) * kc + ((d >>> 24) & 255) * kd) / 255 : 0;
  const red = Math.min(255, Math.round(((a >>> 16) & 255) * ka + ((b >>> 16) & 255) * kb + ((c >>> 16) & 255) * kc + ((d >>> 16) & 255) * kd + ((q >>> 16) & 255) * keep));
  const green = Math.min(255, Math.round(((a >>> 8) & 255) * ka + ((b >>> 8) & 255) * kb + ((c >>> 8) & 255) * kc + ((d >>> 8) & 255) * kd + ((q >>> 8) & 255) * keep));
  const blue = Math.min(255, Math.round((a & 255) * ka + (b & 255) * kb + (c & 255) * kc + (d & 255) * kd + (q & 255) * keep));
  return (0xff000000 | (red << 16) | (green << 8) | blue) >>> 0;
}


// Cache cursor sampling, not its blend against the changing desktop. Keep
// unrounded doubles for linear filtering so final rounding matches bilinear().
function cursorSamples(row: Row, axis: typeof Axis.of): Float64Array {
  const m = row.m, b = row.buffer, swap = m.m00 === 0;
  const h = axis(swap ? m.m01 : m.m00, m.m03, swap ? b.height : b.width, row.left, row.right, row.linear, swap);
  const v = axis(swap ? m.m10 : m.m11, m.m13, swap ? b.width : b.height, row.top, row.bottom, row.linear, swap);
  const data = new Float64Array(h.count * v.count * 4), src = row.words;
  const at = (x: number, y: number) => src[swap ? x * row.stride + y : y * row.stride + x]!;
  for (let y = 0, i = 0; y < v.count; y++) for (let x = 0; x < h.count; x++, i += 4) {
    const a = at(h.first[x]!, v.first[y]!);
    if (!row.linear) {
      data[i] = a; // Exact packed pixel; blending still uses the original formula.
      continue;
    }
    const b = at(h.second![x]!, v.first[y]!), c = at(h.first[x]!, v.second![y]!), d = at(h.second![x]!, v.second![y]!);
    const wx = h.weight![x]!, wy = v.weight![y]!;
    const ka = (1-wx)*(1-wy), kb = wx*(1-wy), kc = (1-wx)*wy, kd = wx*wy;
    data[i] = ((a >>> 16)&255)*ka + ((b >>> 16)&255)*kb + ((c >>> 16)&255)*kc + ((d >>> 16)&255)*kd;
    data[i+1] = ((a >>> 8)&255)*ka + ((b >>> 8)&255)*kb + ((c >>> 8)&255)*kc + ((d >>> 8)&255)*kd;
    data[i+2] = (a&255)*ka + (b&255)*kb + (c&255)*kc + (d&255)*kd;
    data[i+3] = row.kind === BLEND ? 1-(((a>>>24)&255)*ka+((b>>>24)&255)*kb+((c>>>24)&255)*kc+((d>>>24)&255)*kd)/255 : 0;
  }
  return data;
}
function drawCursor(out: Uint32Array, width: number, row: Row, samples: Float64Array): void {
  for (let y = row.top, i = 0; y < row.bottom; y++) for (let x = row.left; x < row.right; x++, i += 4) {
    const at = y * width + x, q = out[at]!;
    if (!row.linear) {
      const p = samples[i]! >>> 0, alpha = row.kind === BLEND ? p >>> 24 : 255;
      if (alpha === 255) out[at] = (p | 0xff000000) >>> 0;
      else if (alpha !== 0) out[at] = blend(p, q, alpha);
    } else {
      const keep = samples[i+3]!;
      const r = Math.min(255, Math.round(samples[i]! + ((q>>>16)&255)*keep));
      const g = Math.min(255, Math.round(samples[i+1]! + ((q>>>8)&255)*keep));
      const b = Math.min(255, Math.round(samples[i+2]! + (q&255)*keep));
      out[at] = (0xff000000 | r<<16 | g<<8 | b) >>> 0;
    }
  }
}
