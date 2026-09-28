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

export function buildDisplayList(layout) {
  const items = [];
  const images = [];
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
  const layers = new Map([[0, { z: 0, order: 0 }]]);
  for (const entry of [...layout.boxes, ...layout.fragments]) {
    if (entry.layer) layers.set(entry.layer.order, entry.layer);
  }
  const orderOf = (entry) => entry.layer?.order ?? 0;
  for (const layer of [...layers.values()].sort((left, right) => left.z - right.z || left.order - right.order)) {
    for (const box of layout.boxes) if (orderOf(box) === layer.order) paintBox(box);
    for (const fragment of layout.fragments) if (orderOf(fragment) === layer.order) paintFragment(fragment);
  }

  function paintBox(box) {
    const style = box.style;
    if (!style) return;
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
  }

  function paintFragment(fragment) {
    for (const run of fragment.runs) {
      if (run.type === "atomic") continue;
      const y = run.y ?? fragment.y;
      if (run.type === "image") {
        if (!run.resource?.image) continue;
        const rect = { x: run.x, y, width: run.width, height: run.height };
        images.push(run.resource);
        items.push({
          op: "drawImage", nodeId: run.nodeId, image: images.length - 1, rect, radii: cornerRadii(run.style, rect), bounds: rect,
        });
        continue;
      }
      if (!run.text.trim()) continue;
      const gradient = textGradients.get(run.style) ?? null;
      if (!gradient && run.style?.color === TRANSPARENT) continue;
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
        ...(gradient ? { gradient } : {}),
        bounds: { x: run.x, y: fragment.y, width: run.width, height: fragment.height },
      });
    }
  }

  const displayList = {
    generation: layout.generation,
    width: layout.width,
    height: layout.height,
    items: Object.freeze(items.map(deepFreeze)),
  };
  Object.defineProperty(displayList, "images", { value: Object.freeze(images), enumerable: false });
  return Object.freeze(displayList);
}

/** Returns display items whose bounds intersect the given document-space rect. */
export function visibleItems(displayList, rect) {
  return displayList.items.filter(({ bounds }) => bounds.x < rect.x + rect.width
    && bounds.x + bounds.width > rect.x
    && bounds.y < rect.y + rect.height
    && bounds.y + bounds.height > rect.y);
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
