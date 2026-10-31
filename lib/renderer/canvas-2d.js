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

import { makeRasterSurface } from "./raster-surface.js";

import { createSoftwareGL } from "./webgl/context.js";

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
// Native pattern shaders are requested synchronously by the drawing context.
// A pattern may be shared across contexts: sampling belongs to the consumer.
let patternSampling = { imageSmoothingEnabled: true, imageSmoothingQuality: "low" };
const nativeStyles = new WeakMap();
const publicStyles = new WeakMap();
const patternImages = new WeakMap();
const collectedStyles = new FinalizationRegistry(native => native.ie());

// CanvasKit's gradient/pattern shims expose shader handles and disposal
// methods. Only the standard author-facing methods may cross into a page.
function publicStyle(native, patternResource = null) {
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
  if (patternResource) collectedStyles.register(wrapper, patternResource, patternResource);
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
  for(const pattern of state.patterns??[])pattern.ie();
  state.patterns?.clear();
  state.gl?.dispose();
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
  if (!["2d", "webgl", "experimental-webgl"].includes(type) || !CanvasKit) return null;
  const kind=type==='2d'?'2d':'webgl';
  let entry = surfaces.get(node);
  if (!entry) {
    entry = open(node);
    if (!entry) return null;
    entry.kind=kind;
    if(kind==='webgl'){
      const gl=createSoftwareGL(CanvasKit,entry.state,changed,options);
      entry.gl=gl;
      entry.state.gl={dispose:gl.dispose,reset:gl.reset,flush:gl.flush};
      collectedContexts.unregister(entry.state);
      collectedContexts.register(gl.proxy,entry.state,entry.state);
    }
    surfaces.set(node, entry);
  }
  if(entry.kind!==kind)return null;
  if (options) {if(entry.gl)entry.gl.configure(options);else entry.configure(options);}
  return entry.gl?.proxy ?? entry.proxy;
}

/** Setting width or height clears the bitmap and the drawing state. */
export function resetCanvas(node) {
  const entry=surfaces.get(node);entry?.reopen();entry?.state.gl?.reset();
}

/** A refcounted native snapshot: no PNG/base64/readPixels round trip. */
export function canvasResource(node) {
  const state = surfaces.get(node)?.state;
  if (!state?.surface || !state.raster) return null;
  state.gl?.flush();
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
  const textDefaults = () => ({ imageSmoothingEnabled: true, imageSmoothingQuality: "low", font: "10px sans-serif", parsedFont: { fontSize: 10, fontFamily: ["sans-serif"], fontWeight: 400, fontStyle: "normal", fontStretch: 100 },
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
      if (Object.hasOwn(settings, property) && property !== "parsedFont") return settings[property];
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
            const previousSampling=patternSampling;
            let result;
            patternSampling=settings;
            try { result = text({ operation: property, args, context, canvas: state.raster.getCanvas(), settings,
              paintStyle: nativeStyles.get(styleValues[property === "strokeText" ? "strokeStyle" : "fillStyle"]),
            }); } finally { patternSampling=previousSampling; }
            if (property !== "measureText") changed(state);
            return result;
          }
          if (property === "getImageData" && !state.originClean) {
            throw new DOMException("The canvas contains cross-origin image data.", "SecurityError");
          }
          let source;
          if(property === 'createPattern') {
            const repetition=args[1]===undefined||args[1]===null||args[1]===''?'repeat':String(args[1]);
            if(!['repeat','repeat-x','repeat-y','no-repeat'].includes(repetition))throw new DOMException('Invalid repetition','SyntaxError');
            const resource=resolveImage?resolveImage(args[0]):canvasResource(args[0]);
            if(!resource?.image){
              if(!['IMG','CANVAS','VIDEO','IMAGE'].includes(args[0]?.tagName))throw new TypeError('CanvasImageSource required');
              return null;
            }
            // Retain a native snapshot handle, not a page object or a borrowed
            // image that a source-canvas draw/reset can delete underneath us.
            const image=resource.image.clone();let native;
            try{native=context.createPattern(image,repetition);}catch(error){image.delete();throw error;}
            // The upstream shim always uses bicubic filtering, even when an
            // author disables smoothing. Apart from the wrong pixel-art output,
            // that is very expensive for a repeated full-canvas background.
            // Canvas save retains the same mutable pattern, as the DOM does.
            // The upstream copy constructor also drops its image/transform.
            // Avoid appending the same handle to the shim cleanup list on every save.
            native.oe=undefined;
            native.pe=function(){
              this.ie();
              const sampling=patternSampling;
              return this.Td=sampling.imageSmoothingEnabled && sampling.imageSmoothingQuality==='high'
                ? image.makeShaderCubic(this.ve,this.we,1/3,1/3,this._transform)
                : image.makeShaderOptions(this.ve,this.we,
                  sampling.imageSmoothingEnabled?CanvasKit.FilterMode.Linear:CanvasKit.FilterMode.Nearest,
                  CanvasKit.MipmapMode.None,this._transform);
            };
            patternImages.set(native,{image,repetition});
            const owned=state.patterns??=new Set();
            const pattern={ie(){if(!owned.delete(pattern))return;native.ie();image.delete();}};
            owned.add(pattern);
            if(resource.originClean===false)state.originClean=false;
            return publicStyle(native,pattern);
          }
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
          const previousSampling=patternSampling;
          let result;
          patternSampling=settings;
          try {
            if (property === "fillRect" && fillPatternTiles(state,context,settings,nativeStyles.get(styleValues.fillStyle),args)) {
              // Integer, unsmoothed tiles can use Skia's image blit pipeline.
            } else if (property === "drawImage" && [3,5,9].includes(args.length)) {
              const image=args[0],paint=context.Ke();
              const src=args.length===9?CanvasKit.XYWHRect(...args.slice(1,5)):CanvasKit.XYWHRect(0,0,image.width(),image.height());
              const dst=args.length===9?CanvasKit.XYWHRect(...args.slice(5,9))
                :CanvasKit.XYWHRect(args[1],args[2],args[3]??image.width(),args[4]??image.height());
              try {
                const canvas=state.raster.getCanvas();
                if(settings.imageSmoothingEnabled && settings.imageSmoothingQuality==='high')
                  canvas.drawImageRectCubic(image,src,dst,1/3,1/3,paint);
                else canvas.drawImageRectOptions(image,src,dst,
                  settings.imageSmoothingEnabled?CanvasKit.FilterMode.Linear:CanvasKit.FilterMode.Nearest,
                  CanvasKit.MipmapMode.None,paint);
              } finally { paint.dispose(); }
            } else result = context[property](...args);
          } finally { patternSampling=previousSampling; }
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
      if (property === "imageSmoothingEnabled") { settings[property]=Boolean(value); return true; }
      if (property === "imageSmoothingQuality") {
        if (["low","medium","high"].includes(String(value))) settings[property]=String(value);
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

// Avoid the generic repeated-image shader for a few pixel-aligned tiles.
// Restrict this to source-over and nearest sampling: rotated, filtered, shadowed
// and densely repeated fills keep the complete native shader implementation.
function fillPatternTiles(state,context,settings,style,args) {
  const resource=patternImages.get(style);
  if(!resource || settings.imageSmoothingEnabled || context.globalCompositeOperation!=='source-over'
    || CanvasKit.parseColorString(context.shadowColor)[3]!==0 || args.length!==4
    || !args.every(Number.isSafeInteger))return false;
  const matrix=state.raster.getCanvas().getTotalMatrix(),m=style._transform;
  if(matrix[0]!==1||matrix[4]!==1||matrix[1]!==0||matrix[3]!==0
    ||matrix[6]!==0||matrix[7]!==0||matrix[8]!==1
    ||!Number.isSafeInteger(matrix[2])||!Number.isSafeInteger(matrix[5])
    ||m[0]!==1||m[4]!==1||m[1]!==0||m[3]!==0
    ||!Number.isSafeInteger(m[2])||!Number.isSafeInteger(m[5]))return false;
  let [x,y,w,h]=args;if(w<0){x+=w;w=-w;}if(h<0){y+=h;h=-h;}
  if(!w||!h)return true;
  // The canvas itself already clips this fill. Bound iteration by its visible
  // rectangle, even when authors fill an enormous offscreen area.
  const left=Math.max(x,-matrix[2]),top=Math.max(y,-matrix[5]);
  const right=Math.min(x+w,state.width-matrix[2]),bottom=Math.min(y+h,state.height-matrix[5]);
  if(right<=left||bottom<=top)return true;
  const {image,repetition}=resource,iw=image.width(),ih=image.height();
  let x0=Math.floor((left-m[2])/iw),x1=Math.ceil((right-m[2])/iw);
  let y0=Math.floor((top-m[5])/ih),y1=Math.ceil((bottom-m[5])/ih);
  if(repetition==='repeat-y'||repetition==='no-repeat'){x0=Math.max(0,x0);x1=Math.min(1,x1);}
  if(repetition==='repeat-x'||repetition==='no-repeat'){y0=Math.max(0,y0);y1=Math.min(1,y1);}
  if((x1-x0)*(y1-y0)>16)return false;
  const canvas=state.raster.getCanvas(),paint=context.Ke();
  paint.setShader(null);canvas.save();
  try {
    canvas.clipRect(CanvasKit.XYWHRect(left,top,right-left,bottom-top),CanvasKit.ClipOp.Intersect,false);
    const source=CanvasKit.XYWHRect(0,0,iw,ih);
    for(let ty=y0;ty<y1;ty++)for(let tx=x0;tx<x1;tx++)
      canvas.drawImageRectOptions(image,source,CanvasKit.XYWHRect(m[2]+tx*iw,m[5]+ty*ih,iw,ih),
        CanvasKit.FilterMode.Nearest,CanvasKit.MipmapMode.None,paint);
  } finally {canvas.restore();paint.dispose();}
  return true;
}

function makeSurface(node) {
  const kit=CanvasKit;
  const [width, height] = bitmapSize(node);
  // Skia's fast raster pipelines use premultiplied pixels. The CanvasKit
  // HTML shim allocates an unpremultiplied surface, forcing conversion while
  // blending every image/pattern. Only exports need unpremultiplied RGBA.
  // MakeCanvas constructs its private context synchronously through MakeSurface.
  const factory=kit.MakeSurface;
  let allocated=null;
  kit.MakeSurface=(w,h)=>(allocated=makeRasterSurface(kit,w,h));
  try { return kit.MakeCanvas(width,height); }
  catch(error){allocated?.dispose();throw error;}
  finally { kit.MakeSurface=factory; }
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
