/**
 * Converts layout output into an immutable, serializable display list.
 *
 * Paint order follows CSS 2 Appendix E for in-flow, non-positioned content:
 * block and inline box decorations in tree order (outer box-shadow,
 * background color, gradient layers bottom-up, per-side borders), then inline content
 * (text and replaced images). `background-clip: text` moves an element's
 * gradient onto its text instead of its box. Positioned boxes form paint
 * layers painted after in-flow content in (z-index, tree order); negative
 * z-index layers paint beneath it.
 *
 * Coordinates are document CSS pixels; scrolling, device scale, and culling
 * belong to the rasterizer.
 *
 * Image resources are referenced by index into the non-enumerable `images`
 * array so `JSON.stringify(displayList)` stays a plain debug/reftest dump.
 */
import { gradientLayers, resolveGradient } from "./gradient.js";

const TRANSPARENT = "rgba(0, 0, 0, 0)";

/**
 * @param layout the layout result
 * @param tree the render tree it was laid out from; without it, visibility,
 *   opacity and overflow clipping of ancestors are not applied.
 */
export function buildDisplayList(layout, tree = null) {
  const items = [];
  const images = [];
  const effects = paintEffects(layout, tree);
  // Text styled with background-clip:text takes its gradient from the owning box.
  const textGradients = new Map();
  for (const box of layout.boxes) {
    const style = box.style;
    if (style?.backgroundClip !== "text" || textGradients.has(style)) continue;
    const gradient = gradientLayers(style.backgroundImage)
      .map((source) => resolveGradient(source, box, style.fontSize))
      .filter(Boolean)
      .at(-1);
    if (gradient) textGradients.set(style, gradient);
  }

  // Layers are identified by their creation order; the root layer is order 0.
  // Stacking contexts form a tree (CSS 2 Appendix E): a context paints its
  // negative-z children, its own content, then its z >= 0 children (z-index
  // auto counts as 0), each group in z then tree order.
  const layers = new Map([[0, { z: 0, order: 0, context: true, parent: null }]]);
  const boxesByLayer = new Map();
  const fragmentsByLayer = new Map();
  const add = (map, entry) => {
    const order = entry.layer?.order ?? 0;
    if (entry.layer) layers.set(order, entry.layer);
    let list = map.get(order);
    if (!list) map.set(order, list = []);
    list.push(entry);
  };
  for (const box of layout.boxes) add(boxesByLayer, box);
  for (const fragment of layout.fragments) add(fragmentsByLayer, fragment);
  const children = new Map();
  for (const layer of layers.values()) {
    if (layer.order === 0) continue;
    const parent = layer.parent?.order ?? 0;
    let list = children.get(parent);
    if (!list) children.set(parent, list = []);
    list.push(layer);
  }
  const paintLayerContent = (layer) => {
    for (const box of boxesByLayer.get(layer.order) ?? []) paintBox(box);
    for (const fragment of fragmentsByLayer.get(layer.order) ?? []) paintFragment(fragment);
  };
  const paintContext = (context) => {
    const members = (children.get(context.order) ?? []).sort((left, right) => left.z - right.z || left.order - right.order);
    for (const layer of members) if (layer.z < 0) paintMember(layer);
    paintLayerContent(context);
    for (const layer of members) if (layer.z >= 0) paintMember(layer);
  };
  const paintMember = (layer) => (layer.context ? paintContext(layer) : paintLayerContent(layer));
  paintContext(layers.get(0));

  function paintBox(box) {
    const style = box.style;
    if (!style) return;
    const effect = effects(box.nodeId, "box");
    if (!effect) return;
    const start = items.length;
    const rect = { x: box.x, y: box.y, width: box.width, height: box.height };
    const radii = cornerRadii(style, rect);
    for (const shadow of style.boxShadow ?? []) {
      if (shadow.inset || shadow.color === TRANSPARENT) continue;
      const shadowRect = {
        x: rect.x + shadow.x - shadow.spread,
        y: rect.y + shadow.y - shadow.spread,
        width: rect.width + shadow.spread * 2,
        height: rect.height + shadow.spread * 2,
      };
      items.push({
        op: "drawShadow",
        nodeId: box.nodeId,
        rect: shadowRect,
        radii: radii.x > 0 || radii.y > 0
          ? { x: Math.max(0, radii.x + shadow.spread), y: Math.max(0, radii.y + shadow.spread) }
          : radii,
        blur: shadow.blur,
        color: shadow.color,
        // The shadow is clipped out of the casting box's own border box.
        clip: rect,
        clipRadii: radii,
        bounds: inflate(shadowRect, shadow.blur),
      });
    }
    const gradients = gradientLayers(style.backgroundImage)
      .map((source) => resolveGradient(source, rect, style.fontSize))
      .filter(Boolean);
    if (style.backgroundClip !== "text") {
      if (style.backgroundColor && style.backgroundColor !== TRANSPARENT) {
        items.push({ op: "fillRect", nodeId: box.nodeId, rect, radii, color: style.backgroundColor, bounds: rect });
      }
      for (const gradient of gradients.reverse()) {
        items.push({ op: "fillRect", nodeId: box.nodeId, rect, radii, gradient, bounds: rect });
      }
    }
    const widths = style.borderWidths ?? [0, 0, 0, 0];
    const visible = widths.some((width, index) => width > 0 && style.borderColors[index] !== TRANSPARENT);
    if (visible) {
      items.push({
        op: "border",
        nodeId: box.nodeId,
        rect,
        radii,
        widths: [...widths],
        colors: [...style.borderColors],
        styles: [...style.borderStyles],
        bounds: rect,
      });
    }
    applyEffect(items, start, effect);
  }

  function paintFragment(fragment) {
    for (const run of fragment.runs) {
      if (run.type === "atomic") continue;
      const effect = effects(run.nodeId, run.type === "image" ? "box" : "text");
      if (!effect) continue;
      const start = items.length;
      paintRun(fragment, run);
      applyEffect(items, start, effect);
    }
  }

  function paintRun(fragment, run) {
    {
      const y = run.y ?? fragment.y;
      if (run.type === "image" && run.svg) {
        const rect = { x: run.x, y, width: run.width, height: run.height };
        if (run.svg.shapes.length) items.push({ op: "drawSvg", nodeId: run.nodeId, rect, svg: run.svg, bounds: rect });
        return;
      }
      if (run.type === "image") {
        if (run.video) {
          const rect = { x: run.x, y, width: run.width, height: run.height };
          images.push(run.resource);
          items.push({ op: "drawVideo", nodeId: run.nodeId, image: images.length - 1, rect, bounds: rect });
          return;
        }
        if (!run.resource?.image) return;
        const rect = { x: run.x, y, width: run.width, height: run.height };
        images.push(run.resource);
        items.push({
          op: "drawImage", nodeId: run.nodeId, image: images.length - 1, rect, radii: cornerRadii(run.style, rect), bounds: rect,
        });
        return;
      }
      if (!run.text.trim()) return;
      const gradient = textGradients.get(run.style) ?? null;
      if (!gradient && run.style?.color === TRANSPARENT) return;
      items.push({
        op: "drawText",
        nodeId: run.nodeId,
        text: run.text,
        x: run.x,
        y,
        font: {
          family: run.style?.fontFamily ?? ["sans-serif"],
          size: run.style?.fontSize ?? 16,
          weight: run.style?.fontWeight ?? 400,
        },
        color: run.style?.color ?? "rgba(0, 0, 0, 1)",
        ...(run.style?.textDecorations ? { decoration: run.style.textDecorations } : {}),
        ...(gradient ? { gradient } : {}),
        bounds: { x: run.x, y: fragment.y, width: run.width, height: fragment.height },
      });
    }
  }

  // Items clipped away entirely paint nothing.
  const kept = items.filter((item) => !item.clipRect || (item.bounds.width > 0 && item.bounds.height > 0));
  const displayList = {
    generation: layout.generation,
    width: layout.width,
    height: layout.height,
    items: Object.freeze(kept.map(deepFreeze)),
  };
  Object.defineProperty(displayList, "images", { value: Object.freeze(images), enumerable: false });
  return Object.freeze(displayList);
}

/**
 * Painting effects of ancestors (CSS Visual Effects / Overflow): visibility,
 * group opacity (approximated per item), and clipping by overflow, clip and
 * clip-path rectangles. Returns effects(nodeId, "box" | "text") → null when
 * the item is not painted, else { opacity, clipRect }.
 */
function paintEffects(layout, tree) {
  const none = { opacity: 1, clipRect: null, fixed: false };
  if (!tree?.root) return () => none;
  const parents = new Map();
  (function walk(node) {
    for (const child of node.children ?? []) {
      parents.set(child.id, node);
      walk(child);
    }
  })(tree.root);
  const boxes = new Map();
  for (const box of layout.boxes) if (!box.inline && !boxes.has(box.nodeId)) boxes.set(box.nodeId, box);
  const cache = new Map();

  // The clip an element applies to its descendants (and, for clip/clip-path, to itself).
  const overflowClip = (node) => {
    const style = node.style;
    const box = boxes.get(node.id);
    if (!style || !box || node === tree.root) return null;
    if (style.overflowX !== "clip" && style.overflowY !== "clip") return null;
    const [top, right, bottom, left] = style.borderWidths ?? [0, 0, 0, 0];
    return { x: box.x + left, y: box.y + top, width: box.width - left - right, height: box.height - top - bottom };
  };
  const shapeClip = (node) => {
    const style = node.style;
    const box = boxes.get(node.id);
    if (!style || !box) return null;
    let rect = null;
    if (style.clipPath?.empty) rect = { x: box.x, y: box.y, width: 0, height: 0 };
    else if (style.clipPath?.inset) {
      const [top, right, bottom, left] = style.clipPath.inset.map((edge, index) =>
        edge?.unit === "%" ? edge.value / 100 * (index % 2 ? box.width : box.height) : edge);
      rect = { x: box.x + left, y: box.y + top, width: box.width - left - right, height: box.height - top - bottom };
    }
    if (style.clip && (style.position === "absolute" || style.position === "fixed")) {
      const [top, right, bottom, left] = style.clip;
      const x0 = left === "auto" ? box.x : box.x + left;
      const y0 = top === "auto" ? box.y : box.y + top;
      const x1 = right === "auto" ? box.x + box.width : box.x + right;
      const y1 = bottom === "auto" ? box.y + box.height : box.y + bottom;
      rect = intersectRects(rect, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
    }
    return rect;
  };

  return (nodeId, kind) => {
    const key = `${kind}:${nodeId}`;
    if (cache.has(key)) return cache.get(key);
    const self = tree.nodesById?.get(nodeId);
    // Text belongs to its parent element for visibility and clipping.
    const owner = kind === "text" ? parents.get(nodeId) : self;
    let result = none;
    if (!owner?.style || owner.style.visibility !== "hidden") {
      let opacity = 1;
      let clipRect = null;
      let fixed = false;
      // Overflow clipping skips ancestors that are not in the containing-block
      // chain of an absolutely positioned box; fixed boxes escape entirely.
      let escaping = null;
      for (let node = owner; node; node = parents.get(node.id)) {
        const style = node.style;
        if (!style) continue;
        if (style.position === "fixed") fixed = true;
        opacity *= style.opacity ?? 1;
        clipRect = intersectRects(clipRect, shapeClip(node));
        const ownContent = kind === "text" || node !== owner;
        if (ownContent && escaping !== "fixed") {
          const positioned = style.position && style.position !== "static";
          if (!escaping || positioned) {
            clipRect = intersectRects(clipRect, overflowClip(node));
            escaping = null;
          }
        }
        if (style.position === "fixed") escaping = "fixed";
        else if (style.position === "absolute" && escaping !== "fixed") escaping = "absolute";
      }
      result = opacity <= 0 ? null : { opacity, clipRect, fixed };
    } else {
      result = null;
    }
    cache.set(key, result);
    return result;
  };
}

function intersectRects(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function applyEffect(items, start, effect) {
  if (effect.opacity === 1 && !effect.clipRect && !effect.fixed) return;
  for (let index = start; index < items.length; index++) {
    const item = items[index];
    if (effect.fixed) item.fixed = true;
    if (effect.opacity < 1) item.opacity = effect.opacity;
    if (effect.clipRect) {
      item.clipRect = effect.clipRect;
      item.bounds = intersectRects(item.bounds, effect.clipRect);
    }
  }
}

/** Returns display items whose bounds intersect the given document-space rect. */
export function visibleItems(displayList, rect, fixedOffset = { x: 0, y: 0 }) {
  return displayList.items.filter(({ bounds, fixed }) => {
    const x = bounds.x + (fixed ? fixedOffset.x : 0);
    const y = bounds.y + (fixed ? fixedOffset.y : 0);
    return x < rect.x + rect.width && x + bounds.width > rect.x
      && y < rect.y + rect.height && y + bounds.height > rect.y;
  });
}

/**
 * Resolves border-radius to one elliptical radius for every corner.
 * Percentages refer to the border box's width (x) and height (y); radii that
 * would overlap are scaled down together (CSS Backgrounds 3 §5.5).
 */
function cornerRadii(style, rect) {
  const value = style?.borderRadius;
  let x = 0;
  let y = 0;
  if (value?.unit === "%") {
    x = rect.width * value.value / 100;
    y = rect.height * value.value / 100;
  } else if (value > 0) {
    x = y = value;
  }
  const scale = Math.min(1, x > 0 ? rect.width / (2 * x) : 1, y > 0 ? rect.height / (2 * y) : 1);
  return { x: x * scale, y: y * scale };
}

function inflate(rect, amount) {
  return { x: rect.x - amount, y: rect.y - amount, width: rect.width + amount * 2, height: rect.height + amount * 2 };
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") deepFreeze(child);
  }
  return Object.freeze(value);
}
