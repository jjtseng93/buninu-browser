import { hitTarget } from "../paint/display-list.js";

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

  for (const fragment of layout.fragments) {
    for (const run of fragment.runs) {
      const renderNode = tree.nodesById.get(run.nodeId);
      const element = closestInteractive(renderNode?.domNode);
      if (!element || !hittable(renderNode)) continue;
      const top = fragment.y - scroll.y;
      const left = run.x - scroll.x;
      const right = left + run.width;
      const bottom = top + fragment.height;
      if (right <= 0 || bottom <= 0 || left >= (viewport.width ?? Infinity) || top >= (viewport.height ?? Infinity)) {
        continue;
      }
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
    const renderNode = tree.nodesById.get(box.nodeId);
    const element = renderNode?.domNode;
    if (!element || element.nodeType !== 1 || !CONTROL_TAGS.has(element.tagName) || !hittable(renderNode)) continue;
    const top = box.y - scroll.y;
    const left = box.x - scroll.x;
    const right = left + box.width;
    const bottom = top + box.height;
    if (box.width <= 0 || box.height <= 0 || right <= 0 || bottom <= 0
      || left >= (viewport.width ?? Infinity) || top >= (viewport.height ?? Infinity)) {
      continue;
    }
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
  const deepest = hits.filter((region) => !hits.some((other) => other !== region && region.element.contains(other.element)));
  return deepest.sort((left, right) => left.area - right.area)[0] ?? null;
}

/**
 * The element a pointer event at a viewport point targets: the topmost one
 * painted there (its own box or its text), skipping those that take no
 * pointer events. Null when the point hits nothing.
 */
export function elementAtPoint(tree, displayList, x, y, scroll) {
  const domNode = renderNodeAtPoint(tree, displayList, x, y, scroll)?.domNode;
  return domNode?.nodeType === 1 ? domNode : domNode?.parentElement ?? null;
}

/** All hit elements in reverse paint order, coalescing adjacent text/box hits. */
export function elementsAtPoint(tree, displayList, x, y, scroll) {
  const accepts = hitTestable(tree), elements = [];
  hitTarget(displayList, x, y, scroll, id => {
    const render = tree.nodesById.get(id);
    if (accepts(render)) {
      const node = render?.domNode;
      const element = node?.nodeType === 1 ? node : node?.parentElement;
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

function geometryIndex(tree, layout) {
  let index = geometryIndexes.get(layout);
  if (index?.tree === tree) return index;
  const byNode = new Map(), boxes = new WeakMap();
  for (const box of layout.boxes) if (!box.inline && !byNode.has(box.nodeId)) byNode.set(box.nodeId, box);
  for (const node of tree.nodesById.values()) {
    if (node.pseudo || node.domNode?.nodeType !== 1 || boxes.has(node.domNode)) continue;
    // The first actual render node is authoritative, even if it is inline.
    const box = byNode.get(node.id);
    boxes.set(node.domNode, box ? { node, box } : null);
  }
  index = { tree, boxes, textBounds: null };
  geometryIndexes.set(layout, index);
  return index;
}

/** The first real render node and block box belonging to an element. */
export function elementBox(tree, layout, element) {
  return tree && layout ? geometryIndex(tree, layout).boxes.get(element) ?? null : null;
}

/** Untransformed box for client metrics, including inline replaced content.
 * Keep elementBox's block-only contract for scrolling and offset consumers. */
export function elementClientBox(tree, layout, element) {
  if (!tree || !layout) return null;
  const index = geometryIndex(tree, layout);
  if (!index.clientBoxes) {
    const boxes = new Map(), images = new Map(), clients = new WeakMap();
    for (const box of layout.boxes) if (!boxes.has(box.nodeId)) boxes.set(box.nodeId, box);
    for (const fragment of layout.fragments) for (const run of fragment.runs) {
      if (run.type === "image" && !images.has(run.nodeId)) images.set(run.nodeId, run);
    }
    for (const node of tree.nodesById.values()) {
      if (node.pseudo || node.domNode?.nodeType !== 1 || clients.has(node.domNode)) continue;
      let box = boxes.get(node.id);
      const style = node.style;
      if (style?.display === "none" || style?.display === "contents" || node.type === "contents"
        || box?.inline && node.type !== "image") box = null;
      else if (!box && node.type === "image") {
        const run = images.get(node.id);
        if (run) {
          // Undecorated inline images have only a content run. Their numeric
          // padding uses the same unscaled inline insets as the layout pass.
          const padding = (node.style?.padding ?? [0,0,0,0]).map(value => Number.isFinite(value) ? value : 0);
          const border = node.style?.borderWidths ?? [0,0,0,0];
          box = {x:run.x-padding[3]-border[3],y:run.y-padding[0]-border[0],
            width:run.width+padding[1]+padding[3]+border[1]+border[3],
            height:run.height+padding[0]+padding[2]+border[0]+border[2],style:node.style};
        }
      }
      clients.set(node.domNode, box ? {node,box} : null);
    }
    index.clientBoxes = clients;
  }
  return index.clientBoxes.get(element) ?? null;
}

function textBoundsIndex(tree, layout) {
  const bounds = new WeakMap();
  for (const fragment of layout.fragments) {
    for (const run of fragment.runs) {
      const renderNode = tree.nodesById.get(run.nodeId);
      const owner = renderNode?.domNode?.nodeType === 1
        ? renderNode.domNode
        : renderNode?.domNode?.parentElement;
      if (!owner) continue;
      // A replaced element (an image) spans its own box, not its line's height.
      const replaced = run.type === "image" && run.y != null;
      const top = replaced ? run.y : fragment.y;
      const right = run.x + run.width;
      const bottom = top + (replaced ? run.height : fragment.height);
      for (let ancestor = owner; ancestor; ancestor = ancestor.parentElement) {
        const rect = bounds.get(ancestor);
        if (rect) {
          rect.left = Math.min(rect.left, run.x);
          rect.top = Math.min(rect.top, top);
          rect.right = Math.max(rect.right, right);
          rect.bottom = Math.max(rect.bottom, bottom);
        } else bounds.set(ancestor, { left: run.x, top, right, bottom });
      }
    }
  }
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
    const element = domNode?.nodeType === 1 ? domNode : domNode?.parentElement;
    const style = (renderNode?.pseudo ? renderNode.style : null) ?? styles.get(element);
    return !style || (style.visibility !== "hidden" && style.pointerEvents !== "none");
  };
  hitTestableIndexes.set(tree, accepts);
  return accepts;
}

function closestInteractive(node) {
  for (let current = node?.nodeType === 1 ? node : node?.parentElement; current; current = current.parentElement) {
    if (INTERACTIVE_TAGS.has(current.tagName) || current.hasAttribute("onclick") || current.hasAttribute("tabindex")) {
      return current;
    }
  }
  return null;
}
