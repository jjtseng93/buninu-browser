const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "LABEL", "SELECT", "SUMMARY", "TEXTAREA", "VIDEO"]);
// Form controls and labels are hit over their whole box, not only where text
// is drawn (an unchecked checkbox or an empty field has none; a block label
// is clickable beside its text).
const CONTROL_TAGS = new Set(["BUTTON", "INPUT", "LABEL", "SELECT", "TEXTAREA"]);

export function interactiveRegions(tree, layout, scroll = { x: 0, y: 0 }, viewport = {}) {
  const regions = [];
  const byElement = new Map();

  for (const fragment of layout.fragments) {
    for (const run of fragment.runs) {
      const renderNode = tree.nodesById.get(run.nodeId);
      const element = closestInteractive(renderNode?.domNode);
      if (!element) continue;
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
    const element = tree.nodesById.get(box.nodeId)?.domNode;
    if (!element || element.nodeType !== 1 || !CONTROL_TAGS.has(element.tagName)) continue;
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
  const hits = interactiveRegions(tree, layout, scroll, viewport).filter((region) =>
    region.rects.some((rect) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom));
  return hits.find((region) => !hits.some((other) => other !== region && region.element.contains(other.element))) ?? null;
}

/** Returns the content-coordinate bounds contributed by an element's text descendants. */
export function elementBounds(tree, layout, element) {
  const rects = [];
  for (const fragment of layout.fragments) {
    for (const run of fragment.runs) {
      const renderNode = tree.nodesById.get(run.nodeId);
      const owner = renderNode?.domNode?.nodeType === 1
        ? renderNode.domNode
        : renderNode?.domNode?.parentElement;
      if (!owner || (owner !== element && !element.contains(owner))) continue;
      rects.push({
        left: run.x,
        top: fragment.y,
        right: run.x + run.width,
        bottom: fragment.y + fragment.height,
      });
    }
  }
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return Object.freeze({ left, top, right, bottom, width: right - left, height: bottom - top });
}

function closestInteractive(node) {
  for (let current = node?.nodeType === 1 ? node : node?.parentElement; current; current = current.parentElement) {
    if (INTERACTIVE_TAGS.has(current.tagName) || current.hasAttribute("onclick") || current.hasAttribute("tabindex")) {
      return current;
    }
  }
  return null;
}
