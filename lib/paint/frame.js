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
 * The returned pixels may be a view of the immutable tile. Callers must not
 * modify them, including while an asynchronous image encoder is using them.
 * @returns {{ pixels: Uint8Array, width: number, height: number }}
 */
export function cropViewport(tile, scrollX, scrollY, viewportWidth, viewportHeight, exact = false) {
  const scale = tile.scale;
  const width = Math.max(1, Math.round((exact ? viewportWidth : Math.floor(viewportWidth)) * scale));
  const height = Math.max(1, Math.round((exact ? viewportHeight : Math.floor(viewportHeight)) * scale));
  const offsetX = Math.round((scrollX - tile.x) * scale);
  const offsetY = Math.round((scrollY - tile.y) * scale);
  // Raster tiles are normally viewport-wide. A full-width crop is already
  // contiguous RGBA, including a viewport cut out of a taller prepaint tile.
  if (offsetX === 0 && width === tile.pixelWidth && offsetY >= 0 && offsetY + height <= tile.pixelHeight) {
    const start = offsetY * width * 4;
    return { pixels: tile.pixels.subarray(start, start + width * height * 4), width, height };
  }
  const pixels = new Uint8Array(width * height * 4);
  const fromX = Math.max(0, -offsetX);
  const toX = Math.min(width, tile.pixelWidth - offsetX);
  // Background is only needed when the crop extends outside the raster tile.
  let rowFill = null;
  if (fromX > 0 || toX < width || offsetY < 0 || offsetY + height > tile.pixelHeight) {
    const fill = new Uint8Array(tile.background ?? [255, 255, 255, 255]);
    rowFill = new Uint8Array(width * 4);
    new Uint32Array(rowFill.buffer).fill(new Uint32Array(fill.buffer)[0]);
  }
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
 * they are wrapped in an uncompressed BMP first. This copies the contiguous
 * pixel bytes once to add the header, without converting channels or rows.
 * @param {{ format?: "png" | "jpeg" | "webp", quality?: number, optimizeForSpeed?: boolean }} options
 */
export async function encodeImage(pixels, width, height, { format = "png", quality = 80, optimizeForSpeed = false } = {}) {
  return encodePixels(pixels, width, height, format, quality, optimizeForSpeed, "bytes");
}

/** CDP needs base64; let Bun produce it without copying encoded bytes into a Buffer. */
export async function encodeImageBase64(pixels, width, height, { format = "png", quality = 80, optimizeForSpeed = false } = {}) {
  return encodePixels(pixels, width, height, format, quality, optimizeForSpeed, "toBase64");
}

async function encodePixels(pixels, width, height, format, quality, optimizeForSpeed, terminal) {
  const bitmap = rgbaBitmap(pixels, width, height);
  try {
    const image = new Bun.Image(bitmap);
    const kind = IMAGE_FORMATS.has(format) ? format : "png";
    const level = Math.min(100, Math.max(0, Number.isFinite(quality) ? quality : 80));
    const pipeline = kind === "png" ? image.png(optimizeForSpeed ? { compressionLevel: 3 } : undefined) : image[kind]({ quality: level });
    return await pipeline[terminal]();
  } finally {
    // Bun.Image borrows input until its terminal settles. Release only this
    // owned temporary afterwards, instead of waiting for a large-heap GC.
    // The caller's pixels and the encoded output remain independent.
    bitmap.buffer.transfer(0);
  }
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

/** Raw screenshot payload, owned independently of a recyclable raster tile. */
export function rawFrame(pixels, width, height, format) {
  if (!['rgba', 'bgra'].includes(format) || width * height > 16777216) throw Error('Invalid raw screenshot');
  const data = new Uint8Array(pixels);
  if (format === 'bgra') {
    for (let i=0; i<data.length; i+=4) { const red=data[i]; data[i]=data[i+2]; data[i+2]=red; }
  }
  return {format, width, height, pixels:data};
}

// CDP clip coordinates are document CSS pixels, not viewport-relative pixels.
export function captureViewport(tile, x, y, width, height, clip) {
  if (!clip) return cropViewport(tile,x,y,width,height);
  if (![clip.x,clip.y,clip.width,clip.height,clip.scale].every(Number.isFinite)
      || clip.width<=0 || clip.height<=0 || clip.scale<=0 || clip.scale>8)
    throw Error('Invalid screenshot clip');
  const w=Math.max(1,Math.round(clip.width*tile.scale*clip.scale));
  const h=Math.max(1,Math.round(clip.height*tile.scale*clip.scale));
  const sourceW=Math.max(1,Math.round(clip.width*tile.scale));
  const sourceH=Math.max(1,Math.round(clip.height*tile.scale));
  if(Math.max(w,h,sourceW,sourceH)>8192 || w*h>16777216 || sourceW*sourceH>16777216)
    throw Error('Invalid screenshot clip size');
  const frame=cropViewport(tile,clip.x,clip.y,clip.width,clip.height,true);
  if(clip.scale===1)return frame;
  const pixels=new Uint8Array(w*h*4);
  for(let row=0;row<h;row++)for(let col=0;col<w;col++) {
    const from=(Math.min(frame.height-1,Math.floor(row/clip.scale))*frame.width+Math.min(frame.width-1,Math.floor(col/clip.scale)))*4;
    pixels.set(frame.pixels.subarray(from,from+4),(row*w+col)*4);
  }
  return {pixels,width:w,height:h};
}
