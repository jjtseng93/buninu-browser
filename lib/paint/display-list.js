/**
 * Converts layout output into an immutable, serializable display list.
 *
 * Paint order follows CSS 2 Appendix E for in-flow, non-positioned content:
 * block and inline box decorations in tree order (outer box-shadow,
 * background color, gradient layers bottom-up, border), then inline content
 * (text and replaced images). `background-clip: text` moves an element's
 * gradient onto its text instead of its box.
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
    if (!style) continue;
    const rect = { x: box.x, y: box.y, width: box.width, height: box.height };
    const radius = style.borderRadius > 0 ? style.borderRadius : 0;
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
        radius: radius > 0 ? Math.max(0, radius + shadow.spread) : 0,
        blur: shadow.blur,
        color: shadow.color,
        // The shadow is clipped out of the casting box's own border box.
        clip: rect,
        clipRadius: radius,
        bounds: inflate(shadowRect, shadow.blur),
      });
    }
    const gradients = gradientLayers(style.backgroundImage)
      .map((source) => resolveGradient(source, rect, style.fontSize))
      .filter(Boolean);
    if (style.backgroundClip === "text") {
      if (gradients.length && !textGradients.has(style)) textGradients.set(style, gradients.at(-1));
    } else {
      if (style.backgroundColor && style.backgroundColor !== TRANSPARENT) {
        items.push({ op: "fillRect", nodeId: box.nodeId, rect, radius, color: style.backgroundColor, bounds: rect });
      }
      for (const gradient of gradients.reverse()) {
        items.push({ op: "fillRect", nodeId: box.nodeId, rect, radius, gradient, bounds: rect });
      }
    }
    if (style.borderWidth > 0 && style.borderColor !== TRANSPARENT) {
      // Strokes are centered on their path, so inset by half the border width.
      const inset = style.borderWidth / 2;
      items.push({
        op: "strokeRect",
        nodeId: box.nodeId,
        rect: {
          x: box.x + inset,
          y: box.y + inset,
          width: Math.max(0, box.width - style.borderWidth),
          height: Math.max(0, box.height - style.borderWidth),
        },
        radius,
        width: style.borderWidth,
        color: style.borderColor,
        bounds: rect,
      });
    }
  }

  for (const fragment of layout.fragments) {
    for (const run of fragment.runs) {
      if (run.type === "atomic") continue;
      const y = run.y ?? fragment.y;
      if (run.type === "image") {
        if (!run.resource?.image) continue;
        const rect = { x: run.x, y, width: run.width, height: run.height };
        images.push(run.resource);
        const radius = run.style?.borderRadius > 0 ? run.style.borderRadius : 0;
        items.push({ op: "drawImage", nodeId: run.nodeId, image: images.length - 1, rect, radius, bounds: rect });
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

function inflate(rect, amount) {
  return { x: rect.x - amount, y: rect.y - amount, width: rect.width + amount * 2, height: rect.height + amount * 2 };
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") deepFreeze(child);
  }
  return Object.freeze(value);
}
