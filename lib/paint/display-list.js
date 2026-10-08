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
import { backgroundLayers, gradientLayers, isGradient, resolveGradient, splitTopLevel } from "./gradient.js";

const TRANSPARENT = "rgba(0, 0, 0, 0)";
const CSS_URL = /^url\(\s*(["']?)(.*?)\1\s*\)$/is;
const LENGTH = /^(-?(?:\d+\.?\d*|\.\d+))(px|%|em|rem)?$/;

/**
 * @param layout the layout result
 * @param tree the render tree it was laid out from; without it, visibility,
 *   opacity and overflow clipping of ancestors are not applied.
 */
/**
 * @param backgroundResource(url) the decoded image a background url() names,
 *   or null while it has not arrived (it paints nothing until then)
 */
export function buildDisplayList(layout, tree = null, resources = null, backgroundResource = null, scrollOffsetOf = null) {
  const items = [];
  const images = [];
  // Every box and run in paint order, painted or not: what a point hits (see hitTarget).
  const hits = [];
  // How far each scroll container's content reaches (its scrollable overflow),
  // unscrolled: all of it, and the in-flow part, which alone gets the end
  // padding (CSS Overflow 3 §2.2); absolutely positioned boxes count as they are.
  const scrollers = new Map();
  const reach = (effect, rect) => {
    // Content of a nested scroll container counts for that one only.
    const id = effect.scrollers?.[0];
    if (id == null) return;
    const extent = scrollers.get(id) ?? { right: -Infinity, bottom: -Infinity, flowRight: -Infinity, flowBottom: -Infinity };
    extent.right = Math.max(extent.right, rect.x + rect.width);
    extent.bottom = Math.max(extent.bottom, rect.y + rect.height);
    if (!effect.outOfFlow) {
      extent.flowRight = Math.max(extent.flowRight, rect.x + rect.width);
      extent.flowBottom = Math.max(extent.flowBottom, rect.y + rect.height);
    }
    scrollers.set(id, extent);
  };
  const effects = paintEffects(layout, tree, scrollOffsetOf);
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
    hits.push({
      nodeId: box.nodeId, rect: effect.transform ? transformRect(effect.transform, rect) : rect, clipRect: effect.clipRect, fixed: effect.fixed,
    });
    reach(effect, rect);
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
    if (style.backgroundClip !== "text") {
      if (style.backgroundColor && style.backgroundColor !== TRANSPARENT) {
        items.push({ op: "fillRect", nodeId: box.nodeId, rect, radii, color: style.backgroundColor, bounds: rect });
      }
      // Background layers, bottom first.
      const layers = backgroundLayers(style.backgroundImage);
      for (let index = layers.length - 1; index >= 0; index--) {
        const layer = layers[index];
        if (isGradient(layer)) {
          const gradient = resolveGradient(layer, rect, style.fontSize);
          if (gradient) items.push({ op: "fillRect", nodeId: box.nodeId, rect, radii, gradient, bounds: rect });
          continue;
        }
        const url = CSS_URL.exec(layer)?.[2];
        const resource = url && backgroundResource?.(url);
        if (!resource?.image) continue;
        const placed = backgroundTile(style, rect, index, resource);
        if (!placed) continue;
        images.push(resource);
        items.push({ op: "drawBackgroundImage", nodeId: box.nodeId, image: images.length - 1, rect, radii, ...placed });
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
      const hitRect = {
        x: run.x,
        y: run.type === "image" ? run.y ?? fragment.y : fragment.y,
        width: run.width,
        height: run.type === "image" ? run.height : fragment.height,
      };
      hits.push({
        nodeId: run.nodeId,
        rect: effect.transform ? transformRect(effect.transform, hitRect) : hitRect,
        clipRect: effect.clipRect,
        fixed: effect.fixed,
      });
      reach(effect, hitRect);
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
        const currentResource = resources && tree
          ? resources.get(tree.nodesById.get(run.nodeId)?.domNode) ?? run.resource
          : run.resource;
        if (run.video || run.audio) {
          const rect = { x: run.x, y, width: run.width, height: run.height };
          images.push(currentResource);
          items.push({ op: run.video ? "drawVideo" : "drawAudio", nodeId: run.nodeId, image: images.length - 1, rect, bounds: rect });
          return;
        }
        if (!currentResource?.image) return;
        const rect = { x: run.x, y, width: run.width, height: run.height };
        images.push(currentResource);
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
  Object.defineProperty(displayList, "hits", { value: Object.freeze(hits), enumerable: false });
  Object.defineProperty(displayList, "scrollers", { value: scrollers, enumerable: false });
  // How far the page's content reaches (its scrollable overflow, CSS Overflow 3 §2.2):
  // every box and run, cut to the clips around it; fixed content does not count.
  let right = 0;
  let bottom = 0;
  for (const { rect, clipRect, fixed } of hits) {
    if (fixed) continue;
    const reached = clipRect ? intersectRects(rect, clipRect) : rect;
    if (!(reached.width > 0 && reached.height > 0)) continue;
    right = Math.max(right, reached.x + reached.width);
    bottom = Math.max(bottom, reached.y + reached.height);
  }
  Object.defineProperty(displayList, "extent", { value: Object.freeze({ width: right, height: bottom }), enumerable: false });
  return Object.freeze(displayList);
}

/**
 * The render node id of the topmost box or run at a viewport point, in paint
 * order, or null. `skip(nodeId)` passes over nodes that take no pointer
 * events. Fixed content stays put as the page scrolls.
 */
export function hitTarget(displayList, x, y, scroll, skip = () => false) {
  const hits = displayList?.hits ?? [];
  for (let index = hits.length - 1; index >= 0; index--) {
    const { nodeId, rect, clipRect, fixed } = hits[index];
    const pointX = fixed ? x : x + scroll.x;
    const pointY = fixed ? y : y + scroll.y;
    if (pointX < rect.x || pointX >= rect.x + rect.width || pointY < rect.y || pointY >= rect.y + rect.height) continue;
    if (clipRect && (pointX < clipRect.x || pointX >= clipRect.x + clipRect.width
      || pointY < clipRect.y || pointY >= clipRect.y + clipRect.height)) continue;
    if (skip(nodeId)) continue;
    return nodeId;
  }
  return null;
}

/**
 * Painting effects of ancestors (CSS Visual Effects / Overflow): visibility,
 * group opacity (approximated per item), and clipping by overflow, clip and
 * clip-path rectangles. Returns effects(nodeId, "box" | "text") → null when
 * the item is not painted, else { opacity, clipRect }.
 */
function paintEffects(layout, tree, scrollOffsetOf = null) {
  const none = { opacity: 1, clipRect: null, fixed: false, transform: null, scrollers: null, outOfFlow: false };
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
  // Each element's own clips, worked out once for all the items below it.
  const memo = (compute) => {
    const results = new Map();
    return (node) => {
      if (results.has(node)) return results.get(node);
      const result = compute(node);
      results.set(node, result === null ? null : Object.freeze(result));
      return results.get(node);
    };
  };

  // The clip an element applies to its descendants (and, for clip/clip-path, to itself).
  const overflowClip = memo((node) => {
    const style = node.style;
    const box = boxes.get(node.id);
    if (!style || !box || node === tree.root) return null;
    if (style.overflowX !== "clip" && style.overflowY !== "clip") return null;
    const [top, right, bottom, left] = style.borderWidths ?? [0, 0, 0, 0];
    return { x: box.x + left, y: box.y + top, width: box.width - left - right, height: box.height - top - bottom };
  });
  const shapeClip = memo((node) => {
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
  });
  // A scale an element's transform applies to itself and its contents, about its transform-origin.
  const ownTransform = memo((node) => {
    const transform = node.style?.transform;
    const box = boxes.get(node.id);
    if (!box || !transform?.scaleX || (transform.scaleX === 1 && transform.scaleY === 1)) return null;
    const origin = transformOrigin(node.style.transformOrigin, box);
    return {
      a: transform.scaleX,
      d: transform.scaleY,
      e: origin.x * (1 - transform.scaleX),
      f: origin.y * (1 - transform.scaleY),
    };
  });

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
      // Clips by the element that applies them: a scaled ancestor moves them too.
      const clips = [];
      const chain = [];
      // Scroll containers this content scrolls with: those whose clip applies to it.
      const scrolledBy = new Set();
      // Whether an absolutely positioned box lies between the content and
      // its innermost scroll container.
      let positionedOut = false;
      let outOfFlow = false;
      for (let node = owner; node; node = parents.get(node.id)) {
        chain.push(node);
        const style = node.style;
        if (!style) continue;
        if (style.position === "fixed") fixed = true;
        opacity *= style.opacity ?? 1;
        clips.push([node, shapeClip(node)]);
        const ownContent = kind === "text" || node !== owner;
        if (ownContent && escaping !== "fixed") {
          const positioned = style.position && style.position !== "static";
          if (!escaping || positioned) {
            clips.push([node, overflowClip(node)]);
            if (isScroller(style)) {
              if (!scrolledBy.size) outOfFlow = positionedOut;
              scrolledBy.add(node);
            }
            escaping = null;
          }
        }
        if (style.position === "absolute" || style.position === "fixed") positionedOut = true;
        if (style.position === "fixed") escaping = "fixed";
        else if (style.position === "absolute" && escaping !== "fixed") escaping = "absolute";
      }
      // The transforms from the root down to each element: scales, and the
      // scroll offsets of the scroll containers it is the content of.
      let transform = null;
      const transforms = new Map();
      for (let index = chain.length - 1; index >= 0; index--) {
        const node = chain[index];
        const own = ownTransform(node);
        if (own) transform = transform ? composeTransforms(transform, own) : own;
        transforms.set(node, transform);
        const offset = scrolledBy.has(node) ? scrollOffsetOf?.(node.domNode) : null;
        if (offset && (offset.x || offset.y)) {
          const scrolled = { a: 1, d: 1, e: 0 - offset.x, f: 0 - offset.y };
          transform = transform ? composeTransforms(transform, scrolled) : scrolled;
        }
      }
      for (const [node, clip] of clips) {
        const matrix = transforms.get(node);
        clipRect = intersectRects(clipRect, clip && matrix ? transformRect(matrix, clip) : clip);
      }
      // The owner's own box moves with every scroll container above it, not with its own.
      transform = kind === "text" ? transform : transforms.get(owner) ?? null;
      const scrollers = scrolledBy.size ? [...scrolledBy].map((node) => node.id) : null;
      result = opacity <= 0 ? null : { opacity, clipRect, fixed, transform, scrollers, outOfFlow };
    } else {
      result = null;
    }
    cache.set(key, result);
    return result;
  };
}

/** Whether a box is a scroll container (CSS Overflow 3 §3), by script or by the user. */
function isScroller(style) {
  return Boolean(style?.overflowScrollX || style?.overflowScrollY);
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

/** The resolved transform-origin of a border box (CSS Transforms 1 §5); 50% 50% by default. */
function transformOrigin(value, box) {
  const tokens = (value ?? "50% 50%").split(" ");
  if (tokens.length === 1) tokens.push("center");
  if (["top", "bottom"].includes(tokens[0]) || ["left", "right"].includes(tokens[1])) tokens.reverse();
  const resolve = (token, start, extent) => {
    const keyword = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 }[token];
    if (keyword != null) return start + extent * keyword;
    const match = /^(-?[\d.]+)(px|%)?$/.exec(token);
    if (!match) return start + extent / 2;
    return start + (match[2] === "%" ? extent * Number(match[1]) / 100 : Number(match[1]));
  };
  return { x: resolve(tokens[0], box.x, box.width), y: resolve(tokens[1], box.y, box.height) };
}

/** `outer` after `inner`: x -> outer(inner(x)), for scales with translation. */
function composeTransforms(outer, inner) {
  return { a: outer.a * inner.a, d: outer.d * inner.d, e: outer.a * inner.e + outer.e, f: outer.d * inner.f + outer.f };
}

function transformRect(matrix, rect) {
  const x0 = matrix.a * rect.x + matrix.e;
  const y0 = matrix.d * rect.y + matrix.f;
  const x1 = matrix.a * (rect.x + rect.width) + matrix.e;
  const y1 = matrix.d * (rect.y + rect.height) + matrix.f;
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

function applyEffect(items, start, effect) {
  if (effect.opacity === 1 && !effect.clipRect && !effect.fixed && !effect.transform) return;
  for (let index = start; index < items.length; index++) {
    const item = items[index];
    if (effect.fixed) item.fixed = true;
    if (effect.opacity < 1) item.opacity = effect.opacity;
    // Drawn through the transform; its bounds are where it lands.
    if (effect.transform) {
      item.transform = effect.transform;
      item.bounds = transformRect(effect.transform, item.bounds);
    }
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

/**
 * Where one background image layer's tiles go (CSS Backgrounds 3 §3): sized
 * and positioned in the padding box, repeated per background-repeat, painted
 * within the border box. Null when it has no area.
 */
function backgroundTile(style, rect, index, resource) {
  const border = style.borderWidths ?? [0, 0, 0, 0];
  const area = {
    x: rect.x + border[3],
    y: rect.y + border[0],
    width: Math.max(0, rect.width - border[1] - border[3]),
    height: Math.max(0, rect.height - border[0] - border[2]),
  };
  const pick = (list, fallback) => {
    if (!list) return fallback;
    const entries = splitTopLevel(list, ",");
    return entries.length ? entries[index % entries.length] : fallback;
  };
  const length = (token, reference) => {
    const match = LENGTH.exec(token);
    if (!match) return null;
    const value = Number(match[1]);
    if (match[2] === "%") return reference * value / 100;
    if (match[2] === "em") return value * (style.fontSize ?? 16);
    if (match[2] === "rem") return value * 16;
    return match[2] || value === 0 ? value : null;
  };

  // background-size
  const ratio = resource.width / resource.height;
  let width;
  let height;
  const size = pick(style.backgroundSize, "auto").split(/\s+/);
  if (size[0] === "cover" || size[0] === "contain") {
    const fit = size[0] === "cover"
      ? Math.max(area.width / resource.width, area.height / resource.height)
      : Math.min(area.width / resource.width, area.height / resource.height);
    width = resource.width * fit;
    height = resource.height * fit;
  } else {
    width = size[0] === "auto" ? null : length(size[0], area.width);
    height = (size[1] ?? "auto") === "auto" ? null : length(size[1], area.height);
    if (width == null && height == null) [width, height] = [resource.width, resource.height];
    else if (width == null) width = height * ratio;
    else if (height == null) height = width / ratio;
  }
  if (!(width > 0 && height > 0)) return null;

  // background-position: keywords, offsets from the top left, or from an edge.
  const tokens = pick(style.backgroundPosition, "0% 0%").split(/\s+/);
  const horizontalKeyword = (token) => token === "left" || token === "right";
  const verticalKeyword = (token) => token === "top" || token === "bottom";
  let horizontal = ["left", null];
  let vertical = ["top", null];
  if (tokens.length === 1) {
    // One value: the other is center.
    horizontal = verticalKeyword(tokens[0]) ? ["center", null] : [tokens[0], null];
    vertical = verticalKeyword(tokens[0]) ? [tokens[0], null] : ["center", null];
  } else if (tokens.length === 2) {
    const [first, second] = verticalKeyword(tokens[0]) || horizontalKeyword(tokens[1]) ? [tokens[1], tokens[0]] : tokens;
    horizontal = [first, null];
    vertical = [second, null];
  } else {
    // Three or four values: edge keywords, each optionally followed by an
    // offset; center takes an axis no edge keyword named.
    const pairs = [];
    for (let at = 0; at < tokens.length; at++) {
      const keyword = tokens[at];
      const offset = at + 1 < tokens.length && LENGTH.test(tokens[at + 1]) ? tokens[++at] : null;
      pairs.push([keyword, offset]);
    }
    const named = { horizontal: false, vertical: false };
    for (const pair of pairs) {
      if (horizontalKeyword(pair[0])) [horizontal, named.horizontal] = [pair, true];
      else if (verticalKeyword(pair[0])) [vertical, named.vertical] = [pair, true];
    }
    for (const pair of pairs) {
      if (pair[0] !== "center") continue;
      if (!named.horizontal) [horizontal, named.horizontal] = [pair, true];
      else if (!named.vertical) [vertical, named.vertical] = [pair, true];
    }
  }
  const place = ([keyword, offset], start, extent, tile) => {
    const free = extent - tile;
    const fraction = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 }[keyword];
    if (fraction == null) return start + (length(keyword, free) ?? 0);
    const distance = offset == null ? 0 : length(offset, free) ?? 0;
    return start + free * fraction + (fraction === 1 ? -distance : distance);
  };
  const tile = {
    x: place(horizontal, area.x, area.width, width),
    y: place(vertical, area.y, area.height, height),
    width,
    height,
  };

  // background-repeat
  const repeat = pick(style.backgroundRepeat, "repeat").split(/\s+/);
  const repeats = (value) => value !== "no-repeat";
  const [repeatX, repeatY] = repeat[0] === "repeat-x" ? [true, false]
    : repeat[0] === "repeat-y" ? [false, true]
      : [repeats(repeat[0]), repeats(repeat[1] ?? repeat[0])];
  // Only the part of the border box the tiles reach paints.
  const left = repeatX ? rect.x : Math.max(rect.x, tile.x);
  const right = repeatX ? rect.x + rect.width : Math.min(rect.x + rect.width, tile.x + width);
  const top = repeatY ? rect.y : Math.max(rect.y, tile.y);
  const bottom = repeatY ? rect.y + rect.height : Math.min(rect.y + rect.height, tile.y + height);
  if (right <= left || bottom <= top) return null;
  return { tile, repeatX, repeatY, bounds: { x: left, y: top, width: right - left, height: bottom - top } };
}

function inflate(rect, amount) {
  return { x: rect.x - amount, y: rect.y - amount, width: rect.width + amount * 2, height: rect.height + amount * 2 };
}

/** Freezes an item and what it holds; frozen values (shared clips, style data) are already done. */
function deepFreeze(value) {
  if (Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") deepFreeze(child);
  }
  return Object.freeze(value);
}
