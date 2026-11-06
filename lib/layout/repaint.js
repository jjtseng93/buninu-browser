import { sameLayoutInput } from "../render-tree/index.js";
import {stackingContext, transformableBox} from '../style/will-change.js';

// These properties change raster output, not box/text metrics. Inline
// decoration boxes still need the guard below. Keep this list small.
const PAINT_PROPERTIES = new Set([
  "opacity", "backgroundColor", "boxShadow",
  "backgroundSize", "backgroundSizeValues", "backgroundPosition", "backgroundRepeat", "backgroundOrigin", "backgroundClip",
  "backgroundPositionX", "backgroundPositionY", "backgroundPositionXValues", "backgroundPositionYValues", "backgroundAttachment",
  "transformOrigin",
]);

/** Retain immutable geometry when paint changes preserve layout records. */
export function repaintLayout(layout, previous, next) {
  if (!sameLayoutInput(previous.root, next.root, { ignoreStyles: true, ignoreSvgPaint: true })) return null;
  const changes = new Map();
  const styles = new Map();
  const contexts = new Map();
  let layerNodes;
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
    // Opacity can create/remove a stacking context without changing metrics.
    // Its layer ownership must still be rebuilt; changes within an existing
    // context (including one from transform/z-index) retain the fast path.
    if (node.type !== 'text' && node.type !== 'line-break'
      && stackingContext(previous.nodesById.get(id)) !== stackingContext(node)) {
      // Ordinary inline fragments do not own a block-layout paint layer.
      // Their parent style can still change, without creating a text layer.
      if (!layerNodes) {
        layerNodes = new Set();
        for (const record of layout.boxes) if (!record.inline) layerNodes.add(record.nodeId);
      }
      if (layerNodes.has(id)) {
        // A relative/absolute box already owns a layer even at opacity 1.
        // Its opacity can change context ownership without adding/removing
        // layers or touching containing blocks and geometric coordinates.
        if (node.type === 'root' || !['relative', 'absolute'].includes(before.position) || before.position !== after.position
          // Layout can blockify inline flex/grid items. Without those flags,
          // their transform could appear to stop creating a context here.
          || !transformableBox(node)
          || (before.opacity < 1) === (after.opacity < 1)) return null;
        contexts.set(id, stackingContext(node));
      }
    }
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
      } else if (key === "visibility") {
        // Hidden content keeps its boxes and line breaks. Display-list
        // effects use the new tree to rebuild paint, hits and visible-child
        // overrides. Keep tables conservative: collapse can change metrics
        // there, and is currently normalized to hidden by computed style.
        if (!["visible", "hidden"].includes(before[key]) || !["visible", "hidden"].includes(after[key])
          || tableDisplay(before.display) || tableDisplay(after.display)) return null;
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
  const layers = contexts.size ? repaintLayerContexts(layout, previous, next, contexts) : null;
  if (contexts.size && !layers) return null;
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
    // Inline SVG is a replaced element: paths and paints do not change its
    // outer geometry. The comparison above still checks intrinsic sizes and
    // ratio, while the painter clips the new payload to this retained box.
    let updated = style && style !== record.style ? { ...record, style } : null;
    if (record.type === "image" && record.svg) {
      const svg = next.nodesById.get(record.nodeId).svg;
      if (svg !== record.svg) (updated ??= { ...record }).svg = svg;
    }
    const layer = layers?.get(record.layer);
    if (layer && layer !== record.layer) (updated ??= { ...record }).layer = layer;
    return updated ? Object.freeze(updated) : record;
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

/** Change only existing positioned layers' context flags and ancestry. */
function repaintLayerContexts(layout, previous, tree, contexts) {
  const layers = new Set(), owners = new Map();
  for (const record of [...layout.boxes, ...layout.fragments]) {
    for (let layer = record.layer; layer && !layers.has(layer); layer = layer.parent) layers.add(layer);
  }
  let root;
  for (const layer of layers) {
    if (layer.nodeId == null) {
      if (root || layer.parent || !layer.context) return null;
      root = layer;
    } else {
      if (owners.has(layer.nodeId)) return null;
      owners.set(layer.nodeId, layer);
    }
  }
  if (!root || [...contexts.keys()].some(id => !owners.has(id)
    || owners.get(id).context !== stackingContext(previous.nodesById.get(id)))) return null;
  const parents = new Map();
  const visit = node => {
    for (const child of node.children) {
      parents.set(child.id, node.id);
      visit(child);
    }
  };
  visit(tree.root);
  const parentContext = (layer, changed) => {
    for (let id = parents.get(layer.nodeId); id !== undefined; id = parents.get(id)) {
      const ancestor = owners.get(id);
      if (ancestor && (changed ? contexts.get(id) ?? ancestor.context : ancestor.context)) return ancestor;
    }
    return root;
  };
  // Do not guess at anonymous or unusual box-tree ownership. Only reuse
  // geometry when render ancestry exactly explains the existing layer graph.
  for (const layer of owners.values()) if (parentContext(layer, false) !== layer.parent) return null;
  const updated = new Map([[root, root]]);
  const remap = layer => {
    if (updated.has(layer)) return updated.get(layer);
    const parent = remap(parentContext(layer, true));
    const context = contexts.get(layer.nodeId) ?? layer.context;
    const next = parent === layer.parent && context === layer.context ? layer
      : Object.freeze({ ...layer, parent, context });
    updated.set(layer, next);
    return next;
  };
  for (const layer of owners.values()) remap(layer);
  return updated;
}

function tableDisplay(display) {
  return display === "inline-table" || display?.startsWith("table");
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
