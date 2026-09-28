const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "SUMMARY", "TEXTAREA"]);

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

  return regions.map((region) => Object.freeze({
    element: region.element,
    rects: Object.freeze(region.rects),
  }));
}

export function hitTest(tree, layout, x, y, scroll, viewport) {
  for (const region of interactiveRegions(tree, layout, scroll, viewport)) {
    if (region.rects.some((rect) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom)) {
      return region;
    }
  }
  return null;
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
