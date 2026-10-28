import {visibleItems} from "../paint/display-list.js";

/** The compositor's rounded device rect and the stricter geometry needed for replay. */
export function videoLayerGeometry(item, region, scale) {
  const source = item.rect, transformed = {...source};
  const transform = item.transform;
  if (transform) {
    transformed.x = transformed.x * transform.a + transform.e;
    transformed.y = transformed.y * transform.d + transform.f;
    transformed.width *= transform.a;
    transformed.height *= transform.d;
  }
  const rect = {
    x:Math.round((transformed.x-region.x)*scale), y:Math.round((transformed.y-region.y)*scale),
    width:Math.round(transformed.width*scale), height:Math.round(transformed.height*scale),
  };
  // Keep the existing layer rect for fallback painting. Black replay also
  // needs finite painter intermediates: equivalent arithmetic can overflow
  // in different orders, so check the final compositor coordinates directly.
  const {a=1,b=0,c=0,d=1,e=0,f=0} = transform ?? {};
  const x = Math.round((source?.x-region.x)*scale), y = Math.round((source?.y-region.y)*scale);
  const width = Math.round(source?.width*scale), height = Math.round(source?.height*scale);
  const tx = ((a-1)*region.x+e)*scale, ty = ((d-1)*region.y+f)*scale;
  const replayable = !item.fixed && a>0 && d>0 && !b && !c && scale>0 && source?.width>0 && source?.height>0
    && width>0 && height>0 && rect.width>0 && rect.height>0
    && [source?.x,source?.y,source?.width,source?.height,a,b,c,d,e,f,scale,x,y,width,height,tx,ty,
      x*a+tx,y*d+ty,(x+width)*a+tx,(y+height)*d+ty,rect.x,rect.y,rect.width,rect.height].every(Number.isFinite);
  return {rect,replayable};
}

/** Device-space coverage of the scale/translate video draw used by the painter. */
export function videoMaskBounds(item, region, scale, width, height) {
  const rect = item?.rect, transform = item?.transform;
  if (!rect || item.fixed || ![scale, rect.x, rect.y, rect.width, rect.height, region.x, region.y].every(Number.isFinite) || scale <= 0
    || rect.width <= 0 || rect.height <= 0) return null;
  const {a = 1, d = 1, e = 0, f = 0, b = 0, c = 0} = transform ?? {};
  if (![a,d,e,f,b,c].every(Number.isFinite) || a <= 0 || d <= 0 || b || c) return null;
  // Match deviceRect's separate rounding of origin and extent, then canvas.concat.
  const x = Math.round((rect.x - region.x) * scale) * a + ((a - 1) * region.x + e) * scale;
  const y = Math.round((rect.y - region.y) * scale) * d + ((d - 1) * region.y + f) * scale;
  const right = x + Math.round(rect.width * scale) * a;
  const bottom = y + Math.round(rect.height * scale) * d;
  const left = Math.max(0, Math.min(width, Math.floor(x) - 1));
  const top = Math.max(0, Math.min(height, Math.floor(y) - 1));
  return {x:left, y:top, width:Math.max(0,Math.min(width,Math.ceil(right)+1)-left),
    height:Math.max(0,Math.min(height,Math.ceil(bottom)+1)-top)};
}

/**
 * Black/white passes need only replay the video's coverage. The ordinary
 * raster is immutable and already supplies every unaffected background pixel.
 * Unknown or full-tile bounds retain the original full-tile path. This leaves
 * the scratch surface changed, like the original black/white passes; callers
 * must not reuse it as an ordinary raster (canvasDamage excludes videos).
 */
export function rasterVideoMask({kit, canvas, surface, width, height, pixels, bounds, region, scale,
  background, paint, hints, cullPadding = 2, blackAlreadyRasterized = false}) {
  const cropped = bounds && pixels?.length === width * height * 4
    && (bounds.x !== 0 || bounds.y !== 0 || bounds.width !== width || bounds.height !== height);
  const area = cropped ? bounds : {x:0,y:0,width,height};
  const base = cropped ? new Uint8Array(pixels) : null;
  const mask = cropped ? new Uint8Array(width * height * 4) : null;
  if (!area.width || !area.height) return {base, mask};
  const dirtyView = cropped && Number.isFinite(cullPadding) ? {
    x:region.x+(area.x-cullPadding)/scale, y:region.y+(area.y-cullPadding)/scale,
    width:(area.width+cullPadding*2)/scale, height:(area.height+cullPadding*2)/scale,
  } : region;
  function raster(white) {
    canvas.save();
    try {
      // Keep the canvas clip identical to the ordinary paint. Adding even an
      // enclosing integer clip can change Skia's rounded-clip AA edge coverage.
      // Cull replay items and crop readback instead; clear remains a cheap fill.
      canvas.clear(background);
      paint(white, dirtyView);
      hints?.();
    } finally { canvas.restore(); }
    surface.flush();
    const image = surface.makeImageSnapshot();
    try {
      const data = image.readPixels(area.x,area.y,{width:area.width,height:area.height,
        colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB});
      if (!data) throw new Error('Unable to read video mask pixels');
      return data;
    } finally { image.delete(); }
  }
  let black;
  if (blackAlreadyRasterized && pixels?.length === width * height * 4) {
    black = new Uint8Array(area.width * area.height * 4);
    for (let row = 0; row < area.height; row++) {
      const start = ((area.y + row) * width + area.x) * 4;
      black.set(pixels.subarray(start,start + area.width * 4),row * area.width * 4);
    }
  } else black = raster(false);
  const white = raster(true);
  if (!cropped) {
    for(let i=0;i<white.length;i++) white[i]=Math.max(0,white[i]-black[i]);
    return {base:black,mask:white};
  }
  const stride = area.width * 4;
  for(let row=0;row<area.height;row++) {
    const source=row*stride, target=((area.y+row)*width+area.x)*4;
    base.set(black.subarray(source,source+stride),target);
    for(let i=0;i<stride;i++) mask[target+i]=Math.max(0,white[source+i]-black[source+i]);
  }
  return {base,mask};
}

/** Preserve shadow tails beyond nominal display-list bounds during partial replay. */
export function videoMaskItems(displayList, view, dirtyView, viewport) {
  const nearby = new Set(visibleItems(displayList, dirtyView, viewport));
  // Keep the full pass's ordering and membership. Gaussian shadows can reach
  // farther than their CSS blur-radius bounds, so do not cull those again.
  return visibleItems(displayList, view, viewport).filter(item => item.op === "drawShadow" || nearby.has(item));
}
