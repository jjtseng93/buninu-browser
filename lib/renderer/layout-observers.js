/**
 * Per-document layout observers. A layout/scroll notification schedules one
 * measurement pass for all observers; page callbacks run only after every
 * target has been measured, avoiding a layout flush for each lazy image.
 * Geometry comes from the renderer, never from Happy DOM's zero-size boxes.
 */
export function createLayoutObservers({ nodeOf, boundsOf, computedStyle, viewport, schedule, cancel, call, now }) {
  const intersections = new Set();
  const resizes = new Set();
  let pending = null;
  let measuring = false;
  let disposed = false;
  let lastGeometry = null;

  const queue = () => {
    if (disposed || measuring || pending !== null || (!intersections.size && !resizes.size)) return;
    pending = schedule(flush);
  };
  function flush() {
    pending = null;
    if (disposed) return;
    measuring = true;
    const deliveries = [];
    // Multiple observers commonly watch the same ancestor or target.
    const bounds = new Map();
    const styles = new Map();
    const rectOf = (node) => {
      if (!bounds.has(node)) bounds.set(node, node?.isConnected ? boundsOf(node) : null);
      return bounds.get(node);
    };
    const styleOf = (node) => {
      if (!styles.has(node)) styles.set(node, computedStyle(node));
      return styles.get(node);
    };
    try {
      for (const observer of resizes) {
        const state = resizeStates.get(observer);
        const entries = [];
        for (const [node, target] of state.targets) {
          const rect = rectOf(node);
          const style = rect ? styleOf(node) : null;
          const border = style?.borderWidths ?? ZERO_EDGES;
          const padding = style?.padding ?? ZERO_EDGES;
          const width = Math.max(0, (rect?.width ?? 0) - sum(border, 1, 3) - sum(padding, 1, 3));
          const height = Math.max(0, (rect?.height ?? 0) - sum(border, 0, 2) - sum(padding, 0, 2));
          const scale = viewport().devicePixelRatio || 1;
          const entry = {
            target: target.wrapper,
            contentRect: rectangle({ left: number(padding[3]), top: number(padding[0]), width, height }),
            borderBoxSize: [size(rect?.width ?? 0, rect?.height ?? 0)],
            contentBoxSize: [size(width, height)],
            devicePixelContentBoxSize: [size(Math.round(width * scale), Math.round(height * scale))],
          };
          const selected = target.box === "border-box" ? entry.borderBoxSize[0]
            : target.box === "device-pixel-content-box" ? entry.devicePixelContentBoxSize[0] : entry.contentBoxSize[0];
          if (!target.last || selected.inlineSize !== target.last.inlineSize || selected.blockSize !== target.last.blockSize) {
            target.last = selected;
            entries.push(entry);
          }
        }
        if (entries.length) deliveries.push([state.callback, observer, entries]);
      }
      for (const observer of intersections) {
        const state = intersectionStates.get(observer);
        const rootNode = nodeOf(state.root);
        const screen = viewport();
        const rootRect = rootNode?.nodeType === 1 ? rectOf(rootNode) : { left: 0, top: 0, width: screen.width, height: screen.height };
        const rootBounds = rootRect ? marginRect(rectangle(rootRect), state.margin) : rectangle(ZERO_RECT);
        for (const [node, target] of state.targets) {
          const raw = rectOf(node);
          const boundingClientRect = rectangle(raw ?? ZERO_RECT);
          let intersection = raw && rootRect && (rootNode?.nodeType !== 1 || rootNode.contains(node))
            ? boundingClientRect : null;
          // Clip through scrolling/overflow ancestors before the root.
          for (let ancestor = node.parentElement; intersection && ancestor && ancestor !== rootNode; ancestor = ancestor.parentElement) {
            const style = styleOf(ancestor);
            if (style?.overflowX === "clip" || style?.overflowY === "clip") {
              const clip = rectOf(ancestor);
              intersection = clip ? intersect(intersection, rectangle(clip), style.overflowX === "clip", style.overflowY === "clip") : null;
            }
          }
          if (intersection) intersection = intersect(intersection, rootBounds);
          const isIntersecting = intersection !== null;
          const area = boundingClientRect.width * boundingClientRect.height;
          const ratio = area ? (intersection ? intersection.width * intersection.height / area : 0) : (isIntersecting ? 1 : 0);
          const thresholdIndex = state.thresholds.findIndex((threshold) => threshold > ratio);
          const index = thresholdIndex === -1 ? state.thresholds.length : thresholdIndex;
          if (target.index !== index || target.intersecting !== isIntersecting) {
            target.index = index;
            target.intersecting = isIntersecting;
            state.records.push({ target: target.wrapper, time: now(), isIntersecting, intersectionRatio: ratio,
              boundingClientRect, intersectionRect: intersection ?? rectangle(ZERO_RECT), rootBounds });
          }
        }
        if (state.records.length) deliveries.push([state.callback, observer, state.records.splice(0)]);
      }
    } finally {
      measuring = false;
    }
    for (const [callback, observer, entries] of deliveries) call(callback, observer, [entries, observer]);
  }

  const element = (target) => {
    const node = nodeOf(target);
    if (node?.nodeType !== 1) throw new TypeError("The target must be an Element.");
    return node;
  };
  const intersectionStates = new WeakMap();
  class IntersectionObserver {
    constructor(callback, options = {}) {
      if (typeof callback !== "function") throw new TypeError("IntersectionObserver callback must be a function.");
      const root = options?.root ?? null;
      const rootNode = root === null ? null : nodeOf(root);
      if (root !== null && rootNode?.nodeType !== 1 && rootNode?.nodeType !== 9) {
        throw new TypeError("IntersectionObserver root must be an Element or Document.");
      }
      const margin = parseMargin(options?.rootMargin ?? "0px");
      const raw = options?.threshold ?? 0;
      const thresholds = (typeof raw === "object" && raw !== null ? Array.from(raw, Number) : [Number(raw)]).sort((a, b) => a - b);
      if (thresholds.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
        throw new RangeError("IntersectionObserver thresholds must be between 0 and 1.");
      }
      if (!thresholds.length) thresholds.push(0);
      intersectionStates.set(this, { callback, root, margin, thresholds: Object.freeze(thresholds), targets: new Map(), records: [] });
    }
    get root() { return intersectionState(this).root; }
    get rootMargin() { return intersectionState(this).margin.map(({ value, unit }) => `${value}${unit}`).join(" "); }
    get thresholds() { return intersectionState(this).thresholds; }
    observe(target) {
      const state = intersectionState(this);
      const node = element(target);
      if (state.targets.has(node)) return;
      state.targets.set(node, { wrapper: target, index: -1, intersecting: false });
      intersections.add(this);
      queue();
    }
    unobserve(target) {
      const state = intersectionState(this);
      state.targets.delete(element(target));
      if (!state.targets.size) intersections.delete(this);
    }
    disconnect() {
      intersectionState(this).targets.clear();
      intersections.delete(this);
    }
    takeRecords() { return intersectionState(this).records.splice(0); }
  }
  const intersectionState = (observer) => {
    const state = intersectionStates.get(observer);
    if (!state) throw new TypeError("Illegal invocation");
    return state;
  };

  const resizeStates = new WeakMap();
  class ResizeObserver {
    constructor(callback) {
      if (typeof callback !== "function") throw new TypeError("ResizeObserver callback must be a function.");
      resizeStates.set(this, { callback, targets: new Map() });
    }
    observe(target, options = {}) {
      const state = resizeState(this);
      const node = element(target);
      const box = String(options?.box ?? "content-box");
      if (!["content-box", "border-box", "device-pixel-content-box"].includes(box)) throw new TypeError("Invalid ResizeObserver box option.");
      if (state.targets.get(node)?.box === box) return;
      state.targets.set(node, { wrapper: target, box, last: size(0, 0) });
      resizes.add(this);
      queue();
    }
    unobserve(target) {
      const state = resizeState(this);
      state.targets.delete(element(target));
      if (!state.targets.size) resizes.delete(this);
    }
    disconnect() {
      resizeState(this).targets.clear();
      resizes.delete(this);
    }
  }
  const resizeState = (observer) => {
    const state = resizeStates.get(observer);
    if (!state) throw new TypeError("Illegal invocation");
    return state;
  };

  return {
    IntersectionObserver, ResizeObserver,
    update(...geometry) {
      // Video frames and screenshots can repaint without changing layout.
      // They must not cause an O(targets × ancestors) observer pass each time.
      if (geometry.length && lastGeometry && geometry.every((value, index) => value === lastGeometry[index])) return;
      lastGeometry = geometry;
      queue();
    },
    dispose() {
      disposed = true;
      if (pending !== null) cancel(pending);
      pending = null;
      intersections.clear();
      resizes.clear();
    },
  };
}

const ZERO_RECT = Object.freeze({ left: 0, top: 0, width: 0, height: 0 });
const ZERO_EDGES = Object.freeze([0, 0, 0, 0]);
const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
const sum = (edges, a, b) => number(edges[a]) + number(edges[b]);
const size = (inlineSize, blockSize) => ({ inlineSize, blockSize });
function rectangle({ left, top, width, height }) {
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height,
    toJSON() { return { x: this.x, y: this.y, width: this.width, height: this.height,
      top: this.top, right: this.right, bottom: this.bottom, left: this.left }; } };
}
function parseMargin(value) {
  const tokens = String(value).trim().split(/\s+/);
  if (!tokens.length || tokens.length > 4) throw new DOMException("Invalid rootMargin.", "SyntaxError");
  const parts = tokens.map((token) => {
    const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(px|%)$/.exec(token);
    if (!match) throw new DOMException("rootMargin values must be pixels or percent.", "SyntaxError");
    return { value: Number(match[1]), unit: match[2] };
  });
  const [top, right = top, bottom = top, left = right] = parts;
  return [top, right, bottom, left];
}
function marginRect(rect, margin) {
  const [top, right, bottom, left] = margin.map(({ value, unit }) => unit === "%" ? value * rect.width / 100 : value);
  return rectangle({ left: rect.left - left, top: rect.top - top, width: rect.width + left + right, height: rect.height + top + bottom });
}
function intersect(a, b, x = true, y = true) {
  const left = x ? Math.max(a.left, b.left) : a.left;
  const right = x ? Math.min(a.right, b.right) : a.right;
  const top = y ? Math.max(a.top, b.top) : a.top;
  const bottom = y ? Math.min(a.bottom, b.bottom) : a.bottom;
  return left <= right && top <= bottom ? rectangle({ left, top, width: right - left, height: bottom - top }) : null;
}
