/**
 * Page `<canvas>` 2d contexts, drawn by this process's CanvasKit.
 *
 * `loadGraphics` calls `setCanvasKit` with the instance the page is rasterized
 * with. A second CanvasKit cannot share images with that one, so a page canvas
 * is `CanvasKit.MakeCanvas`, not a separate software bitmap.
 *
 * MakeCanvas has no width or height. Setting either on the element disposes
 * that surface and opens another (HTML resets the bitmap and the drawing
 * state). The object the page holds stays the same and forwards to whichever
 * context is current.
 *
 * `getImageData` builds its array on `readPixels().buffer`, which can be the
 * whole WASM heap. The copy handed back is only the requested rectangle.
 */

let CanvasKit = null;

/** The CanvasKit `loadGraphics` instantiated. Page canvases share it. */
export function setCanvasKit(kit) {
  CanvasKit = kit;
}

const surfaces = new WeakMap();

/** The element's 2d context, or null for any other context id or before CanvasKit loads. */
export function canvasContext(node, type) {
  if (type !== "2d" || !CanvasKit) return null;
  let entry = surfaces.get(node);
  if (!entry) {
    entry = open(node);
    if (!entry) return null;
    surfaces.set(node, entry);
  }
  return entry.proxy;
}

/** Setting width or height clears the bitmap and the drawing state. */
export function resetCanvas(node) {
  surfaces.get(node)?.reopen();
}

// A zero bitmap makes MakeSurface fail and getImageData reject the rectangle.
// The element can still report 0; drawing uses one pixel until it grows.
function bitmapSize(node) {
  return [Math.max(1, node.width >>> 0), Math.max(1, node.height >>> 0)];
}

function open(node) {
  let surface = makeSurface(node);
  if (!surface) return null;
  let context = surface.getContext("2d");
  const proxy = new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === "getImageData") return (sx, sy, sw, sh) => copyImageData(context.getImageData(sx, sy, sw, sh));
      const value = context[property];
      return typeof value === "function" ? value.bind(context) : value;
    },
    set(_target, property, value) {
      context[property] = value;
      return true;
    },
    has(_target, property) {
      return property in context;
    },
  });
  return {
    proxy,
    reopen() {
      const next = makeSurface(node);
      if (!next) return;
      const previous = surface;
      surface = next;
      context = surface.getContext("2d");
      previous.dispose?.();
    },
  };
}

function makeSurface(node) {
  const [width, height] = bitmapSize(node);
  return CanvasKit.MakeCanvas(width, height);
}

function copyImageData(image) {
  if (!image?.data) throw new DOMException("The source rectangle is empty.", "IndexSizeError");
  const count = image.width * image.height * 4;
  const data = new Uint8ClampedArray(count);
  const source = new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, Math.min(count, image.data.length));
  data.set(source);
  return { width: image.width, height: image.height, data, colorSpace: "srgb" };
}
