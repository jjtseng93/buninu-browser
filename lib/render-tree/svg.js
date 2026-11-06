import { viewportMatrix } from './svg-viewport.js';
/**
 * Inline SVG as a replaced element: the <svg> subtree is turned into a list
 * of shapes (SVG path data plus paint) in the viewBox coordinate system,
 * which the painter draws scaled into the element's box.
 *
 * Supported: path, rect, circle, ellipse, line, polyline, polygon, nested g
 * and svg; fill, stroke, stroke-width, fill-rule, opacity, fill-opacity,
 * stroke-opacity and transform (matrix, translate, scale, rotate) from
 * attributes and CSS. Local use references, gradients and clip paths share the
 * CPU painter with SVG images. Text, patterns, masks and filters remain unsupported.
 */

const SHAPES = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
const SKIPPED = new Set(["defs", "clippath", "mask", "pattern", "symbol", "lineargradient", "radialgradient", "filter", "title", "desc", "metadata", "style", "script"]);
const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

/**
 * @param {Element} element the <svg> element
 * @param {string} currentColor the element's computed color (rgba)
 * @returns {{ viewBox: number[] | null, width: number | null, height: number | null, shapes: object[] }}
 */
export function extractSvg(element, currentColor, styleEngine = null, options = {}) {
  // HTML-parsed markup may carry the attribute lowercased (viewbox).
  const viewBox = parseNumbers(element.getAttribute("viewBox") ?? element.getAttribute("viewbox"));
  const shapes = [];
  let visited = 0, layerId = 0;
  const active = new Set();
  const local = value => {
    const match = /^url\(\s*["']?#([^\s)"']+)["']?\s*\)(?:\s+(.*))?$/i.exec(String(value));
    return match ? {node: element.ownerDocument.getElementById(match[1]), fallback: match[2]} : null;
  };
  const attr = (node, key) => node.getAttribute(key) ?? node.getAttribute(key.toLowerCase());
  function gradient(node, seen = new Set()) {
    if (!node || seen.has(node) || seen.size >= 32 || !['lineargradient','radialgradient'].includes(node.localName?.toLowerCase())) return null;
    seen.add(node);
    const href = attr(node,'href') ?? attr(node,'xlink:href');
    const parent = href?.startsWith('#') ? gradient(element.ownerDocument.getElementById(href.slice(1)), seen) : null;
    const result = {...parent, type: node.localName.toLowerCase()};
    for (const key of ['x1','y1','x2','y2','cx','cy','r','fx','fy']) if (attr(node,key)!=null) result[key]=attr(node,key);
    result.units=attr(node,'gradientUnits') ?? parent?.units ?? 'objectBoundingBox';
    result.spread=attr(node,'spreadMethod') ?? parent?.spread ?? 'pad';
    result.transform=attr(node,'gradientTransform') ? parseTransform(attr(node,'gradientTransform')) : parent?.transform ?? IDENTITY;
    let offset=0;
    const stops=[...node.children].filter(child=>child.localName?.toLowerCase()==='stop').map(child=>{
      const style=styleEngine?.get(child);
      const property=(key)=>new RegExp('(?:^|;)\\s*'+key+'\\s*:\\s*([^;]+)','i').exec(child.getAttribute('style')??'')?.[1]?.trim() ?? child.getAttribute(key);
      const position=child.getAttribute('offset')??'0';
      offset=Math.max(offset, Math.min(1,Math.max(0,parseFloat(position)/(position.endsWith('%')?100:1)||0)));
      const alpha=String(style?.stopOpacity ?? property('stop-opacity')??'1');
      return {offset,color:color(style?.stopColor ?? property('stop-color')??'black',style?.color??currentColor)??'black',opacity:Math.min(1,Math.max(0,parseFloat(alpha)/(alpha.endsWith('%')?100:1)||0))};
    });
    result.stops=stops.length ? stops : parent?.stops ?? [];
    return result;
  }
  function paintValue(value) {
    const reference=local(value);
    if(!reference)return /^url\(/i.test(String(value)) ? null : value;
    return gradient(reference.node) ?? color(reference.fallback??'none',currentColor);
  }
  function clipValue(node, matrix) {
    const value = /(?:^|;)\s*clip-path\s*:\s*([^;]+)/i.exec(node.getAttribute('style')??'')?.[1] ?? node.getAttribute('clip-path');
    const target=local(value)?.node;
    if(target?.localName?.toLowerCase()!=='clippath')return null;
    const paths=[];
    function collect(parent,m,depth=0){
      if(depth>32||paths.length>1000)return;
      for(const child of parent.children??[]){
        const next=multiply(m,parseTransform(child.getAttribute('transform')??''));
        const name=child.localName?.toLowerCase();
        if(name==='g')collect(child,next,depth+1);
        else if(SHAPES.has(name)){const d=shapePath(name,child);if(d)paths.push({d,matrix:next,rule:child.getAttribute('clip-rule')??target.getAttribute('clip-rule')});}
      }
    }
    collect(target,parseTransform(target.getAttribute('transform')??''));
    return {paths,matrix,object:attr(target,'clipPathUnits')==='objectBoundingBox'};
  }
  const root = {
    fill: "rgba(0, 0, 0, 1)",
    stroke: null,
    strokeWidth: 1,
    fillRule: "nonzero",
    fillOpacity: 1,
    strokeOpacity: 1,
    opacity: 1,
    matrix: IDENTITY,
    clips: [], layers: [],
    viewport: viewBox.length === 4 ? viewBox.slice(2) : [length(element.getAttribute("width")) ?? 300, length(element.getAttribute("height")) ?? 150],
  };
  const rootPaint=inherit(root, element, currentColor, !options.image, styleEngine?.get(element));
  if(rootPaint.opacity!==1)rootPaint.layers=[{id:++layerId,opacity:rootPaint.opacity}];
  const rootClip=clipValue(element, IDENTITY);
  if(rootClip)rootPaint.clips=[rootClip];
  walk(element, rootPaint);

  function walk(node, paint, depth = 0, instance = false) {
    if (depth > 128) return;
    for (const child of node.children ?? []) {
      if (++visited > 10000) return;
      const name = child.localName?.toLowerCase();
      const style = instance ? null : styleEngine?.get(child);
      if (!name || SKIPPED.has(name) || (style?.display ?? child.getAttribute("display")) === "none"
        || !styleEngine && child.getAttribute("visibility") === "hidden") continue;
      const childPaint = inherit(paint, child, style?.color ?? currentColor, false, style);
      const ownOpacity=paint.opacity>0?childPaint.opacity/paint.opacity:1;
      if(ownOpacity!==1)childPaint.layers=[...paint.layers,{id:++layerId,opacity:ownOpacity}];
      const clip = clipValue(child, childPaint.matrix);
      if (clip) childPaint.clips = [...paint.clips, clip];
      if (name === 'use') {
        const href=child.getAttribute('href')??child.getAttribute('xlink:href');
        const target=href?.startsWith('#')?element.ownerDocument.getElementById(href.slice(1)):null;
        if(target && !active.has(target)) {
          active.add(target);
          childPaint.matrix=multiply(childPaint.matrix,[1,0,0,1,length(child.getAttribute('x'))??0,length(child.getAttribute('y'))??0]);
          if(target.localName?.toLowerCase()==='symbol') {
            const box=parseNumbers(target.getAttribute('viewBox'));
            const w=length(child.getAttribute('width'))??box[2],h=length(child.getAttribute('height'))??box[3];
            if (!(w > 0 && h > 0)) {active.delete(target);continue;}
            childPaint.clips=[...childPaint.clips,{matrix:childPaint.matrix,paths:[{d:`M0 0H${w}V${h}H0Z`,matrix:IDENTITY}],object:false}];
            if(box.length===4&&box[2]>0&&box[3]>0) {
              childPaint.matrix=multiply(childPaint.matrix,viewportMatrix(box,w,h,target.getAttribute('preserveAspectRatio')??undefined));
              childPaint.viewport=box.slice(2);
            } else childPaint.viewport=[w,h];
            const symbolPaint=inherit(childPaint,target,currentColor,false,null);
            const symbolOpacity=childPaint.opacity>0?symbolPaint.opacity/childPaint.opacity:1;
            if(symbolOpacity!==1)symbolPaint.layers=[...childPaint.layers,{id:++layerId,opacity:symbolOpacity}];
            walk(target,symbolPaint,depth+1,true);
          } else walk({children:[target]},childPaint,depth+1,true);
          active.delete(target);
        }
        continue;
      }
      if (name === "g" || name === "svg" || name === "a") {
        if(name === 'svg') {
          const coordinate=(key,basis,fallback)=>{
            const value=child.getAttribute(key);
            return value?.trim().endsWith('%') ? parseFloat(value)*basis/100 : length(value)??fallback;
          };
          const [pw,ph]=paint.viewport;
          const x=coordinate('x',pw,0),y=coordinate('y',ph,0),w=coordinate('width',pw,pw),h=coordinate('height',ph,ph);
          if(!(w>0&&h>0))continue;
          childPaint.matrix=multiply(childPaint.matrix,[1,0,0,1,x,y]);
          childPaint.clips=[...childPaint.clips,{matrix:childPaint.matrix,paths:[{d:`M0 0H${w}V${h}H0Z`,matrix:IDENTITY}],object:false}];
          const box=parseNumbers(attr(child,'viewBox'));
          if(box.length===4&&box[2]>0&&box[3]>0) {
            childPaint.matrix=multiply(childPaint.matrix,viewportMatrix(box,w,h,attr(child,'preserveAspectRatio')??undefined));
            childPaint.viewport=box.slice(2);
          } else childPaint.viewport=[w,h];
        }
        walk(child, childPaint, depth + 1, instance);
        continue;
      }
      if (!SHAPES.has(name)) continue;
      if (["hidden", "collapse"].includes(style?.visibility ?? child.getAttribute("visibility"))) continue;
      const d = shapePath(name, child, childPaint.viewport);
      if (!d) continue;
      // A line has no interior to fill (SVG 2 §10.5).
      const fill = name === "line" ? null : childPaint.fill;
      if (!fill && !childPaint.stroke) continue;
      shapes.push(Object.freeze({
        d,
        fill: paintValue(fill),
        stroke: paintValue(childPaint.stroke),
        strokeWidth: childPaint.strokeWidth,
        fillRule: childPaint.fillRule,
        fillOpacity: childPaint.fillOpacity * childPaint.opacity,
        strokeOpacity: childPaint.strokeOpacity * childPaint.opacity,
        matrix: childPaint.matrix,
        clips: childPaint.clips, layers: childPaint.layers,
        lineCap: childPaint.lineCap, lineJoin: childPaint.lineJoin,
        miterLimit: childPaint.miterLimit, dash: childPaint.dash, dashOffset: childPaint.dashOffset,
      }));
    }
  }

  return Object.freeze({
    viewBox: viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0 ? Object.freeze(viewBox) : null,
    preserveAspectRatio: element.getAttribute("preserveAspectRatio") ?? element.getAttribute("preserveaspectratio") ?? "xMidYMid meet",
    width: length(element.getAttribute("width")),
    height: length(element.getAttribute("height")),
    shapes: Object.freeze(shapes),
  });
}

/** Paint properties of `element`, inheriting from `parent`. Opacity multiplies down the tree. */
function inherit(parent, element, currentColor, isRoot, computed) {
  const attribute = (name) => {
    if (computed) {
      const field = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (computed[field] != null) return computed[field];
    }
    // Presentation attributes, overridden by the style attribute.
    const style = element.getAttributeNS(null, "style") ?? "";
    const fromStyle = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i").exec(style)?.[1]?.trim();
    return fromStyle ?? element.getAttribute(name);
  };
  const paint = { ...parent };
  const fill = attribute("fill");
  if (fill != null && fill !== "inherit") paint.fill = color(fill, currentColor);
  const stroke = attribute("stroke");
  if (stroke != null && stroke !== "inherit") paint.stroke = color(stroke, currentColor);
  paint.lineCap = attribute('stroke-linecap') ?? parent.lineCap;
  paint.lineJoin = attribute('stroke-linejoin') ?? parent.lineJoin;
  paint.miterLimit = length(attribute('stroke-miterlimit')) ?? parent.miterLimit;
  paint.dashOffset = length(attribute('stroke-dashoffset')) ?? parent.dashOffset;
  const dash = attribute('stroke-dasharray');
  if (dash != null && dash !== 'inherit') {
    paint.dash = dash === 'none' ? [] : parseNumbers(dash);
    if (paint.dash.some(n => n < 0) || !paint.dash.some(n => n > 0)) paint.dash=[];
    if (paint.dash.length % 2) paint.dash=[...paint.dash,...paint.dash];
  }
  const strokeWidth = length(attribute("stroke-width"));
  if (strokeWidth != null) paint.strokeWidth = strokeWidth;
  const fillRule = attribute("fill-rule");
  if (fillRule === "evenodd" || fillRule === "nonzero") paint.fillRule = fillRule;
  const number = (name) => {
    const raw = attribute(name);
    const value = Number.parseFloat(raw) / (String(raw).endsWith("%") ? 100 : 1);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
  };
  paint.fillOpacity = number("fill-opacity") ?? parent.fillOpacity;
  paint.strokeOpacity = number("stroke-opacity") ?? parent.strokeOpacity;
  // The SVG CSS box already composites its own opacity in the display list.
  paint.opacity = parent.opacity * (isRoot && computed ? 1 : number("opacity") ?? 1);
  // The root's own transform does not apply (it is a CSS box), its children's do.
  const transform = isRoot ? null : element.getAttribute("transform");
  if (transform) paint.matrix = multiply(parent.matrix, parseTransform(transform));
  return paint;
}

function color(value, currentColor) {
  const text = String(value).trim();
  if (text === "none") return null;
  if (/^url\(/i.test(text)) return text;
  if (text.toLowerCase() === "currentcolor") return currentColor;
  return Bun.color(text, "rgba") ?? null;
}

function length(value) {
  if (value == null) return null;
  const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px)?\s*$/i.exec(String(value));
  return match ? Number(match[1]) : null;
}

function parseNumbers(value) {
  return String(value ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
}

/** SVG path data for a basic shape (SVG 2 §10). */
function shapePath(name, element, viewport = [300,150]) {
  const number = (attribute) => {
    const value=element.getAttribute(attribute);
    if(value?.trim().endsWith('%')) {
      const basis=['y','y1','y2','cy','height','ry'].includes(attribute)?viewport[1]:attribute==='r'?Math.hypot(...viewport)/Math.SQRT2:viewport[0];
      const result=parseFloat(value)*basis/100;return Number.isFinite(result)?result:0;
    }
    return length(value) ?? 0;
  };
  switch (name) {
    case "path":
      return element.getAttribute("d")?.trim() || null;
    case "rect": {
      const [x, y, width, height] = [number("x"), number("y"), number("width"), number("height")];
      if (width <= 0 || height <= 0) return null;
      let rx = length(element.getAttribute("rx"));
      let ry = length(element.getAttribute("ry"));
      rx ??= ry ?? 0;
      ry ??= rx;
      rx = Math.min(rx, width / 2);
      ry = Math.min(ry, height / 2);
      if (rx <= 0 || ry <= 0) return `M${x} ${y}h${width}v${height}h${-width}Z`;
      return `M${x + rx} ${y}h${width - 2 * rx}a${rx} ${ry} 0 0 1 ${rx} ${ry}v${height - 2 * ry}`
        + `a${rx} ${ry} 0 0 1 ${-rx} ${ry}h${-(width - 2 * rx)}a${rx} ${ry} 0 0 1 ${-rx} ${-ry}`
        + `v${-(height - 2 * ry)}a${rx} ${ry} 0 0 1 ${rx} ${-ry}Z`;
    }
    case "circle":
    case "ellipse": {
      const [cx, cy] = [number("cx"), number("cy")];
      const rx = name === "circle" ? number("r") : number("rx");
      const ry = name === "circle" ? rx : number("ry");
      if (rx <= 0 || ry <= 0) return null;
      return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
    }
    case "line":
      return `M${number("x1")} ${number("y1")}L${number("x2")} ${number("y2")}`;
    case "polyline":
    case "polygon": {
      const points = parseNumbers(element.getAttribute("points"));
      if (points.length < 4) return null;
      let d = `M${points[0]} ${points[1]}`;
      for (let index = 2; index + 1 < points.length; index += 2) d += `L${points[index]} ${points[index + 1]}`;
      return name === "polygon" ? `${d}Z` : d;
    }
    default:
      return null;
  }
}

/** A transform list as an [a, b, c, d, e, f] matrix (SVG 2 §8.5). */
export function parseTransform(text) {
  let matrix = IDENTITY;
  for (const match of String(text).matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi)) {
    const args = parseNumbers(match[2]);
    let next = null;
    switch (match[1].toLowerCase()) {
      case "matrix":
        if (args.length === 6) next = args;
        break;
      case "translate":
        next = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
        break;
      case "scale":
        next = [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const angle = (args[0] ?? 0) * Math.PI / 180;
        const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
        const rotation = [cos, sin, -sin, cos, 0, 0];
        const [cx, cy] = [args[1] ?? 0, args[2] ?? 0];
        next = cx || cy
          ? multiply(multiply([1, 0, 0, 1, cx, cy], rotation), [1, 0, 0, 1, -cx, -cy])
          : rotation;
        break;
      }
      case "skewx":
        next = [1, 0, Math.tan((args[0] ?? 0) * Math.PI / 180), 1, 0, 0];
        break;
      case "skewy":
        next = [1, Math.tan((args[0] ?? 0) * Math.PI / 180), 0, 1, 0, 0];
        break;
    }
    if (next) matrix = multiply(matrix, next);
  }
  return matrix;
}

function multiply([a1, b1, c1, d1, e1, f1], [a2, b2, c2, d2, e2, f2]) {
  return Object.freeze([
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ]);
}
