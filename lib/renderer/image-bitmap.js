/**
 * ImageData, ImageBitmap and createImageBitmap() (HTML §4.12.5.1.15 and §8.10) for a page.
 *
 * An ImageBitmap holds a CanvasKit image in the same CanvasKit instance page canvases draw
 * with (canvas-2d.js), so drawImage and createPattern take it like any other image source.
 * createImageBitmap accepts a Blob, an <img>/<svg image>, a <canvas>, a <video>, an ImageData
 * or another ImageBitmap, with the optional source rectangle and the resize, quality and
 * imageOrientation options; the bitmap is a snapshot, so later changes to its source never
 * reach it. premultiplyAlpha and colorSpaceConversion are accepted: every bitmap is sRGB,
 * and drawing composites the same either way.
 *
 * ImageData is constructible by the page, and getImageData/createImageData return it, so
 * `x instanceof ImageData` and `new ImageData(rgba, width, height)` behave as in a browser.
 */
import { canvasKit } from "./canvas-2d.js";
import { decodeRasterImage } from "./raster-image.js";
import { decodeSvgImage } from "./svg-image.js";

const RESIZE_QUALITIES = new Set(["pixelated", "low", "medium", "high"]);
const ORIENTATIONS = new Set(["from-image", "flipY", "none"]);
const PREMULTIPLY = new Set(["none", "premultiply", "default"]);
const COLOR_SPACE_CONVERSIONS = new Set(["none", "default"]);
const COLOR_SPACES = new Set(["srgb", "display-p3"]);
/**
 * @param {object} options
 * @param {(value: any) => any} options.nodeOf the DOM node behind a page element, or null
 * @param {(node: any) => any} options.canvasImage the image an element draws, as canvas drawImage reads it
 * @param {(value: any) => boolean} options.isBlob whether a page value is a Blob
 * @param {any} options.DOMException the page's DOMException
 * @param {() => any} [options.global] the page's global, for its Uint8ClampedArray
 */
export function imageBitmapInterface({ nodeOf, canvasImage, isBlob, DOMException, global = () => globalThis }) {
  // The page's own typed array: an ImageData's data is the page realm's Uint8ClampedArray.
  const ClampedArray = () => global()?.Uint8ClampedArray ?? Uint8ClampedArray;
  // The page's own error constructors, so its instanceof checks hold.
  const TypeError = (...args) => new (global()?.TypeError ?? globalThis.TypeError)(...args);
  const RangeError = (...args) => new (global()?.RangeError ?? globalThis.RangeError)(...args);
  // WebIDL conversions: long is ToInt32, unsigned long ToUint32, [EnforceRange] rejects what does not fit.
  const toLong = (value) => Number(value) | 0;
  const toUnsignedLong = (value) => Number(value) >>> 0;
  function enforceUnsignedLong(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw TypeError(`The ${name} is not a finite number.`);
    const whole = Math.trunc(number);
    if (whole < 0 || whole > 0xffffffff) throw TypeError(`The ${name} is outside the range [0, 4294967295].`);
    return whole;
  }
  function enumValue(value, allowed, name) {
    const text = String(value);
    if (!allowed.has(text)) throw TypeError(`The provided value '${text}' is not a valid enum value of type ${name}.`);
    return text;
  }
  const isClamped = (value) => ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8ClampedArray]";
  const dataSlots = new WeakMap();
  const bitmapSlots = new WeakMap();
  const bitmapFinalizer = new FinalizationRegistry((image) => image.delete());

  // ImageData(sw, sh[, settings]) or ImageData(data, sw[, sh][, settings]).
  function ImageData(first, second, third = undefined, fourth = undefined) {
    if (!new.target) throw TypeError("Constructor ImageData requires 'new'");
    if (arguments.length < 2) throw TypeError(`Failed to construct 'ImageData': 2 arguments required, but only ${arguments.length} present.`);
    let data, width, height, settings;
    if (first !== null && typeof first === "object" && !isClamped(first))
      throw TypeError("Failed to construct 'ImageData': parameter 1 is not of type 'Uint8ClampedArray'.");
    if (isClamped(first)) {
      data = first;
      width = dimension(second, "width");
      const pixels = data.length / 4;
      if (data.length === 0 || data.length % 4 !== 0)
        throw new DOMException("The input data length is not a multiple of 4.", "InvalidStateError");
      if (pixels % width !== 0)
        throw new DOMException("The input data length is not a multiple of (4 * width).", "IndexSizeError");
      height = pixels / width;
      if (third !== undefined && dimension(third, "height") !== height)
        throw new DOMException("The input data length is not equal to (4 * width * height).", "IndexSizeError");
      settings = fourth;
    } else {
      width = dimension(first, "width");
      height = dimension(second, "height");
      data = new (ClampedArray())(width * height * 4);
      settings = third;
    }
    if (settings !== undefined && settings !== null && typeof settings !== "object")
      throw TypeError("Failed to construct 'ImageData': The provided value is not of type 'ImageDataSettings'.");
    const colorSpace = settings?.colorSpace === undefined ? "srgb" : enumValue(settings.colorSpace, COLOR_SPACES, "PredefinedColorSpace");
    const self = Object.create(new.target.prototype);
    dataSlots.set(self, { width, height, data, colorSpace });
    return self;
  }
  function dimension(value, name) {
    const number = toUnsignedLong(value);
    if (number === 0) throw new DOMException(`The source ${name} is zero or not a number.`, "IndexSizeError");
    return number;
  }
  const dataSlot = (self) => {
    const slot = dataSlots.get(self);
    if (!slot) throw TypeError("Illegal invocation");
    return slot;
  };
  for (const name of ["width", "height", "data", "colorSpace"])
    Object.defineProperty(ImageData.prototype, name, { configurable: true, enumerable: true, get() { return dataSlot(this)[name]; } });
  Object.defineProperty(ImageData.prototype, Symbol.toStringTag, { configurable: true, value: "ImageData" });

  /** A canvas readback ({width, height, data}) as a page ImageData, sharing its array. */
  function makeImageData({ width, height, data, colorSpace = "srgb" }) {
    const self = Object.create(ImageData.prototype);
    dataSlots.set(self, { width, height, data, colorSpace });
    return self;
  }

  function ImageBitmap() {
    throw TypeError("Illegal constructor");
  }
  const bitmapSlot = (self) => {
    const slot = bitmapSlots.get(self);
    if (!slot) throw TypeError("Illegal invocation");
    return slot;
  };
  Object.defineProperty(ImageBitmap.prototype, "width", { configurable: true, enumerable: true, get() { const s = bitmapSlot(this); return s.image ? s.width : 0; } });
  Object.defineProperty(ImageBitmap.prototype, "height", { configurable: true, enumerable: true, get() { const s = bitmapSlot(this); return s.image ? s.height : 0; } });
  Object.defineProperty(ImageBitmap.prototype, "close", { configurable: true, enumerable: true, writable: true,
    value: function close() {
      const slot = bitmapSlot(this);
      bitmapFinalizer.unregister(this);
      slot.image?.delete();
      slot.image = null;
    } });
  Object.defineProperty(ImageBitmap.prototype, Symbol.toStringTag, { configurable: true, value: "ImageBitmap" });

  /** The image canvas drawImage/createPattern draw for an ImageBitmap, or undefined for other values. */
  function bitmapResource(value) {
    const slot = value && typeof value === "object" ? bitmapSlots.get(value) : null;
    if (!slot) return undefined;
    if (!slot.image) throw new DOMException("The image source is detached.", "InvalidStateError");
    return { image: slot.image, width: slot.width, height: slot.height, originClean: slot.originClean };
  }

  // The source's image, owned by the caller when `owned` (it must be deleted), with its size.
  async function sourceImage(kit, image) {
    if (bitmapSlots.has(image)) {
      const resource = bitmapResource(image);
      return { image: resource.image, owned: false, width: resource.width, height: resource.height, originClean: resource.originClean };
    }
    if (dataSlots.has(image)) {
      const { width, height, data } = dataSlots.get(image);
      const made = kit.MakeImage({ width, height, alphaType: kit.AlphaType.Unpremul, colorType: kit.ColorType.RGBA_8888,
        colorSpace: kit.ColorSpace.SRGB }, data, width * 4);
      if (!made) throw new DOMException("The ImageData could not be read.", "InvalidStateError");
      return { image: made, owned: true, width, height, originClean: true };
    }
    if (isBlob(image)) {
      const bytes = new Uint8Array(await image.arrayBuffer());
      let decoded = null;
      try {
        decoded = /^image\/svg\+xml(?:;|$)/i.test(image.type || "") || /^\s*(?:<\?xml[\s\S]*?\?>\s*)?<svg[\s>]/i.test(new TextDecoder().decode(bytes.subarray(0, 512)))
          ? decodeSvgImage(kit, bytes, "about:blank")
          : await decodeRasterImage(kit, bytes);
      } catch {}
      if (!decoded?.image) throw new DOMException("The source image could not be decoded.", "InvalidStateError");
      return { image: decoded.image, owned: true, width: decoded.width, height: decoded.height, originClean: true };
    }
    const node = nodeOf(image);
    const tag = node?.tagName?.toUpperCase?.();
    if (!["IMG", "IMAGE", "CANVAS", "VIDEO"].includes(tag)) throw TypeError("The provided value is not of type '(Blob or HTMLCanvasElement or HTMLImageElement or HTMLVideoElement or ImageBitmap or ImageData or OffscreenCanvas or SVGImageElement or VideoFrame)'.");
    const resource = canvasImage(node);
    if (!resource?.image) throw new DOMException("The image source is not fully decoded.", "InvalidStateError");
    const width = resource.image.width(), height = resource.image.height();
    if (!width || !height) throw new DOMException("The image source has no width or height.", "InvalidStateError");
    return { image: resource.image, owned: false, width, height, originClean: resource.originClean !== false };
  }

  // createImageBitmap(image[, options]) or createImageBitmap(image, sx, sy, sw, sh[, options]).
  function createImageBitmap(image, ...rest) {
    return (async () => {
      if (image === undefined) throw TypeError("Failed to execute 'createImageBitmap': 1 argument required, but only 0 present.");
      let crop = null, options = rest[0];
      if (rest.length >= 4) {
        const [sx, sy, sw, sh] = rest.slice(0, 4).map(toLong);
        if (!sw) throw RangeError("The crop rect width is 0.");
        if (!sh) throw RangeError("The crop rect height is 0.");
        // A negative width or height counts back from the given corner.
        crop = { x: sw < 0 ? sx + sw : sx, y: sh < 0 ? sy + sh : sy, width: Math.abs(sw), height: Math.abs(sh) };
        options = rest[4];
      } else if (rest.length > 1) {
        throw TypeError("Failed to execute 'createImageBitmap': Valid arities are: [1, 2, 5, 6]");
      }
      if (options !== undefined && options !== null && typeof options !== "object" && typeof options !== "function")
        throw TypeError("Failed to execute 'createImageBitmap': The provided value is not of type 'ImageBitmapOptions'.");
      const resizeWidth = options?.resizeWidth === undefined ? undefined : enforceUnsignedLong(options.resizeWidth, "resizeWidth");
      const resizeHeight = options?.resizeHeight === undefined ? undefined : enforceUnsignedLong(options.resizeHeight, "resizeHeight");
      if (resizeWidth === 0 || resizeHeight === 0)
        throw new DOMException("The resize width or height is 0.", "InvalidStateError");
      const quality = options?.resizeQuality === undefined ? "low" : enumValue(options.resizeQuality, RESIZE_QUALITIES, "ResizeQuality");
      const orientation = options?.imageOrientation === undefined ? "from-image" : enumValue(options.imageOrientation, ORIENTATIONS, "ImageOrientation");
      if (options?.premultiplyAlpha !== undefined) enumValue(options.premultiplyAlpha, PREMULTIPLY, "PremultiplyAlpha");
      if (options?.colorSpaceConversion !== undefined) enumValue(options.colorSpaceConversion, COLOR_SPACE_CONVERSIONS, "ColorSpaceConversion");
      const kit = canvasKit();
      if (!kit) throw new DOMException("Images cannot be created in this document.", "InvalidStateError");
      const source = await sourceImage(kit, image);
      try {
        const rect = crop ?? { x: 0, y: 0, width: source.width, height: source.height };
        // One missing resize dimension keeps the rectangle's aspect ratio.
        const width = resizeWidth ?? (resizeHeight ? Math.ceil(rect.width * resizeHeight / rect.height) : rect.width);
        const height = resizeHeight ?? (resizeWidth ? Math.ceil(rect.height * resizeWidth / rect.width) : rect.height);
        const snapshot = render(kit, source.image, rect, width, height, quality, orientation === "flipY");
        const self = Object.create(ImageBitmap.prototype);
        bitmapSlots.set(self, { image: snapshot, width, height, originClean: source.originClean });
        bitmapFinalizer.register(self, snapshot, self);
        return self;
      } finally {
        if (source.owned) source.image.delete();
      }
    })();
  }

  // The rectangle drawn onto a fresh, owned raster: areas outside the source stay transparent.
  function render(kit, image, rect, width, height, quality, flipY) {
    const surface = kit.MakeSurface(width, height);
    if (!surface) throw new DOMException("The ImageBitmap is too large.", "InvalidStateError");
    const paint = new kit.Paint();
    try {
      const canvas = surface.getCanvas();
      canvas.clear(kit.TRANSPARENT);
      if (flipY) {
        canvas.translate(0, height);
        canvas.scale(1, -1);
      }
      const src = kit.XYWHRect(rect.x, rect.y, rect.width, rect.height), dst = kit.XYWHRect(0, 0, width, height);
      if (quality === "medium" || quality === "high") canvas.drawImageRectCubic(image, src, dst, 1 / 3, 1 / 3, paint);
      else canvas.drawImageRectOptions(image, src, dst, quality === "pixelated" ? kit.FilterMode.Nearest : kit.FilterMode.Linear, kit.MipmapMode.None, paint);
      surface.flush?.();
      const snapshot = surface.makeImageSnapshot();
      if (!snapshot) throw new DOMException("The ImageBitmap could not be created.", "InvalidStateError");
      return snapshot;
    } finally {
      paint.delete();
      surface.delete();
    }
  }

  return { ImageData, ImageBitmap, createImageBitmap, bitmapResource, makeImageData };
}
