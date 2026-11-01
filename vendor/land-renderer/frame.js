/**
 * Compositor frames: a raster tile of the page plus where it sits, and the
 * two operations the compositor needs without CanvasKit: cutting the
 * viewport out of a tile and encoding it (with Bun.Image).
 *
 * A tile covers a rectangle of the page in CSS pixels (x, y, width, height)
 * rasterized at `scale` device pixels per CSS pixel; `pixels` is RGBA
 * (unpremultiplied), `pixelWidth` x `pixelHeight`.
 */
/**
 * The viewport's device pixels at a scroll position. Parts of the viewport
 * the tile does not cover show the page background, as Chrome's compositor
 * shows a checkerboard until the missing tiles are rasterized.
 * @returns {{ pixels: Uint8Array, width: number, height: number }}
 */
export function cropViewport(tile, scrollX, scrollY, viewportWidth, viewportHeight) {
  const scale = tile.scale;
  const width = Math.max(1, Math.round(Math.floor(viewportWidth) * scale));
  const height = Math.max(1, Math.round(Math.floor(viewportHeight) * scale));
  const pixels = new Uint8Array(width * height * 4);
  const [red, green, blue, alpha] = tile.background ?? [255, 255, 255, 255];
  const fill = new Uint8Array([red, green, blue, alpha]);
  const offsetX = Math.round((scrollX - tile.x) * scale);
  const offsetY = Math.round((scrollY - tile.y) * scale);
  const fromX = Math.max(0, -offsetX);
  const toX = Math.min(width, tile.pixelWidth - offsetX);
  const rowFill = new Uint8Array(width * 4);
  for (let index = 0; index < width; index++) rowFill.set(fill, index * 4);
  for (let row = 0; row < height; row++) {
    const sourceRow = row + offsetY;
    const target = row * width * 4;
    if (sourceRow < 0 || sourceRow >= tile.pixelHeight || toX <= fromX) {
      pixels.set(rowFill, target);
      continue;
    }
    if (fromX > 0 || toX < width) pixels.set(rowFill, target);
    const source = (sourceRow * tile.pixelWidth + fromX + offsetX) * 4;
    pixels.set(tile.pixels.subarray(source, source + (toX - fromX) * 4), target + fromX * 4);
  }
  return { pixels, width, height };
}

const IMAGE_FORMATS = new Set(["png", "jpeg", "webp"]);

/**
 * Encodes RGBA pixels with Bun.Image. Bun.Image does not read raw pixels, so
 * they are wrapped in an uncompressed BMP first (header only, no copying of
 * rows or channels).
 * @param {{ format?: "png" | "jpeg" | "webp", quality?: number }} options
 */
export async function encodeImage(pixels, width, height, { format = "png", quality = 80 } = {}) {
  const image = new Bun.Image(rgbaBitmap(pixels, width, height));
  const kind = IMAGE_FORMATS.has(format) ? format : "png";
  const level = Math.min(100, Math.max(0, Number.isFinite(quality) ? quality : 80));
  return kind === "png" ? image.png().bytes() : image[kind]({ quality: level }).bytes();
}

/** A 32-bit BMP (BITMAPV4HEADER, BI_BITFIELDS in RGBA byte order, top-down rows) around RGBA pixels. */
export function rgbaBitmap(pixels, width, height) {
  const headerSize = 14 + 108;
  const bitmap = new Uint8Array(headerSize + pixels.byteLength);
  const view = new DataView(bitmap.buffer);
  view.setUint8(0, 0x42);
  view.setUint8(1, 0x4d);
  view.setUint32(2, bitmap.byteLength, true);
  view.setUint32(10, headerSize, true);
  view.setUint32(14, 108, true);
  view.setInt32(18, width, true);
  view.setInt32(22, -height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 32, true);
  view.setUint32(30, 3, true);
  view.setUint32(34, pixels.byteLength, true);
  view.setUint32(54, 0x000000ff, true);
  view.setUint32(58, 0x0000ff00, true);
  view.setUint32(62, 0x00ff0000, true);
  view.setUint32(66, 0xff000000, true);
  view.setUint32(70, 0x73524742, true);
  bitmap.set(pixels, headerSize);
  return bitmap;
}

/** RGBA bytes for a CSS color string such as "rgba(255, 255, 255, 1)". */
export function backgroundBytes(color) {
  const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(String(color));
  if (!match) return [255, 255, 255, 255];
  return [Number(match[1]), Number(match[2]), Number(match[3]), Math.round(Number(match[4] ?? 1) * 255)];
}
