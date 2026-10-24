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

// qml handle begin: consume local-QML DOM snapshots without exposing native images
import { drawQmlDomImage } from "../qml/canvas-dom.js";
// qml handle end

let CanvasKit = null;

/** The CanvasKit `loadGraphics` instantiated. Page canvases share it. */
export function setCanvasKit(kit) {
  CanvasKit = kit;
}

const surfaces = new WeakMap();
// A WeakMap does not release the malloc-backed CanvasKit surface. Track
// resources without retaining DOM nodes or context proxies, so either page
// teardown or collection of an unused canvas can release them.
const documentSurfaces = new WeakMap();
const documentChanges = new WeakMap();
const collectedContexts = new FinalizationRegistry(releaseSurface);
const DRAW_METHODS = new Set(["clearRect", "drawImage", "fill", "fillRect", "fillText", "stroke", "strokeRect", "strokeText", "putImageData"]);
const CONTEXT_METHODS = new Set(("arc arcTo beginPath bezierCurveTo clearRect clip closePath createImageData createLinearGradient createPattern createRadialGradient drawFocusIfNeeded drawImage ellipse fill fillRect fillText getImageData getLineDash getTransform isPointInPath isPointInStroke lineTo measureText moveTo putImageData quadraticCurveTo rect reset resetTransform restore rotate roundRect save scale setLineDash setTransform stroke strokeRect strokeText transform translate").split(" "));
const CONTEXT_PROPERTIES = new Set(("canvas direction fillStyle filter font fontKerning fontStretch fontVariantCaps globalAlpha globalCompositeOperation imageSmoothingEnabled imageSmoothingQuality letterSpacing lineCap lineDashOffset lineJoin lineWidth miterLimit shadowBlur shadowColor shadowOffsetX shadowOffsetY strokeStyle textAlign textBaseline textRendering wordSpacing").split(" "));
const nativeStyles = new WeakMap();
const publicStyles = new WeakMap();
const collectedStyles = new FinalizationRegistry(native => native.ie());

// CanvasKit's gradient/pattern shims expose shader handles and disposal
// methods. Only the standard author-facing methods may cross into a page.
function publicStyle(native) {
  if (native === null || typeof native !== "object") return native;
  let wrapper = publicStyles.get(native)?.deref();
  if (wrapper) return wrapper;
  const gradient = typeof native.addColorStop === "function";
  const method = gradient ? "addColorStop" : "setTransform";
  wrapper = Object.create(null);
  Object.defineProperties(wrapper, {
    [method]: { value(...args) {
      // WebIDL converts these before entering the native implementation.
      // The shim otherwise stores the original offset object in its stops,
      // which could retain the facade/DOM through finalizer holdings.
      if (gradient) native.addColorStop(Number(args[0]), String(args[1]));
      else native.setTransform(...args);
    }, writable: true, configurable: true, enumerable: true },
    [Symbol.toStringTag]: { value: gradient ? "CanvasGradient" : "CanvasPattern", configurable: true },
  });
  // A gradient reused after its creator's bitmap reset can own a later
  // shader outside that old context's cleanup list. Its facade owns that
  // last shader; use a weak reverse link so finalizer holdings cannot retain
  // the facade through this map. Context style/save state keeps it alive.
  publicStyles.set(native, new WeakRef(wrapper));
  nativeStyles.set(wrapper, native);
  // The current pattern shim may retain its page-supplied image object;
  // do not root that DOM graph in finalizer holdings. Gradients retain only
  // numeric coordinates/colors and their private native shader.
  if (gradient) {
    collectedStyles.unregister(native);
    collectedStyles.register(wrapper, native, native);
  }
  return wrapper;
}

/** Drawing changes paint, without requiring a DOM mutation or full layout. */
export function observeDocumentCanvases(document, changed) {
  documentChanges.set(document, changed);
}

function changed(state) {
  state.image?.delete();
  state.image = null;
  state.resource = null;
  const node = state.node.deref();
  if (node) documentChanges.get(node.ownerDocument)?.(node);
}

function releaseSurface(state) {
  if (!state.surface) return;
  state.image?.delete();
  state.image = state.resource = null;
  state.surface.dispose();
  state.surface = null;
  state.raster = null;
  state.context = null;
  state.owner?.delete(state);
  collectedContexts.unregister(state);
}

/** Release connected and detached canvases belonging to a discarded document. */
export function disposeDocumentCanvases(document) {
  documentChanges.delete(document);
  const owned = documentSurfaces.get(document);
  if (!owned) return;
  for (const state of owned) releaseSurface(state);
  documentSurfaces.delete(document);
}

/** The element's 2d context, or null for any other context id or before CanvasKit loads. */
export function canvasContext(node, type, options = null) {
  if (type !== "2d" || !CanvasKit) return null;
  let entry = surfaces.get(node);
  if (!entry) {
    entry = open(node);
    if (!entry) return null;
    surfaces.set(node, entry);
  }
  if (options) entry.configure(options);
  return entry.proxy;
}

/** Setting width or height clears the bitmap and the drawing state. */
export function resetCanvas(node) {
  surfaces.get(node)?.reopen();
}

/** A refcounted native snapshot: no PNG/base64/readPixels round trip. */
export function canvasResource(node) {
  const state = surfaces.get(node)?.state;
  if (!state?.surface || !state.raster) return null;
  if (!state.resource) {
    state.raster.flush();
    state.image = state.raster.makeImageSnapshot();
    if (!state.image) return null;
    state.resource = { image: state.image, width: state.width, height: state.height, originClean: state.originClean };
  }
  return state.resource;
}

/** Encoded bytes are only needed when the page explicitly exports its canvas. */
export function encodeCanvas(node, requestedType = "image/png", quality) {
  if (!node.width || !node.height) return null;
  canvasContext(node, "2d");
  const state = surfaces.get(node).state;
  if (!state.originClean) throw new DOMException("The canvas contains cross-origin image data.", "SecurityError");
  const type = String(requestedType).toLowerCase();
  const format = type === "image/jpeg" ? CanvasKit.ImageFormat.JPEG
    : type === "image/webp" ? CanvasKit.ImageFormat.WEBP : CanvasKit.ImageFormat.PNG;
  let supportedType = format === CanvasKit.ImageFormat.JPEG ? "image/jpeg"
    : format === CanvasKit.ImageFormat.WEBP ? "image/webp" : "image/png";
  const image = canvasResource(node)?.image;
  const level = typeof quality === "number" && quality >= 0 && quality <= 1 ? Math.round(quality * 100) : 92;
  let bytes = image?.encodeToBytes(format ?? CanvasKit.ImageFormat.PNG, level);
  // CanvasKit builds may omit optional encoders. HTML requires the PNG
  // fallback for unsupported types rather than a mislabeled or empty result.
  if (!bytes && format !== CanvasKit.ImageFormat.PNG) {
    bytes = image?.encodeToBytes(CanvasKit.ImageFormat.PNG, level);
    supportedType = "image/png";
  }
  return bytes ? { bytes, type: supportedType } : null;
}

// A zero bitmap makes MakeSurface fail and getImageData reject the rectangle.
// The element can still report 0; drawing uses one pixel until it grows.
function bitmapSize(node) {
  return [Math.max(1, node.width >>> 0), Math.max(1, node.height >>> 0)];
}

function open(node) {
  const surface = makeSurface(node);
  if (!surface) return null;
  let owner = null;
  if (node.ownerDocument) {
    owner = documentSurfaces.get(node.ownerDocument);
    if (!owner) documentSurfaces.set(node.ownerDocument, owner = new Set());
  }
  const [width, height] = bitmapSize(node);
  const state = { surface, raster: nativeSurface(surface), context: surface.getContext("2d"), owner,
    node: new WeakRef(node), width, height, image: null, resource: null, originClean: true };
  owner?.add(state);
  const methods = new Map();
  let publicCanvas = null, resolveImage = null, parseFont = null, text = null;
  const textDefaults = () => ({ font: "10px sans-serif", parsedFont: { fontSize: 10, fontFamily: ["sans-serif"], fontWeight: 400, fontStyle: "normal", fontStretch: 100 },
    textAlign: "start", textBaseline: "alphabetic", direction: "inherit" });
  let settings = textDefaults();
  const settingsStack = [];
  let styleValues = { fillStyle: null, strokeStyle: null };
  const styleStack = [];
  const currentContext = () => {
    if (!state.context) throw new DOMException("The canvas document has been discarded.", "InvalidStateError");
    return state.context;
  };
  const proxy = new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === "canvas") return publicCanvas;
      if (!CONTEXT_METHODS.has(property) && !CONTEXT_PROPERTIES.has(property)) return undefined;
      const context = currentContext();
      if (text && Object.hasOwn(settings, property) && property !== "parsedFont") return settings[property];
      // The shim's strokeStyle getter assumes every value is a color, even
      // after accepting a gradient. Keep the page's branded style identity.
      if ((property === "fillStyle" || property === "strokeStyle") && styleValues[property]) return styleValues[property];
      const value = context[property];
      if (property === "fillStyle" || property === "strokeStyle") return publicStyle(value);
      const custom = property === "getTransform";
      if (typeof value !== "function" && !custom) return value;
      let method = methods.get(property);
      if (!method) {
        // A saved method follows width/height resets too. Binding the proxy
        // keeps its resource alive while a caller retains only the method.
        method = function (...args) {
          const context = currentContext();
          if (property === "getTransform") {
            const matrix = state.raster.getCanvas().getTotalMatrix();
            return { a: matrix[0], b: matrix[3], c: matrix[1], d: matrix[4], e: matrix[2], f: matrix[5], is2D: true };
          }
          if (text && ["fillText", "strokeText", "measureText"].includes(property)) {
            const result = text({ operation: property, args, context, canvas: state.raster.getCanvas(), settings,
              paintStyle: nativeStyles.get(styleValues[property === "strokeText" ? "strokeStyle" : "fillStyle"]),
            });
            if (property !== "measureText") changed(state);
            return result;
          }
          if (property === "getImageData" && !state.originClean) {
            throw new DOMException("The canvas contains cross-origin image data.", "SecurityError");
          }
          let source;
          if (property === "drawImage" && resolveImage) {
            source = resolveImage(args[0]);
            if (!source?.image) return;

            // qml handle begin: temporary DOM images have synchronous ownership
            if (drawQmlDomImage(source, state.node.deref(), context, args)) {
              if (source.originClean === false) state.originClean = false;
              changed(state);
              return;
            }
            // qml handle end

            args[0] = source.image;
          }
          const result = context[property](...args);
          if (property === "save") {
            settingsStack.push({ ...settings });
            styleStack.push({ ...styleValues });
          } else if (property === "restore" && settingsStack.length) {
            settings = settingsStack.pop();
            styleValues = styleStack.pop();
            // Native save() copies style shims. The DOM retains the actual
            // gradient/pattern object, including later color-stop changes.
            for (const name of ["fillStyle", "strokeStyle"]) if (styleValues[name]) context[name] = nativeStyles.get(styleValues[name]);
          }
          if (source?.originClean === false) state.originClean = false;
          if (DRAW_METHODS.has(property)) changed(state);
          if (property === "createLinearGradient" || property === "createRadialGradient" || property === "createPattern") return publicStyle(result);
          return property === "getImageData" ? copyImageData(result) : result;
        }.bind(proxy);
        methods.set(property, method);
      }
      return method;
    },
    set(_target, property, value) {
      if (!CONTEXT_PROPERTIES.has(property) || property === "canvas") return false;
      if (property === "fillStyle" || property === "strokeStyle") {
        const native = value !== null && typeof value === "object" ? nativeStyles.get(value) : undefined;
        // Do not pass arbitrary page objects to the shim's private pe()
        // shader protocol. Only strings or our branded wrappers are styles.
        if (native || typeof value === "string") {
          currentContext()[property] = native ?? value;
          styleValues[property] = native ? value : null;
        }
        return true;
      }
      if (text && property === "font") {
        const parsed = parseFont?.(String(value));
        if (parsed) { settings.font = String(value); settings.parsedFont = parsed; }
        return true;
      }
      if (text && Object.hasOwn(settings, property)) {
        const values = { textAlign: ["start", "end", "left", "right", "center"], textBaseline: ["top", "hanging", "middle", "alphabetic", "ideographic", "bottom"], direction: ["inherit", "ltr", "rtl"] };
        if (values[property]?.includes(String(value))) settings[property] = String(value);
        return true;
      }
      currentContext()[property] = value;
      return true;
    },
    has(_target, property) {
      return property === "canvas" || property === "getTransform" || (CONTEXT_METHODS.has(property) || CONTEXT_PROPERTIES.has(property)) && (property in currentContext() || text && Object.hasOwn(settings, property));
    },
  });
  collectedContexts.register(proxy, state, state);
  return {
    state,
    proxy,
    configure(options) {
      publicCanvas = options.canvas;
      resolveImage = options.resolveImage;
      parseFont = options.parseFont;
      text = options.text;
    },
    reopen() {
      if (!state.surface) return;
      const next = makeSurface(node);
      if (!next) return;
      const previous = state.surface;
      state.surface = next;
      state.raster = nativeSurface(next);
      state.context = next.getContext("2d");
      state.originClean = true;
      settings = textDefaults();
      settingsStack.length = 0;
      styleValues = { fillStyle: null, strokeStyle: null };
      styleStack.length = 0;
      [state.width, state.height] = bitmapSize(node);
      changed(state);
      previous.dispose();
    },
  };
}

function makeSurface(node) {
  const [width, height] = bitmapSize(node);
  return CanvasKit.MakeCanvas(width, height);
}

function nativeSurface(canvas) {
  // The bundled CanvasKit canvas shim owns its SkSurface in an enumerable
  // field, renamed by minification. Use its native API instead of depending
  // on that generated field name or encoding/decoding a canvas data URL.
  return Object.values(canvas).find(value => value && typeof value.makeImageSnapshot === "function"
    && typeof value.getCanvas === "function") ?? null;
}

function copyImageData(image) {
  if (!image?.data) throw new DOMException("The source rectangle is empty.", "IndexSizeError");
  const count = image.width * image.height * 4;
  // Current CanvasKit returns a fresh, exact-sized copy from readPixels.
  // Keep that array; only copy when the backing buffer exposes other pixels
  // (or the WASM heap), as some CanvasKit versions do.
  let data = image.data;
  if (!(data instanceof Uint8ClampedArray) || data.byteOffset !== 0 || data.buffer.byteLength !== count || data.length !== count) {
    data = new Uint8ClampedArray(count);
    const source = new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, Math.min(count, image.data.length));
    data.set(source);
  }
  return { width: image.width, height: image.height, data, colorSpace: "srgb" };
}

// qml handle begin: software fragment effects draw into the existing canvas surface
export function paintQmlCanvas(node, draw) {
  if (!canvasContext(node, "2d")) throw Error('Canvas renderer is unavailable');
  const state = surfaces.get(node).state;
  if (!state.raster) throw Error('Canvas surface is unavailable');
  const canvas = state.raster.getCanvas();
  canvas.save();
  try {
    const inverse = CanvasKit.Matrix.invert(canvas.getTotalMatrix());
    if (!inverse) throw Error("Noninvertible QML canvas transform");
    canvas.concat(inverse); draw(canvas);
  }
  finally { canvas.restore(); changed(state); }
}
// qml handle end
