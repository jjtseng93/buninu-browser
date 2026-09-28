/**
 * Converts layout output into an immutable, serializable display list.
 *
 * Paint order follows CSS 2 Appendix E for in-flow, non-positioned content:
 * block and inline box decorations in tree order, then inline content (text
 * and replaced images). Coordinates are document CSS pixels; scrolling,
 * device scale, and culling belong to the rasterizer.
 *
 * Image resources are referenced by index into the non-enumerable `images`
 * array so `JSON.stringify(displayList)` stays a plain debug/reftest dump.
 */
const TRANSPARENT = "rgba(0, 0, 0, 0)";

export function buildDisplayList(layout) {
  const items = [];
  const images = [];

  for (const box of layout.boxes) {
    const style = box.style;
    if (!style) continue;
    const rect = { x: box.x, y: box.y, width: box.width, height: box.height };
    const radius = style.borderRadius > 0 ? style.borderRadius : 0;
    if (style.backgroundColor && style.backgroundColor !== TRANSPARENT) {
      items.push({ op: "fillRect", nodeId: box.nodeId, rect, radius, color: style.backgroundColor, bounds: rect });
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
        items.push({ op: "drawImage", nodeId: run.nodeId, image: images.length - 1, rect, bounds: rect });
        continue;
      }
      if (!run.text.trim()) continue;
      items.push({
        op: "drawText",
        nodeId: run.nodeId,
        text: run.text,
        x: run.x,
        y,
        font: { size: run.style?.fontSize ?? 16, weight: run.style?.fontWeight ?? 400 },
        color: run.style?.color ?? "rgba(0, 0, 0, 1)",
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

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") deepFreeze(child);
  }
  return Object.freeze(value);
}
