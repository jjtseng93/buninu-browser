import { sameLayoutInput } from "../render-tree/index.js";

// These properties change raster output, not box/text metrics or the set of
// inline decoration boxes emitted by layout. Keep this list deliberately small.
const PAINT_PROPERTIES = new Set([
  "backgroundSize", "backgroundPosition", "backgroundRepeat", "backgroundOrigin", "backgroundClip",
  "transformOrigin",
]);

/** Retain immutable geometry when only existing paint effects changed. */
export function repaintLayout(layout, previous, next) {
  if (!sameLayoutInput(previous.root, next.root, { ignoreStyles: true })) return null;
  const changes = new Map();
  for (const [id, node] of next.nodesById) {
    const before = previous.nodesById.get(id)?.style, after = node.style;
    if (before === after) continue;
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
    if (Object.keys(paint).length) changes.set(id, paint);
  }
  const restyle = record => {
    const paint = changes.get(record.nodeId);
    // Some layout records contain resolved/adjusted styles (e.g. tables).
    // Preserve all of those metrics instead of replacing the complete style.
    return paint && record.style ? Object.freeze({ ...record, style: Object.freeze({ ...record.style, ...paint }) }) : record;
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
