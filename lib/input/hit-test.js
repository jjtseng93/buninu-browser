import { hitTarget } from "../paint/display-list.js";
import {composedParentElement, composedContains} from '../happy-dom/shadow-tree.js';

// An iframe takes clicks for its own document (the renderer forwards them).
const INTERACTIVE_TAGS = new Set(["A", "AUDIO", "BUTTON", "IFRAME", "INPUT", "LABEL", "SELECT", "SUMMARY", "TEXTAREA", "VIDEO"]);
// Form controls, labels and iframes are hit over their whole box, not only
// where text is drawn (an unchecked checkbox or an empty field has none; a
// block label is clickable beside its text).
const CONTROL_TAGS = new Set(["AUDIO", "BUTTON", "IFRAME", "INPUT", "LABEL", "SELECT", "TEXTAREA"]);

export function interactiveRegions(tree, layout, scroll = { x: 0, y: 0 }, viewport = {}) {
  const regions = [];
  const byElement = new Map();
  const hittable = hitTestable(tree);
  // DOM interaction attributes can change while layout stays identical. Share
  // ancestor walks only during this synchronous collection, never across input
  // events or hint requests, including cached misses on noninteractive parents.
  const interactiveOwners = new Map();

  for (const fragment of layout.fragments) {
    for (const run of fragment.runs) {
      const top = fragment.y - scroll.y;
      const left = run.x - scroll.x;
      const right = left + run.width;
      const bottom = top + fragment.height;
      if (right <= 0 || bottom <= 0 || left >= (viewport.width ?? Infinity) || top >= (viewport.height ?? Infinity)) {
        continue;
      }
      const renderNode = tree.nodesById.get(run.nodeId);
      const element = closestInteractive(renderNode?.domNode, interactiveOwners);
      if (!element || !hittable(renderNode)) continue;
      const rect = Object.freeze({ left, top, right, bottom, width: run.width, height: fragment.height });
      let region = byElement.get(element);
      if (!region) {
        region = { element, rects: [] };
        byElement.set(element, region);
        regions.push(region);
      }
      region.rects.push(rect);
    }
  }

  for (const box of layout.boxes ?? []) {
    const top = box.y - scroll.y;
    const left = box.x - scroll.x;
    const right = left + box.width;
    const bottom = top + box.height;
    if (box.width <= 0 || box.height <= 0 || right <= 0 || bottom <= 0
      || left >= (viewport.width ?? Infinity) || top >= (viewport.height ?? Infinity)) {
      continue;
    }
    const renderNode = tree.nodesById.get(box.nodeId);
    const element = renderNode?.domNode;
    if (!element || element.nodeType !== 1 || !CONTROL_TAGS.has(element.tagName) || !hittable(renderNode)) continue;
    const rect = Object.freeze({ left, top, right, bottom, width: box.width, height: box.height });
    let region = byElement.get(element);
    if (!region) {
      region = { element, rects: [] };
      byElement.set(element, region);
      regions.push(region);
    }
    region.rects.push(rect);
  }

  return regions.map((region) => Object.freeze({
    element: region.element,
    rects: Object.freeze(region.rects),
  }));
}

/** The innermost interactive element under a point (a checkbox before its label). */
export function hitTest(tree, layout, x, y, scroll, viewport) {
  const hits = interactiveRegions(tree, layout, scroll, viewport).map((region) => ({
    ...region,
    area: Math.min(...region.rects.filter((rect) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom)
      .map((rect) => rect.width * rect.height)),
  })).filter((region) => Number.isFinite(region.area));
  const deepest = hits.filter((region) => !hits.some((other) => other !== region && composedContains(region.element, other.element)));
  return deepest.sort((left, right) => left.area - right.area)[0] ?? null;
}

/**
 * The element a pointer event at a viewport point targets: the topmost one
 * painted there (its own box or its text), skipping those that take no
 * pointer events. Null when the point hits nothing.
 */
export function elementAtPoint(tree, displayList, x, y, scroll) {
  const domNode = renderNodeAtPoint(tree, displayList, x, y, scroll)?.domNode;
  return domNode?.nodeType === 1 ? domNode : composedParentElement(domNode);
}

/** All hit elements in reverse paint order, coalescing adjacent text/box hits. */
export function elementsAtPoint(tree, displayList, x, y, scroll) {
  const accepts = hitTestable(tree), elements = [];
  hitTarget(displayList, x, y, scroll, id => {
    const render = tree.nodesById.get(id);
    if (accepts(render)) {
      const node = render?.domNode;
      const element = node?.nodeType === 1 ? node : composedParentElement(node);
      if (element && elements.at(-1) !== element) elements.push(element);
    }
    return true; // Keep scanning the existing transform/clip-aware hit list.
  });
  return elements;
}

/** Also preserves generated controls, whose owning DOM element differs from their render node. */
export function renderNodeAtPoint(tree, displayList, x, y, scroll) {
  const hittable = hitTestable(tree);
  const nodeId = hitTarget(displayList, x, y, scroll, (id) => !hittable(tree.nodesById.get(id)));
  return nodeId == null ? null : tree.nodesById.get(nodeId) ?? null;
}

// Layout objects are immutable after the layout pass. Keeping their lookup
// tables under a weak key releases old document nodes when a layout is dropped.
const geometryIndexes = new WeakMap();

// Geometry readers want the first local box, unlike pointer hit testing's
// reverse paint order. Index the immutable hit array, shared by image-only
// display-list updates, without retaining discarded lists or documents.
const localHitIndexes = new WeakMap();
export function localBoxHit(displayList, nodeId) {
  const hits = displayList?.hits;
  if (!hits) return undefined;
  let index = localHitIndexes.get(hits);
  if (!index) {
    if (!Object.isFrozen(hits)) return hits.find(hit => hit.nodeId === nodeId && hit.localRect);
    index = new Map();
    for (const hit of hits) if (hit.localRect && !index.has(hit.nodeId)) index.set(hit.nodeId, hit);
    localHitIndexes.set(hits, index);
  }
  return index.get(nodeId);
}

function geometryIndex(tree, layout) {
  let index = geometryIndexes.get(layout);
  if (index?.tree === tree) return index;
  index = { tree, boxes: null, textBounds: null };
  geometryIndexes.set(layout, index);
  return index;
}

function blockBoxes(tree, layout) {
  const byNode = new Map(), boxes = new WeakMap();
  for (const box of layout.boxes) if (!box.inline && !byNode.has(box.nodeId)) byNode.set(box.nodeId, box);
  for (const node of tree.nodesById.values()) {
    if (node.pseudo || node.domNode?.nodeType !== 1 || boxes.has(node.domNode)) continue;
    // The first actual render node is authoritative, even if it is inline.
    const box = byNode.get(node.id);
    boxes.set(node.domNode, box ? { node, box } : null);
  }
  return boxes;
}

/** The first real render node and block box belonging to an element. */
export function elementBox(tree, layout, element) {
  if (!tree || !layout) return null;
  const index = geometryIndex(tree, layout);
  index.boxes ??= blockBoxes(tree, layout);
  return index.boxes.get(element) ?? null;
}

/** Untransformed box for client metrics, including inline replaced content.
 * Keep elementBox's block-only contract for scrolling and offset consumers. */
export function elementClientBox(tree, layout, element) {
  if (!tree || !layout) return null;
  const index = geometryIndex(tree, layout);
  if (!index.clientBoxes) {
    const boxes = new Map(), clients = new WeakMap();
    for (const box of layout.boxes) if (!boxes.has(box.nodeId)) boxes.set(box.nodeId, box);
    for (const node of tree.nodesById.values()) {
      if (node.pseudo || node.domNode?.nodeType !== 1 || clients.has(node.domNode)) continue;
      let box = boxes.get(node.id);
      const style = node.style;
      if (style?.display === "none" || style?.display === "contents" || node.type === "contents"
        || box?.inline && node.type !== "image") box = null;
      else if (!box && node.type === "image") {
        // Retain the node until a caller actually requests its fragment box.
        clients.set(node.domNode, {node, box: null});
        continue;
      }
      clients.set(node.domNode, box ? {node,box} : null);
    }
    index.clientBoxes = clients;
  }
  const entry = index.clientBoxes.get(element);
  if (!entry || entry.box) return entry ?? null;
  // Ordinary geometry reads need no text or image fragment scan.
  if (!index.clientImages) {
    index.clientImages = new Map();
    for (const fragment of layout.fragments) for (const run of fragment.runs) {
      if (run.type === "image" && !index.clientImages.has(run.nodeId)) index.clientImages.set(run.nodeId, run);
    }
  }
  const run = index.clientImages.get(entry.node.id);
  if (!run) {
    index.clientBoxes.set(element, null);
    return null;
  }
  const style = entry.node.style;
  const padding = style?.padding, border = style?.borderWidths;
  // Only resolved numeric padding participates in inline replaced geometry.
  const inset = side => (Number.isFinite(padding?.[side]) ? padding[side] : 0) + (border?.[side] ?? 0);
  const left = inset(3), top = inset(0);
  entry.box = {x:run.x-left, y:run.y-top,
    width:run.width+left+inset(1), height:run.height+top+inset(2), style};
  return entry;
}

function textBoundsIndex(tree, layout) {
  const bounds = new WeakMap();
  let owner = null, left, top, right, bottom;
  function flush() {
    for (let node = owner; node; node = composedParentElement(node)) {
      const rect = bounds.get(node);
      if (!rect) {
        bounds.set(node, {left, top, right, bottom});
        continue;
      }
      // Every earlier union at this node already reached its ancestors.
      if (rect.left <= left && rect.top <= top && rect.right >= right && rect.bottom >= bottom) break;
      rect.left = Math.min(rect.left, left);
      rect.top = Math.min(rect.top, top);
      rect.right = Math.max(rect.right, right);
      rect.bottom = Math.max(rect.bottom, bottom);
    }
  }
  // Consecutive runs of wrapped text often belong to one element. Merge
  // them before propagating their bounds up the composed tree.
  function extend(next, x1, y1, x2, y2) {
    if (owner === next) {
      left = Math.min(left, x1);
      top = Math.min(top, y1);
      right = Math.max(right, x2);
      bottom = Math.max(bottom, y2);
    } else {
      flush();
      owner = next;
      left = x1;
      top = y1;
      right = x2;
      bottom = y2;
    }
  }
  for (const fragment of layout.fragments) {
    // An empty inline element is a zero-width box where the line placed it: its font's
    // content area on the baseline, or nothing tall when no line holds it.
    for (const anchor of fragment.anchors ?? []) {
      const owner = tree.nodesById.get(anchor.nodeId)?.domNode;
      const top = anchor.y ?? fragment.y, height = anchor.height ?? fragment.height;
      if (owner?.nodeType === 1) extend(owner, anchor.x, top, anchor.x, top + height);
    }
    for (const run of fragment.runs) {
      const renderNode = tree.nodesById.get(run.nodeId);
      const owner = renderNode?.domNode?.nodeType === 1
        ? renderNode.domNode
        : composedParentElement(renderNode?.domNode);
      if (!owner) continue;
      // A replaced element (an image) spans its own box, not its line's height.
      const replaced = run.type === "image" && run.y != null;
      const top = replaced ? run.y : fragment.y;
      const right = run.x + run.width;
      const bottom = top + (replaced ? run.height : fragment.height);
      extend(owner, run.x, top, right, bottom);
    }
  }
  flush();
  return bounds;
}

/** Returns the content-coordinate bounds contributed by an element's text descendants. */
export function elementBounds(tree, layout, element) {
  const index = geometryIndex(tree, layout);
  index.textBounds ??= textBoundsIndex(tree, layout);
  const rect = index.textBounds.get(element);
  if (!rect) return null;
  if (rect.width === undefined) {
    rect.width = rect.right - rect.left;
    rect.height = rect.bottom - rect.top;
    Object.freeze(rect);
  }
  return rect;
}

/**
 * Whether a render node takes clicks: not when its element is
 * visibility: hidden or pointer-events: none (both inherited, so a visible
 * or pointer-events: auto descendant still does). Text uses its element's style.
 */
const hitTestableIndexes = new WeakMap();
function hitTestable(tree) {
  const cached = hitTestableIndexes.get(tree);
  if (cached) return cached;
  const styles = new Map();
  for (const node of tree.nodesById.values()) {
    if (node.domNode?.nodeType === 1 && node.style && !node.pseudo && !styles.has(node.domNode)) {
      styles.set(node.domNode, node.style);
    }
  }
  const accepts = (renderNode) => {
    const domNode = renderNode?.domNode;
    const element = domNode?.nodeType === 1 ? domNode : composedParentElement(domNode);
    const style = (renderNode?.pseudo ? renderNode.style : null) ?? styles.get(element);
    return !style || (style.visibility !== "hidden" && style.pointerEvents !== "none");
  };
  hitTestableIndexes.set(tree, accepts);
  return accepts;
}

function closestInteractive(node, cache) {
  if (!node) return null;
  if (cache.has(node)) return cache.get(node);
  const visited = node.nodeType === 1 ? [] : [node];
  let result = null;
  for (let current = node?.nodeType === 1 ? node : composedParentElement(node); current; current = composedParentElement(current)) {
    if (cache.has(current)) { result = cache.get(current); break; }
    visited.push(current);
    if (INTERACTIVE_TAGS.has(current.tagName) || current.hasAttribute("onclick") || current.hasAttribute("tabindex")) {
      result = current;
      break;
    }
  }
  for (const current of visited) cache.set(current, result);
  return result;
}
