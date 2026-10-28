import { sameLayoutInput } from "../render-tree/index.js";

// These properties change raster output, not box/text metrics. Inline
// decoration boxes still need the guard below. Keep this list small.
const PAINT_PROPERTIES = new Set([
  "opacity", "backgroundColor",
  "backgroundSize", "backgroundPosition", "backgroundRepeat", "backgroundOrigin", "backgroundClip",
  "transformOrigin",
]);

/** Retain immutable geometry when paint changes preserve layout records. */
export function repaintLayout(layout, previous, next) {
  if (!sameLayoutInput(previous.root, next.root, { ignoreStyles: true })) return null;
  const changes = new Map();
  const styles = new Map();
  for (const [id, node] of next.nodesById) {
    const before = previous.nodesById.get(id)?.style, after = node.style;
    // Anonymous fragments have no node ID and must be restyled by their old
    // style identity. If that identity split into different new styles, only
    // layout can determine which fragment belongs to which new owner.
    if (styles.has(before) && !Bun.deepEquals(styles.get(before), after)) return null;
    if (before === after) {
      styles.set(before, before);
      continue;
    }
    if (!before || !after) return null;
    const paint = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (Bun.deepEquals(before[key], after[key])) continue;
      if (key === "transform") {
        // Translation is currently baked into layout coordinates. Only scale
        // changes within an existing transform can reuse those coordinates.
        const a = before[key], b = after[key];
        if (!a || !b || !Bun.deepEquals(a.x, b.x) || !Bun.deepEquals(a.y, b.y)
          || Object.keys(a).some(k => !["x", "y", "scaleX", "scaleY"].includes(k))
          || Object.keys(b).some(k => !["x", "y", "scaleX", "scaleY"].includes(k))) return null;
      } else if (!PAINT_PROPERTIES.has(key)) return null;
      paint[key] = after[key];
    }
    if (Object.keys(paint).length) {
      // Layout only emits inline/replaced decoration boxes when a background
      // or border is present. Adding/removing one requires those boxes to be
      // regenerated, even though the text/image metrics have not changed.
      if ((node.type === "inline" || node.type === "image")
        && hasDecoration(before) !== hasDecoration(after)) return null;
      changes.set(id, paint);
      styles.set(before, after);
    } else styles.set(before, before);
  }
  const restyle = record => {
    const paint = changes.get(record.nodeId);
    let style = styles.get(record.style);
    // Some layout records contain resolved/adjusted styles (e.g. tables).
    // Preserve all of those metrics instead of replacing the complete style.
    if (!style && paint && record.style) {
      style = Object.freeze({ ...record.style, ...paint });
      styles.set(record.style, style);
    }
    // Boxes, runs and anonymous line fragments can share one computed style.
    // Keep that identity: background-clip:text finds its gradient by style.
    return style && style !== record.style ? Object.freeze({ ...record, style }) : record;
  };
  return Object.freeze({ ...layout, generation: next.generation,
    boxes: mapChanged(layout.boxes, restyle),
    fragments: mapChanged(layout.fragments, fragment => {
      const updated = restyle(fragment);
      const runs = fragment.runs && mapChanged(fragment.runs, restyle);
      return runs === fragment.runs ? updated : Object.freeze({ ...updated, runs });
    }),
  });
}

// Keep in sync with the inline decoration predicate in text-layout.js.
function hasDecoration(style) {
  return Boolean((style.backgroundColor && style.backgroundColor !== "rgba(0, 0, 0, 0)")
    || style.backgroundImage || style.borderWidths?.some(width => width > 0));
}

/** Copy immutable arrays only when a record actually changed. */
function mapChanged(records, update) {
  let changed = null;
  for (let index = 0; index < records.length; index++) {
    const record = records[index], next = update(record);
    if (next === record) continue;
    changed ??= records.slice();
    changed[index] = next;
  }
  return changed ? Object.freeze(changed) : records;
}
