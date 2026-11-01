import { deflateSync } from "node:zlib";
const chunk = (name, data) => {
  const out = Buffer.allocUnsafe(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(name, 4, 4, "ascii");
  out.set(data, 8);
  out.writeUInt32BE(
    Bun.hash.crc32(out.subarray(4, 8 + data.length)) >>> 0,
    8 + data.length,
  );
  return out;
};
// Lossless RGB/RGBA PNG, Sub filter + low compression level.
// The direct compositor guarantees opaque output; fallback output is inspected.
export function encodePng(pixels, width, height, bgra = true, opaque = false) {
  if (!opaque) opaque = pixels.every((pixel) => pixel >>> 24 === 255);
  const channels = opaque ? 3 : 4;
  const redShift = bgra ? 16 : 0,
    blueShift = bgra ? 0 : 16;
  const stride = width * channels + 1,
    filtered = Buffer.allocUnsafe(stride * height);
  if (opaque) {
    // Uint8 writes keep the low byte of each difference (PNG Sub modulo 256).
    // Keep the previous packed pixel instead of extracting/masking six channels.
    for (let y = 0; y < height; y++) {
      let target = y * stride;
      filtered[target++] = 1;
      let source = y * width, previous = 0;
      const end = source + width;
      for (; source + 1 < end; source += 2) {
        const p = pixels[source], q = pixels[source + 1];
        filtered[target++] = (p >>> redShift) - (previous >>> redShift);
        filtered[target++] = (p >>> 8) - (previous >>> 8);
        filtered[target++] = (p >>> blueShift) - (previous >>> blueShift);
        filtered[target++] = (q >>> redShift) - (p >>> redShift);
        filtered[target++] = (q >>> 8) - (p >>> 8);
        filtered[target++] = (q >>> blueShift) - (p >>> blueShift);
        previous = q;
      }
      if (source < end) {
        const p = pixels[source];
        filtered[target++] = (p >>> redShift) - (previous >>> redShift);
        filtered[target++] = (p >>> 8) - (previous >>> 8);
        filtered[target++] = (p >>> blueShift) - (previous >>> blueShift);
      }
    }
  } else {
    for (let y = 0; y < height; y++) {
      let target = y * stride;
      filtered[target++] = 1;
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let x = 0; x < width; x++) {
        const p = pixels[y * width + x],
          nr = (p >>> redShift) & 255,
          ng = (p >>> 8) & 255,
          nb = (p >>> blueShift) & 255;
        filtered[target++] = (nr - r) & 255;
        filtered[target++] = (ng - g) & 255;
        filtered[target++] = (nb - b) & 255;
        if (!opaque) {
          const na = p >>> 24;
          filtered[target++] = (na - a) & 255;
          a = na;
        }
        r = nr;
        g = ng;
        b = nb;
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = opaque ? 2 : 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(filtered, { level: 1 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
