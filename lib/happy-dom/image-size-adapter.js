import {probeRasterImage, decodeRasterImage} from '../renderer/raster-image.js';

/** Header-only for common formats; use the renderer's decoder when Bun cannot probe it. */
export default async function imageSize(buffer) {
  const metadata = await probeRasterImage(buffer);
  if (metadata) return {width:metadata.width,height:metadata.height};
  // Lazy import avoids loading WASM/fonts for ordinary DOM-only image metadata.
  // Reuse the renderer's single CanvasKit instance rather than creating another.
  const {loadGraphics} = await import('../renderer/page-renderer.js');
  const {CanvasKit} = await loadGraphics();
  const {image,width,height} = await decodeRasterImage(CanvasKit,buffer);
  try {return {width,height};} finally {image.delete();}
}
