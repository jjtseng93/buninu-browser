/**
 * Box-tree layout: block formatting contexts with margin collapsing, inline
 * formatting contexts with line boxes, atomic inlines, and flex layout
 * (CSS Flexbox §9: flexible length resolution, wrapping, alignment; column
 * containers currently stack items without main-axis flexing), and grid
 * layout (CSS Grid 2 §8 placement and §12 track sizing, without named lines,
 * areas, or column auto-flow). Relative, absolute and fixed positioning
 * place boxes after flow layout; positioned boxes get their own paint layer.
 *
 * The block/inline structure follows concepts from Dropflow
 * (chearon/dropflow@13552695d3446ac68f39952ea89dc69c4499dde2, MIT,
 * src/layout-flow.ts): block containers hold either block-level boxes or one
 * inline formatting context, anonymous block boxes wrap inline runs between
 * blocks, and adjacent/parent-child margins collapse through margin struts.
 * The code is a project-owned implementation over RenderNode input.
 *
 * Output stays flat for painting and hit testing: `boxes` in paint (pre-)order
 * and `fragments` as positioned line boxes sorted by y.
 */
const ZERO_BOX = Object.freeze([0, 0, 0, 0]);
const ZERO_STRUT = Object.freeze({ positive: 0, negative: 0 });
const DEFAULT_ASCENT = 0.93;
const DEFAULT_CONTENT_HEIGHT = 1.17;

const ROOT_LAYER = Object.freeze({ z: 0, order: 0, context: true, parent: null });

export function layoutText(tree, options = {}) {
  const columns = positiveInteger(options.columns, 40);
  const x = finiteNumber(options.x, 16);
  const y = finiteNumber(options.y, 12);
  const columnWidth = positiveNumber(options.columnWidth, 13);
  const viewportWidth = positiveNumber(options.width, 0);
  const measureText = typeof options.measureText === "function"
    ? options.measureText
    : (text) => Bun.stringWidth(text) * columnWidth;
  const ctx = {
    tree,
    fragments: [],
    boxes: [],
    lineHeight: options.lineHeight == null ? null : positiveNumber(options.lineHeight, 31),
    fallbackLineHeight: 31,
    measure: cachedMeasure(measureText),
    metrics: cachedMetrics(options.fontMetrics),
    maxContent: new WeakMap(),
    minContent: new WeakMap(),
    // Paint layers: the root layer holds in-flow content; positioned boxes add
    // more. A layer with an integer z-index is a stacking context; `parent` is
    // the stacking context a layer is painted in (CSS 2 Appendix E).
    layer: ROOT_LAYER,
    stackingContext: ROOT_LAYER,
    layerCount: 1,
    initialContainingBlock: null,
  };

  containingBlocks = [];
  let root;
  try {
    root = buildBox(tree.root, inheritedFlags(tree.root, { preserve: false, wrap: true }));
  } finally {
    containingBlocks = null;
  }
  const containingWidth = options.measureText || viewportWidth
    ? Math.max(1, (viewportWidth || columns * columnWidth) - x * 2)
    : columns * columnWidth;
  ctx.initialContainingBlock = {
    x: 0,
    y: 0,
    width: viewportWidth || containingWidth + x * 2,
    height: positiveNumber(options.viewportHeight, 0),
  };
  // The root render node is <body>; the initial containing block (html)
  // establishes the BFC, so body margins collapse with its children's.
  const horizontal = resolveHorizontal(ctx, root, x, containingWidth, false);
  const rootY = y + strutValue(topStrut(root));
  const result = layoutBlock(ctx, root, horizontal.x, horizontal.width, rootY, collapsesThroughTop(root));
  const height = rootY + result.height + strutValue(bottomStrut(root));

  const fragments = ctx.fragments
    .map((fragment, order) => ({ fragment, order }))
    .sort((left, right) => left.fragment.y - right.fragment.y || left.order - right.order)
    .map(({ fragment }, index) => Object.freeze({ id: `${tree.generation}:${index}`, ...fragment }));
  const boxes = ctx.boxes.map((box) => Object.freeze(box));
  return Object.freeze({
    generation: tree.generation,
    columns,
    columnWidth,
    width: Math.max(viewportWidth, x + Math.max(0, ...boxes.map((box) => box.x + box.width))),
    height,
    boxes: Object.freeze(boxes),
    fragments: Object.freeze(fragments),
  });
}

// ---------------------------------------------------------------------------
// Box tree construction

// Absolutely positioned boxes register with their containing block while the
// box tree is built. Building is synchronous and scoped to layoutText.
let containingBlocks = null;

// Text nodes carry their parent's style, so only element boxes can be positioned.
const UNPOSITIONABLE = new Set(["root", "text", "line-break"]);

function isPositioned(node) {
  return !UNPOSITIONABLE.has(node.type) && ["relative", "absolute", "fixed", "sticky"].includes(node.style?.position);
}

function isOutOfFlow(node) {
  return !UNPOSITIONABLE.has(node.type) && ["absolute", "fixed"].includes(node.style?.position);
}

/** Builds an absolutely positioned box and hands it to its containing block. */
function outOfFlowBox(node, flags) {
  const holder = node.style.position === "fixed" ? containingBlocks[0] : containingBlocks.at(-1);
  const box = buildBox(node, inheritedFlags(node, flags), true);
  box.outOfFlow = true;
  holder.absolutes.push(box);
  return box;
}

function buildBox(node, flags, blockified = false) {
  const style = node.style ?? null;
  if (node.type === "image") {
    return { kind: "block", node, style, replaced: true, bfc: true, children: [], absolutes: [] };
  }
  const flex = ["flex", "inline-flex"].includes(node.type)
    ? style?.flexDirection === "column" ? "column" : "row"
    : null;
  const grid = ["grid", "inline-grid"].includes(node.type);
  const table = ["table", "inline-table"].includes(node.type);
  const box = {
    kind: "block",
    node,
    style,
    flex,
    grid,
    table: null,
    bfc: blockified || flex !== null || grid || table || isAtomic(node),
    // Atomic inlines are sized shrink-to-fit, so their main size is indefinite.
    shrinkToFit: isAtomic(node),
    children: [],
    absolutes: [],
  };
  const containing = node.type === "root" || isPositioned(node);
  if (containing) containingBlocks?.push(box);
  try {
    if (table) box.table = tableStructure(node, flags);
    else box.children = flex || grid ? flexItems(node, flags) : blockChildren(node, flags);
  } finally {
    if (containing) containingBlocks?.pop();
  }
  return box;
}

function blockChildren(node, flags) {
  const children = [];
  const openInlines = [];
  let items = [];
  const flush = () => {
    if (hasInlineContent(items)) children.push({ kind: "ifc", node, style: node.style ?? null, items });
    items = [];
  };

  function walk(child, childFlags) {
    if (isOutOfFlow(child)) {
      const box = outOfFlowBox(child, childFlags);
      // Between blocks the placeholder records the static position; inline
      // placeholders fall back to the containing block's origin.
      if (!openInlines.length && !hasInlineContent(items)) children.push({ kind: "placeholder", box });
    } else if (child.type === "text") {
      items.push(textItem(child, childFlags));
    } else if (child.type === "line-break") {
      items.push({ kind: "break", node: child });
    } else if (isBlockLevel(child)) {
      // A block inside an inline splits the inline around the block.
      for (const open of [...openInlines].reverse()) items.push({ kind: "close", node: open });
      flush();
      children.push(buildBox(child, inheritedFlags(child, childFlags)));
      for (const open of openInlines) items.push({ kind: "open", node: open, style: open.style ?? null });
    } else if (child.type === "image") {
      items.push({ kind: "image", node: child });
    } else if (isAtomic(child)) {
      items.push({ kind: "atomic", node: child, box: buildBox(child, inheritedFlags(child, childFlags)) });
    } else {
      items.push({ kind: "open", node: child, style: child.style ?? null });
      openInlines.push(child);
      const grandchildFlags = inheritedFlags(child, childFlags);
      for (const grandchild of child.children) walk(grandchild, grandchildFlags);
      openInlines.pop();
      items.push({ kind: "close", node: child });
    }
  }

  for (const child of node.children) walk(child, flags);
  flush();
  return children;
}

/**
 * Flex and grid items: every in-flow child element is blockified; each
 * contiguous run of non-white-space text becomes an anonymous item.
 */
function flexItems(node, flags) {
  const items = [];
  let text = [];
  const flush = () => {
    if (text.length) {
      items.push({
        kind: "block",
        node,
        style: null,
        anonymous: true,
        bfc: true,
        children: [{ kind: "ifc", node, style: node.style ?? null, items: text }],
      });
    }
    text = [];
  };
  for (const child of node.children) {
    if (child.type === "line-break") continue;
    if (child.type === "text") {
      if (child.text.trim()) text.push(textItem(child, flags));
      continue;
    }
    if (isOutOfFlow(child)) {
      outOfFlowBox(child, flags);
      continue;
    }
    flush();
    items.push(buildBox(child, inheritedFlags(child, flags), true));
  }
  flush();
  return items;
}

function textItem(node, flags) {
  return { kind: "text", node, style: node.style ?? null, text: node.text, preserve: flags.preserve, wrap: flags.wrap };
}

function inheritedFlags(node, flags) {
  const whiteSpace = node.style?.whiteSpace;
  if (whiteSpace) {
    return { preserve: ["pre", "pre-wrap"].includes(whiteSpace), wrap: !["pre", "nowrap"].includes(whiteSpace) };
  }
  if (node.tagName === "PRE") return { preserve: true, wrap: false };
  return flags;
}

// Table parts found outside a table are laid out as blocks.
const TABLE_PARTS = new Set([
  "table-row-group", "table-header-group", "table-footer-group", "table-row", "table-cell", "table-caption",
  "table-column", "table-column-group",
]);

function isBlockLevel(node) {
  return ["block", "flex", "grid", "table"].includes(node.type) || TABLE_PARTS.has(node.type)
    || (node.type === "image" && node.style?.display === "block");
}

function isAtomic(node) {
  return ["inline-block", "inline-flex", "inline-grid", "inline-table"].includes(node.type);
}

function hasInlineContent(items) {
  return items.some((item) => item.kind === "text"
    ? item.preserve ? item.text.length > 0 : /[^\t\n\f\r ]/.test(item.text)
    : ["break", "image", "atomic"].includes(item.kind));
}

// ---------------------------------------------------------------------------
// Block layout

/**
 * Lays out a block-level box, then its absolutely positioned descendants,
 * then applies relative offsets and translations to everything it produced.
 */
function layoutBlock(ctx, box, x, width, y, absorbTop = false, forcedHeight = null) {
  const style = box.style;
  const boxStart = ctx.boxes.length;
  const fragmentStart = ctx.fragments.length;
  const previousLayer = ctx.layer;
  const previousContext = ctx.stackingContext;
  // Anonymous boxes reuse their container's node but are never positioned themselves.
  if (!box.anonymous && isPositioned(box.node)) {
    const context = Number.isInteger(style.zIndex);
    ctx.layer = Object.freeze({
      z: context ? style.zIndex : 0,
      order: ctx.layerCount++,
      context,
      parent: ctx.stackingContext,
    });
    // z-index: auto paints in the parent context and does not group its descendants.
    if (context) ctx.stackingContext = ctx.layer;
  }
  const result = layoutBlockContent(ctx, box, x, width, y, absorbTop, forcedHeight);
  const record = ctx.boxes[boxStart];
  if (box.absolutes?.length) layoutAbsolutes(ctx, box, record);
  let dx = 0;
  let dy = 0;
  if (style?.position === "relative") {
    const [top, right, bottom, left] = style.inset.map((value) => numberOrNull(value));
    dx = left ?? (right != null ? -right : 0);
    dy = top ?? (bottom != null ? -bottom : 0);
  }
  if (style?.transform) {
    dx += numberOrZero(resolveLength(style.transform.x, record.width));
    dy += numberOrZero(resolveLength(style.transform.y, record.height));
  }
  for (let index = boxStart; index < ctx.boxes.length; index++) ctx.boxes[index].layer ??= ctx.layer;
  for (let index = fragmentStart; index < ctx.fragments.length; index++) ctx.fragments[index].layer ??= ctx.layer;
  if (dx || dy) shiftOutput(ctx, boxStart, fragmentStart, dx, dy);
  ctx.layer = previousLayer;
  ctx.stackingContext = previousContext;
  return result;
}

/** CSS 2 §10.3.7/§10.6.4 absolute placement against the padding box. */
function layoutAbsolutes(ctx, box, record) {
  const border = borderWidths(box.style);
  const icb = ctx.initialContainingBlock;
  const block = box.node.type === "root"
    ? { ...icb, height: icb.height || record.y + record.height }
    : {
      x: record.x + border[3],
      y: record.y + border[0],
      width: record.width - border[1] - border[3],
      height: record.height - border[0] - border[2],
    };
  for (const absolute of box.absolutes) {
    const style = absolute.style;
    const containing = style?.position === "fixed" ? { ...icb, height: icb.height || block.height } : block;
    const [top, right, bottom, left] = (style?.inset ?? ["auto", "auto", "auto", "auto"])
      .map((value, index) => value === "auto" ? null : resolveLength(value, index % 2 ? containing.width : containing.height));
    const margin = style?.margin ?? ZERO_BOX;
    const [marginTop, marginRight, marginBottom, marginLeft] = margin.map(numberOrZero);
    const specifiedWidth = numberOrNull(resolveLength(style?.width, containing.width));
    let width;
    if (specifiedWidth == null && left != null && right != null) {
      width = Math.max(0, containing.width - left - right - marginLeft - marginRight);
    } else {
      width = resolveHorizontal(ctx, absolute, 0, containing.width - (left ?? 0) - (right ?? 0), true).width;
    }
    const staticPosition = absolute.staticPosition ?? containing;
    const x = left != null ? containing.x + left + marginLeft
      : right != null ? containing.x + containing.width - right - marginRight - width
        : staticPosition.x + marginLeft;
    const specifiedHeight = numberOrNull(resolveLength(style?.height, containing.height));
    const forcedHeight = specifiedHeight == null && top != null && bottom != null
      ? Math.max(0, containing.height - top - bottom - marginTop - marginBottom)
      : null;
    let height = forcedHeight;
    if (height == null && top == null && bottom != null) height = dryLayout(ctx, absolute, width).height;
    const y = top != null ? containing.y + top + marginTop
      : bottom != null ? containing.y + containing.height - bottom - marginBottom - height
        : staticPosition.y + marginTop;
    layoutBlock(ctx, absolute, x, width, y, false, forcedHeight);
  }
}

/**
 * justify-content in a column flex container (Flexbox §8.2): `free` is the
 * height left over once the items are stacked, as with a min-height or height
 * taller than them. Each item's output moves by its share; shifts are applied
 * item by item because shiftOutput moves everything after a start index.
 */
function justifyColumn(ctx, items, justify = "normal", free) {
  if (!(free > 0) || ["normal", "start", "flex-start", "stretch"].includes(justify)) return;
  const count = items.length;
  const offset = (index) => {
    switch (justify) {
      case "center": return free / 2;
      case "end": case "flex-end": return free;
      case "space-between": return count > 1 ? free * index / (count - 1) : 0;
      case "space-around": return free / count * (index + 0.5);
      case "space-evenly": return free / (count + 1) * (index + 1);
      default: return 0;
    }
  };
  let applied = 0;
  items.forEach((item, index) => {
    const delta = offset(index) - applied;
    if (delta) shiftOutput(ctx, item.boxStart, item.fragmentStart, 0, delta);
    applied += delta;
  });
}

function shiftOutput(ctx, boxStart, fragmentStart, dx, dy) {
  for (let index = boxStart; index < ctx.boxes.length; index++) {
    ctx.boxes[index].x += dx;
    ctx.boxes[index].y += dy;
  }
  for (let index = fragmentStart; index < ctx.fragments.length; index++) {
    const fragment = ctx.fragments[index];
    ctx.fragments[index] = {
      ...fragment,
      x: fragment.x + dx,
      y: fragment.y + dy,
      baseline: fragment.baseline == null ? null : fragment.baseline + dy,
      runs: Object.freeze(fragment.runs.map((run) => Object.freeze({
        ...run,
        x: run.x + dx,
        y: run.y == null ? run.y : run.y + dy,
      }))),
    };
  }
}

function layoutBlockContent(ctx, box, x, width, y, absorbTop = false, forcedHeight = null) {
  const style = box.style;
  const border = borderWidths(style);
  const padding = style?.padding ?? ZERO_BOX;
  const record = { nodeId: box.node.id, x, y, width, height: 0, style };
  ctx.boxes.push(record);
  if (box.replaced) {
    const dimensions = imageDimensions(box.node, width);
    const imageX = x + border[3] + padding[3];
    const imageY = y + border[0] + padding[0];
    ctx.fragments.push(lineFragment(box.style, "￼", [box.node.id], [{
      nodeId: box.node.id,
      type: "image",
      text: "",
      start: 0,
      end: 1,
      style,
      x: imageX,
      y: imageY,
      width: dimensions.width,
      height: dimensions.height,
      resource: box.node.resource,
      video: box.node.tagName === "VIDEO",
      svg: box.node.svg ?? null,
    }], imageX, imageY, dimensions.width, dimensions.height));
    record.height = dimensions.height + padding[0] + padding[2] + border[0] + border[2];
    return { height: record.height, baseline: null };
  }

  const contentX = x + border[3] + padding[3];
  const contentWidth = Math.max(1, width - border[1] - border[3] - padding[1] - padding[3]);
  const contentTop = y + border[0] + padding[0];
  const firstFragment = ctx.fragments.length;
  let contentBottom = contentTop;
  // Column flex items, for justify-content once the height is known.
  let columnItems = null;
  let baseline = null;

  if (box.table) {
    const result = layoutTable(ctx, box, contentX, contentWidth, contentTop);
    contentBottom = result.bottom;
    baseline = result.baseline;
  } else if (box.grid) {
    const result = layoutGrid(ctx, box, contentX, contentWidth, contentTop);
    contentBottom = result.bottom;
    baseline = result.baseline;
  } else if (box.flex === "row") {
    const result = layoutFlexRow(ctx, box, contentX, contentWidth, contentTop);
    contentBottom = result.bottom;
    baseline = result.baseline;
  } else if (box.flex === "column") {
    const gap = style?.rowGap ?? style?.gap ?? 0;
    let cursor = contentTop;
    columnItems = [];
    box.children.forEach((child, index) => {
      if (index > 0) cursor += gap;
      columnItems.push({ boxStart: ctx.boxes.length, fragmentStart: ctx.fragments.length });
      if (child.kind === "ifc") {
        const result = layoutInline(ctx, child, contentX, contentWidth, cursor);
        cursor = result.bottom;
        baseline = result.baseline ?? baseline;
        return;
      }
      const alignment = ["auto", "normal", undefined].includes(child.style?.alignSelf)
        ? style?.alignItems ?? "normal"
        : child.style.alignSelf;
      const shrink = !["normal", "stretch"].includes(alignment);
      const placed = resolveHorizontal(ctx, child, contentX, contentWidth, shrink);
      const autoMargins = (child.style?.margin ?? ZERO_BOX).some((value) => value === "auto");
      let childX = placed.x;
      if (shrink && !autoMargins) {
        const free = contentWidth - placed.width - placed.marginLeft - placed.marginRight;
        if (alignment === "center") childX = contentX + placed.marginLeft + free / 2;
        else if (alignment === "end") childX = contentX + placed.marginLeft + free;
      }
      const margin = verticalMargins(child.style);
      const result = layoutBlock(ctx, child, childX, placed.width, cursor + margin.top);
      cursor += margin.top + result.height + margin.bottom;
      baseline = result.baseline ?? baseline;
    });
    contentBottom = cursor;
  } else {
    let cursor = contentTop;
    let pending = null;
    let firstInFlow = true;
    box.children.forEach((child) => {
      if (child.kind === "placeholder") {
        child.box.staticPosition = { x: contentX, y: cursor + strutValue(pending ?? ZERO_STRUT) };
        return;
      }
      const first = firstInFlow;
      firstInFlow = false;
      if (child.kind === "ifc") {
        cursor += strutValue(pending ?? ZERO_STRUT);
        pending = ZERO_STRUT;
        const result = layoutInline(ctx, child, contentX, contentWidth, cursor);
        cursor = result.bottom;
        baseline = result.baseline ?? baseline;
        return;
      }
      const combined = first && absorbTop
        ? ZERO_STRUT
        : combineStruts(pending ?? ZERO_STRUT, topStrut(child));
      const childY = cursor + strutValue(combined);
      // Tables with width: auto are sized to their contents (CSS 2 §17.5.2).
      const placed = resolveHorizontal(ctx, child, contentX, contentWidth, Boolean(child.table));
      const result = layoutBlock(ctx, child, placed.x, placed.width, childY, collapsesThroughTop(child));
      cursor = childY + result.height;
      pending = bottomStrut(child);
      baseline = result.baseline ?? baseline;
    });
    contentBottom = collapsesThroughBottom(box) ? cursor : cursor + strutValue(pending ?? ZERO_STRUT);
  }

  let contentHeight = Math.max(0, contentBottom - contentTop);
  const toContentHeight = (value) => style.boxSizing === "border-box"
    ? Math.max(0, value - border[0] - border[2] - padding[0] - padding[2])
    : value;
  const specifiedHeight = numberOrNull(style?.height);
  if (specifiedHeight != null) contentHeight = toContentHeight(specifiedHeight);
  // min-height and max-height (percentages need a definite containing height; not modelled).
  const maxHeight = numberOrNull(style?.maxHeight);
  if (maxHeight != null) contentHeight = Math.min(contentHeight, toContentHeight(maxHeight));
  const minHeight = numberOrNull(style?.minHeight);
  if (minHeight != null) contentHeight = Math.max(contentHeight, toContentHeight(minHeight));
  if (columnItems?.length) justifyColumn(ctx, columnItems, style?.justifyContent, contentHeight - (contentBottom - contentTop));
  record.height = forcedHeight ?? contentHeight + padding[0] + padding[2] + border[0] + border[2];
  if (style?.display === "list-item") placeListMarker(ctx, box, contentX, contentTop, firstFragment);
  return { height: record.height, baseline };
}

/**
 * Outside list markers (CSS Lists 3): the marker's inline end touches the
 * principal box's content edge, on the baseline of the item's first line.
 */
function placeListMarker(ctx, box, contentX, contentTop, firstFragment) {
  const style = box.style;
  const text = markerText(style.listStyleType, listOrdinal(box.node));
  if (!text) return;
  const width = ctx.measure(text, style);
  const metrics = textMetrics(ctx, style);
  const firstLine = ctx.fragments.slice(firstFragment).find((fragment) => fragment.baseline != null);
  const baseline = firstLine?.baseline ?? contentTop + metrics.ascent;
  const x = contentX - width;
  ctx.fragments.push(lineFragment(style, text, [box.node.id], [{
    nodeId: box.node.id,
    type: "marker",
    text,
    start: 0,
    end: text.length,
    style,
    x,
    y: baseline - metrics.contentAscent,
    width,
    height: null,
  }], x, baseline - metrics.ascent, width, metrics.ascent + metrics.descent, baseline));
}

function listOrdinal(node) {
  const element = node.domNode;
  const list = element?.parentElement;
  let ordinal = list?.tagName === "OL" && Number.isInteger(Number(list.getAttribute("start")))
    && list.hasAttribute("start") ? Number(list.getAttribute("start")) : 1;
  for (let sibling = element?.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
    if (sibling.tagName === "LI") ordinal++;
  }
  const value = Number(element?.getAttribute?.("value"));
  return element?.hasAttribute?.("value") && Number.isInteger(value) ? value : ordinal;
}

function markerText(type, ordinal) {
  switch (type) {
    case "disc": return "\u2022 ";
    case "circle": return "\u25E6 ";
    case "square": return "\u25AA ";
    case "decimal": return `${ordinal}. `;
    case "decimal-leading-zero": return `${String(ordinal).padStart(2, "0")}. `;
    case "lower-alpha":
    case "lower-latin": return `${alphabetic(ordinal)}. `;
    case "upper-alpha":
    case "upper-latin": return `${alphabetic(ordinal).toUpperCase()}. `;
    case "lower-roman": return `${roman(ordinal)}. `;
    case "upper-roman": return `${roman(ordinal).toUpperCase()}. `;
    default: return "";
  }
}

function alphabetic(value) {
  let text = "";
  for (let rest = value; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    text = String.fromCharCode(97 + (rest - 1) % 26) + text;
  }
  return text || String(value);
}

function roman(value) {
  if (value <= 0 || value >= 4000) return String(value);
  const numerals = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let text = "";
  for (const [amount, numeral] of numerals) {
    while (value >= amount) {
      text += numeral;
      value -= amount;
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// Flex row layout (CSS Flexbox §9)

function layoutFlexRow(ctx, box, x, width, y) {
  const style = box.style;
  const columnGap = style?.columnGap ?? style?.gap ?? 0;
  const rowGap = style?.rowGap ?? style?.gap ?? 0;
  const items = box.children.map((child) => flexItem(ctx, child, width));

  const lines = [];
  let line = [];
  let used = 0;
  for (const item of items) {
    const outer = item.hypothetical + item.extra + item.marginLeft + item.marginRight;
    if (style?.flexWrap === "wrap" && line.length && used + columnGap + outer > width + 0.01) {
      lines.push(line);
      line = [];
      used = 0;
    }
    used += (line.length ? columnGap : 0) + outer;
    line.push(item);
  }
  if (line.length) lines.push(line);

  let cursor = y;
  let baseline = null;
  lines.forEach((lineItems, lineIndex) => {
    if (lineIndex > 0) cursor += rowGap;
    const gaps = columnGap * (lineItems.length - 1);
    resolveFlexibleLengths(lineItems, width - gaps, !box.shrinkToFit);
    for (const item of lineItems) {
      item.target += item.extra;
      Object.assign(item, dryLayout(ctx, item.box, item.target));
    }
    let crossSize = Math.max(0, ...lineItems.map((item) => item.height + item.marginTop + item.marginBottom));
    // A single-line container with a definite height gives its line that cross size (§9.4.15).
    const definiteHeight = numberOrNull(style?.height);
    if (lines.length === 1 && definiteHeight != null) {
      const padding = style.padding ?? ZERO_BOX;
      crossSize = style.boxSizing === "border-box"
        ? Math.max(0, definiteHeight - padding[0] - padding[2] - borderWidths(style)[0] - borderWidths(style)[2])
        : definiteHeight;
    }

    // Main axis: auto margins absorb free space first, then justify-content.
    let free = width - gaps - lineItems.reduce((sum, item) => sum + item.target + item.marginLeft + item.marginRight, 0);
    const autoMargins = lineItems.reduce((sum, item) => sum + Number(item.autoLeft) + Number(item.autoRight), 0);
    const autoShare = autoMargins && free > 0 ? free / autoMargins : 0;
    if (autoMargins && free > 0) free = 0;
    const justify = style?.justifyContent ?? "normal";
    const count = lineItems.length;
    let offset = 0;
    let between = 0;
    if (justify === "end") offset = free;
    else if (justify === "center") offset = free / 2;
    else if (free > 0 && justify === "space-between" && count > 1) between = free / (count - 1);
    else if (free > 0 && justify === "space-around") {
      between = free / count;
      offset = between / 2;
    } else if (free > 0 && justify === "space-evenly") {
      between = free / (count + 1);
      offset = between;
    }

    let mainX = x + offset;
    for (const item of lineItems) {
      mainX += item.marginLeft + (item.autoLeft ? autoShare : 0);
      const alignment = ["auto", "normal", undefined].includes(item.box.style?.alignSelf)
        ? style?.alignItems ?? "normal"
        : item.box.style.alignSelf;
      const outerHeight = item.height + item.marginTop + item.marginBottom;
      let itemY = cursor + item.marginTop;
      let forcedHeight = null;
      if (item.autoCross) {
        // Auto cross margins absorb the free cross space (§8.1).
        const margin = item.box.style.margin;
        const free = Math.max(0, crossSize - outerHeight);
        const autos = Number(margin[0] === "auto") + Number(margin[2] === "auto");
        if (margin[0] === "auto") itemY += free / autos;
      } else if (["normal", "stretch"].includes(alignment) && numberOrNull(item.box.style?.height) == null) {
        forcedHeight = Math.max(item.height, crossSize - item.marginTop - item.marginBottom);
      } else if (alignment === "center") {
        itemY += (crossSize - outerHeight) / 2;
      } else if (alignment === "end") {
        itemY += crossSize - outerHeight;
      }
      const result = layoutBlock(ctx, item.box, mainX, item.target, itemY, false, forcedHeight);
      baseline ??= result.baseline;
      mainX += item.target + item.marginRight + (item.autoRight ? autoShare : 0) + columnGap + between;
    }
    cursor += crossSize;
  });
  return { bottom: cursor, baseline };
}

function flexItem(ctx, box, containerWidth) {
  // Sizes below are content-box sizes, as in Blink's FlexItem
  // (base_content_size, hypothetical_content_size); `extra` is padding+border.
  const style = box.style;
  const padding = style?.padding ?? ZERO_BOX;
  const extra = padding[1] + padding[3] + borderWidths(style)[1] + borderWidths(style)[3];
  const contentBox = (value) => Math.max(0, style?.boxSizing === "border-box" ? value - extra : value);
  const margin = style?.margin ?? ZERO_BOX;
  const specifiedWidth = numberOrNull(resolveLength(style?.width, containerWidth));
  const basis = style?.flexBasis ?? "auto";
  const definiteBasis = numberOrNull(resolveLength(basis, containerWidth));
  let base;
  if (definiteBasis != null) base = contentBox(definiteBasis);
  else if (basis === "auto" && specifiedWidth != null && !box.replaced) base = contentBox(specifiedWidth);
  else base = Math.max(0, maxContentWidth(ctx, box) - extra);

  const minWidth = numberOrNull(resolveLength(style?.minWidth, containerWidth));
  // Automatic minimum size (§4.5): the content size suggestion, capped by the
  // specified size suggestion. It floors every clamp, not only the hypothetical size.
  let min = minWidth != null
    ? contentBox(minWidth)
    : Math.min(Math.max(0, minContentWidth(ctx, box) - extra),
      specifiedWidth != null ? contentBox(specifiedWidth) : Infinity);
  const maxWidth = numberOrNull(resolveLength(style?.maxWidth, containerWidth));
  const max = maxWidth != null ? contentBox(maxWidth) : Infinity;
  min = Math.min(min, max);
  return {
    box,
    extra,
    grow: style?.flexGrow ?? 0,
    shrink: style?.flexShrink ?? 1,
    base,
    min,
    max,
    hypothetical: Math.min(max, Math.max(min, base)),
    marginLeft: numberOrZero(margin[3]),
    marginRight: numberOrZero(margin[1]),
    marginTop: numberOrZero(margin[0]),
    marginBottom: numberOrZero(margin[2]),
    autoLeft: margin[3] === "auto",
    autoRight: margin[1] === "auto",
    autoCross: margin[0] === "auto" || margin[2] === "auto",
  };
}

/**
 * CSS Flexbox §9.7, following Blink's LineFlexer (line_flexer.cc): decide grow
 * vs. shrink once, freeze inflexible items, then repeatedly distribute free
 * space and freeze min/max violators. `available` excludes gaps; sizes are
 * content-box. Growing requires a definite main size (TermDOM layoutsolver).
 */
function resolveFlexibleLengths(items, available, definite = true) {
  const outer = (item, size) => size + item.extra + item.marginLeft + item.marginRight;
  const growing = items.reduce((sum, item) => sum + outer(item, item.hypothetical), 0) < available;
  for (const item of items) {
    item.target = item.hypothetical;
    const factor = growing ? item.grow : item.shrink;
    item.frozen = factor === 0 || (growing && !definite)
      || (growing ? item.base > item.hypothetical : item.base < item.hypothetical);
  }
  const freeSpace = () => available
    - items.reduce((sum, item) => sum + outer(item, item.frozen ? item.target : item.base), 0);
  const initialFree = freeSpace();

  for (let iteration = 0; iteration <= items.length; iteration++) {
    const unfrozen = items.filter((item) => !item.frozen);
    if (!unfrozen.length) break;
    for (const item of unfrozen) item.target = item.hypothetical;
    let free = freeSpace();
    const factors = unfrozen.reduce((sum, item) => sum + (growing ? item.grow : item.shrink), 0);
    if (factors > 0 && factors < 1 && Math.abs(initialFree * factors) < Math.abs(free)) free = initialFree * factors;
    // No free space in the flexing direction: items keep their hypothetical sizes.
    if (growing ? free <= 0 : free >= 0) break;
    const scaledShrink = unfrozen.reduce((sum, item) => sum + item.shrink * item.base, 0);
    let violation = 0;
    for (const item of unfrozen) {
      const size = growing
        ? item.base + free * item.grow / factors
        : item.base + (scaledShrink > 0 ? free * item.shrink * item.base / scaledShrink : 0);
      const clamped = Math.max(0, Math.min(item.max, Math.max(item.min, size)));
      item.violation = clamped - size;
      item.target = clamped;
      violation += item.violation;
    }
    if (Math.abs(violation) < 1e-9) break;
    for (const item of unfrozen) {
      if (violation > 0 ? item.violation > 0 : item.violation < 0) item.frozen = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Grid layout (CSS Grid 2). Structure follows the spec's algorithm steps;
// behaviour is checked against TermDOM's hand-derived grid tests.

function layoutGrid(ctx, box, x, width, y) {
  const style = box.style;
  const columnGap = style?.columnGap ?? 0;
  const rowGap = style?.rowGap ?? 0;
  const grid = gridStructure(ctx, box, width, columnGap, true);
  const columns = sizeGridColumns(ctx, box, grid, width, columnGap, true);
  // justify-content distributes space left over after track sizing (css-align-3 §5.3).
  const visibleColumns = columns.filter((_, index) => !grid.columnCollapsed[index]).length;
  const used = columns.reduce((sum, size) => sum + size, 0) + columnGap * Math.max(0, visibleColumns - 1);
  const free = Math.max(0, width - used);
  const justify = style?.justifyContent ?? "normal";
  let offset = 0;
  let between = 0;
  if (justify === "center") offset = free / 2;
  else if (justify === "end") offset = free;
  else if (justify === "space-between" && visibleColumns > 1) between = free / (visibleColumns - 1);
  else if (justify === "space-around") {
    between = free / visibleColumns;
    offset = between / 2;
  } else if (justify === "space-evenly") {
    between = free / (visibleColumns + 1);
    offset = between;
  }
  const effectiveGap = columnGap + between;
  const columnStarts = trackStarts(columns, grid.columnCollapsed, effectiveGap, x + offset);

  // Row sizing: item heights at their column-area widths (§12.5 simplified).
  const areaWidth = (item) => spanSize(columns, grid.columnCollapsed, effectiveGap, item.column, item.columnSpan);
  for (const item of grid.items) {
    item.width = areaWidth(item);
    const margin = item.box.style?.margin ?? ZERO_BOX;
    const horizontal = gridHorizontal(ctx, style, item, columnStarts[item.column], item.width);
    item.horizontal = horizontal;
    const measured = dryLayout(ctx, item.box, horizontal.width);
    item.height = measured.height + numberOrZero(margin[0]) + numberOrZero(margin[2]);
  }
  const rows = sizeGridRows(grid, rowGap);
  const rowStarts = trackStarts(rows, [], rowGap, y);

  let baseline = null;
  for (const item of grid.items) {
    const areaY = rowStarts[item.row];
    const areaHeight = spanSize(rows, [], rowGap, item.row, item.rowSpan);
    const itemStyle = item.box.style;
    const margin = verticalMargins(itemStyle);
    const alignment = ["auto", "normal", undefined].includes(itemStyle?.alignSelf)
      ? style?.alignItems ?? "normal"
      : itemStyle.alignSelf;
    const contentHeight = item.height - margin.top - margin.bottom;
    let itemY = areaY + margin.top;
    let forcedHeight = null;
    if (["normal", "stretch"].includes(alignment) && numberOrNull(itemStyle?.height) == null) {
      forcedHeight = Math.max(contentHeight, areaHeight - margin.top - margin.bottom);
    } else if (alignment === "center") {
      itemY += (areaHeight - item.height) / 2;
    } else if (alignment === "end") {
      itemY += areaHeight - item.height;
    }
    const result = layoutBlock(ctx, item.box, item.horizontal.x, item.horizontal.width, itemY, false, forcedHeight);
    baseline ??= result.baseline;
  }
  const height = rows.reduce((sum, size) => sum + size, 0) + rowGap * Math.max(0, rows.length - 1);
  return { bottom: y + height, baseline };
}

// ---------------------------------------------------------------------------
// Tables (CSS 2 §17; column widths as in the HTML/CSS automatic table layout)

/**
 * Rows in display order (header groups, body rows, footer groups) with their
 * cells, plus captions. Cells directly in a table or group get an anonymous
 * row; other stray content is not rendered.
 */
function tableStructure(node, flags) {
  const header = [];
  const body = [];
  const footer = [];
  const captions = [];
  const addRows = (target, children, childFlags) => {
    let anonymous = null;
    for (const child of children) {
      if (child.type === "table-row") {
        anonymous = null;
        const rowFlags = inheritedFlags(child, childFlags);
        target.push({
          node: child,
          style: child.style ?? null,
          cells: child.children.filter((cell) => cell.type === "table-cell").map((cell) => tableCell(cell, rowFlags)),
        });
      } else if (child.type === "table-cell") {
        if (!anonymous) target.push(anonymous = { node: null, style: null, cells: [] });
        anonymous.cells.push(tableCell(child, childFlags));
      }
    }
  };
  let loose = [];
  const flushLoose = () => {
    addRows(body, loose, flags);
    loose = [];
  };
  for (const child of node.children) {
    if (child.type === "table-row" || child.type === "table-cell") {
      loose.push(child);
      continue;
    }
    flushLoose();
    if (child.type === "table-caption") captions.push(buildBox(child, inheritedFlags(child, flags), true));
    else if (child.type === "table-header-group") addRows(header, child.children, inheritedFlags(child, flags));
    else if (child.type === "table-footer-group") addRows(footer, child.children, inheritedFlags(child, flags));
    else if (child.type === "table-row-group") addRows(body, child.children, inheritedFlags(child, flags));
  }
  flushLoose();
  return { rows: [...header, ...body, ...footer], captions, grid: null };
}

function tableCell(node, flags) {
  const span = (name) => Math.max(1, Math.min(1000, Number.parseInt(node.domNode?.getAttribute?.(name) ?? "1", 10) || 1));
  return { box: buildBox(node, inheritedFlags(node, flags), true), colspan: span("colspan"), rowspan: span("rowspan") };
}

/** Places cells on the row/column grid, skipping slots taken by earlier rowspans. */
function tableGrid(table) {
  if (table.grid) return table.grid;
  const occupied = [];
  const cells = [];
  let columns = 0;
  table.rows.forEach((row, rowIndex) => {
    let column = 0;
    for (const cell of row.cells) {
      while (occupied[rowIndex]?.has(column)) column++;
      const rowspan = Math.min(cell.rowspan, table.rows.length - rowIndex);
      for (let dr = 0; dr < rowspan; dr++) {
        for (let dc = 0; dc < cell.colspan; dc++) (occupied[rowIndex + dr] ??= new Set()).add(column + dc);
      }
      cells.push({ ...cell, row: rowIndex, column, rowspan });
      column += cell.colspan;
      columns = Math.max(columns, column);
    }
  });
  table.grid = { cells, columns, rows: table.rows.length };
  return table.grid;
}

function tableSpacing(style) {
  return style?.borderCollapse === "collapse" ? [0, 0] : style?.borderSpacing ?? [0, 0];
}

/** Minimum and maximum widths of every column; spanning cells spread their excess evenly. */
function tableColumnSizes(ctx, grid, spacingX) {
  const mins = new Array(grid.columns).fill(0);
  const maxes = new Array(grid.columns).fill(0);
  const bySpan = [...grid.cells].sort((left, right) => left.colspan - right.colspan);
  for (const cell of bySpan) {
    const min = minContentWidth(ctx, cell.box);
    const max = Math.max(min, maxContentWidth(ctx, cell.box));
    const span = [...Array(cell.colspan).keys()].map((offset) => cell.column + offset);
    const spread = (sizes, need) => {
      const have = span.reduce((sum, column) => sum + sizes[column], 0) + spacingX * (cell.colspan - 1);
      if (need > have) for (const column of span) sizes[column] += (need - have) / cell.colspan;
    };
    spread(mins, min);
    spread(maxes, max);
  }
  for (let column = 0; column < grid.columns; column++) maxes[column] = Math.max(maxes[column], mins[column]);
  return { mins, maxes };
}

/**
 * table-layout: fixed (CSS 2 §17.5.2.1): widths come from the first row's
 * specified cell widths; the other columns share the rest equally. Cell
 * contents do not affect them.
 */
function fixedColumnSizes(grid, table, available) {
  const widths = new Array(grid.columns).fill(null);
  for (const cell of grid.cells) {
    if (cell.row !== 0) continue;
    const specified = numberOrNull(resolveLength(cell.box.style?.width, available));
    if (specified == null) continue;
    for (let offset = 0; offset < cell.colspan; offset++) widths[cell.column + offset] = specified / cell.colspan;
  }
  const assigned = widths.reduce((sum, size) => sum + (size ?? 0), 0);
  const open = widths.filter((size) => size == null).length;
  const share = open ? Math.max(0, available - assigned) / open : 0;
  const sizes = widths.map((size) => size ?? share);
  return { mins: sizes, maxes: sizes };
}

function tableIntrinsicWidth(ctx, box, kind) {
  const grid = tableGrid(box.table);
  const [spacingX] = tableSpacing(box.style);
  const { mins, maxes } = tableColumnSizes(ctx, grid, spacingX);
  const columns = (kind === "min" ? mins : maxes).reduce((sum, size) => sum + size, 0);
  const captions = Math.max(0, ...box.table.captions.map((caption) =>
    kind === "min" ? minContentWidth(ctx, caption) : maxContentWidth(ctx, caption)));
  return Math.max(captions, grid.columns ? columns + spacingX * (grid.columns + 1) : 0);
}

function layoutTable(ctx, box, x, width, y) {
  const table = box.table;
  const [spacingX, spacingY] = tableSpacing(box.style);
  let cursor = y;
  for (const caption of table.captions) {
    const placed = resolveHorizontal(ctx, caption, x, width, false);
    const margin = verticalMargins(caption.style);
    cursor += margin.top + layoutBlock(ctx, caption, placed.x, placed.width, cursor + margin.top).height + margin.bottom;
  }
  const grid = tableGrid(table);
  if (!grid.columns) return { bottom: cursor, baseline: null };

  // Column widths: maximum widths when they fit, else interpolate from the
  // minimums; any remaining space is shared in proportion to the maximums.
  const available = Math.max(0, width - spacingX * (grid.columns + 1));
  const fixed = box.style?.tableLayout === "fixed" && numberOrNull(resolveLength(box.style?.width, width)) != null;
  const { mins, maxes } = fixed ? fixedColumnSizes(grid, table, available) : tableColumnSizes(ctx, grid, spacingX);
  const sumMin = mins.reduce((sum, size) => sum + size, 0);
  const sumMax = maxes.reduce((sum, size) => sum + size, 0);
  let widths;
  if (fixed) widths = maxes;
  else if (sumMin >= available) widths = mins;
  else if (sumMax <= available) {
    const extra = available - sumMax;
    widths = maxes.map((size) => size + (sumMax > 0 ? extra * size / sumMax : extra / grid.columns));
  } else {
    const ratio = (available - sumMin) / (sumMax - sumMin);
    widths = mins.map((min, column) => min + (maxes[column] - min) * ratio);
  }
  const starts = [];
  let columnX = x + spacingX;
  for (const size of widths) {
    starts.push(columnX);
    columnX += size + spacingX;
  }
  const spanWidth = (cell) =>
    widths.slice(cell.column, cell.column + cell.colspan).reduce((sum, size) => sum + size, 0) + spacingX * (cell.colspan - 1);

  // Row heights: the tallest single-row cell (or a specified height); rowspans
  // add whatever they still need to their last row.
  const rowHeights = table.rows.map((row) => numberOrZero(numberOrNull(row.style?.height)));
  for (const cell of grid.cells) {
    cell.width = spanWidth(cell);
    cell.measured = dryLayout(ctx, cell.box, cell.width).height;
    if (cell.rowspan === 1) rowHeights[cell.row] = Math.max(rowHeights[cell.row], cell.measured);
  }
  for (const cell of grid.cells) {
    if (cell.rowspan === 1) continue;
    const last = cell.row + cell.rowspan - 1;
    const have = rowHeights.slice(cell.row, last + 1).reduce((sum, size) => sum + size, 0) + spacingY * (cell.rowspan - 1);
    if (cell.measured > have) rowHeights[last] += cell.measured - have;
  }
  const rowTops = [];
  cursor += spacingY;
  for (const size of rowHeights) {
    rowTops.push(cursor);
    cursor += size + spacingY;
  }

  // Row backgrounds, then cells.
  table.rows.forEach((row, index) => {
    if (!row.node) return;
    ctx.boxes.push({
      nodeId: row.node.id,
      x: x + spacingX,
      y: rowTops[index],
      width: Math.max(0, width - spacingX * 2),
      height: rowHeights[index],
      style: row.style,
    });
  });
  let baseline = null;
  for (const cell of grid.cells) {
    const top = rowTops[cell.row];
    const height = rowHeights.slice(cell.row, cell.row + cell.rowspan).reduce((sum, size) => sum + size, 0)
      + spacingY * (cell.rowspan - 1);
    const boxStart = ctx.boxes.length;
    const fragmentStart = ctx.fragments.length;
    const result = layoutBlock(ctx, cell.box, starts[cell.column], cell.width, top, false, height);
    // vertical-align moves the cell's content, not the cell box.
    const align = cell.box.style?.verticalAlign;
    const offset = align === "middle" ? (height - cell.measured) / 2
      : align === "bottom" ? height - cell.measured
      : 0;
    if (offset > 0) shiftOutput(ctx, boxStart + 1, fragmentStart, 0, offset);
    if (cell.row === 0) baseline ??= result.baseline == null ? null : result.baseline + offset;
  }
  return { bottom: cursor, baseline };
}

/** justify-self within the grid area: stretch unless a width or alignment says otherwise. */
function gridHorizontal(ctx, containerStyle, item, areaX, areaWidth) {
  const style = item.box.style;
  const alignment = ["auto", undefined].includes(style?.justifySelf)
    ? containerStyle?.justifyItems ?? "normal"
    : style.justifySelf;
  const shrink = ["start", "end", "center"].includes(alignment);
  const placed = resolveHorizontal(ctx, item.box, areaX, areaWidth, shrink);
  const free = areaWidth - placed.width - placed.marginLeft - placed.marginRight;
  if (alignment === "center") placed.x += free / 2;
  else if (alignment === "end") placed.x += free;
  return placed;
}

/** Expands track lists and places items (§7.2, §8.5 row auto-flow). */
function gridStructure(ctx, box, availableWidth, columnGap, definite) {
  const style = box.style;
  const explicitColumns = expandTrackList(style?.gridTemplateColumns, definite ? availableWidth : null, columnGap);
  const explicitRows = expandTrackList(style?.gridTemplateRows, null, style?.rowGap ?? 0);
  const items = box.children.map((child) => ({ box: child, ...gridLines(child.style, explicitColumns.tracks.length, "Column"),
    ...rowLines(child.style, explicitRows.tracks.length) }));

  let columnCount = Math.max(1, explicitColumns.tracks.length);
  for (const item of items) {
    if (item.column != null) columnCount = Math.max(columnCount, item.column + item.columnSpan);
    else columnCount = Math.max(columnCount, item.columnSpan);
  }
  const occupied = [];
  const isFree = (row, column, rowSpan, columnSpan) => {
    for (let r = row; r < row + rowSpan; r++) {
      for (let c = column; c < column + columnSpan; c++) if (occupied[r]?.[c]) return false;
    }
    return true;
  };
  const occupy = (item) => {
    for (let r = item.row; r < item.row + item.rowSpan; r++) {
      occupied[r] ??= [];
      for (let c = item.column; c < item.column + item.columnSpan; c++) occupied[r][c] = true;
    }
  };

  // 1. Items locked to both axes; 2. items locked to a row.
  for (const item of items) if (item.row != null && item.column != null) occupy(item);
  for (const item of items) {
    if (item.row == null || item.column != null) continue;
    let column = 0;
    while (column + item.columnSpan <= columnCount && !isFree(item.row, column, item.rowSpan, item.columnSpan)) column++;
    item.column = column;
    columnCount = Math.max(columnCount, column + item.columnSpan);
    occupy(item);
  }
  // 3. Auto-placed items walk a cursor forward (sparse) or restart (dense).
  const dense = style?.gridAutoFlow?.dense === true;
  let cursorRow = 0;
  let cursorColumn = 0;
  for (const item of items) {
    if (item.row != null) continue;
    if (dense) {
      cursorRow = 0;
      cursorColumn = 0;
    }
    if (item.column != null) {
      if (item.column < cursorColumn) cursorRow++;
      cursorColumn = item.column;
      while (!isFree(cursorRow, item.column, item.rowSpan, item.columnSpan)) cursorRow++;
      item.row = cursorRow;
    } else {
      for (;;) {
        if (cursorColumn + item.columnSpan > columnCount) {
          cursorRow++;
          cursorColumn = 0;
        }
        if (isFree(cursorRow, cursorColumn, item.rowSpan, item.columnSpan)) break;
        cursorColumn++;
      }
      item.row = cursorRow;
      item.column = cursorColumn;
      cursorColumn += item.columnSpan;
    }
    occupy(item);
  }

  const rowCount = Math.max(explicitRows.tracks.length, ...items.map((item) => item.row + item.rowSpan), 0);
  const columnTracks = Array.from({ length: columnCount }, (_, index) =>
    explicitColumns.tracks[index] ?? cycle(style?.gridAutoColumns, index - explicitColumns.tracks.length));
  const rowTracks = Array.from({ length: rowCount }, (_, index) =>
    explicitRows.tracks[index] ?? cycle(style?.gridAutoRows, index - explicitRows.tracks.length));
  // auto-fit: repeated tracks nobody occupies collapse (§7.2.3.2).
  const columnCollapsed = columnTracks.map((_, index) => explicitColumns.autoFit.has(index)
    && !items.some((item) => index >= item.column && index < item.column + item.columnSpan));
  return { items, columnTracks, rowTracks, columnCollapsed };
}

function cycle(tracks, index) {
  const list = tracks?.length ? tracks : [{ min: "auto", max: "auto" }];
  return list[((index % list.length) + list.length) % list.length];
}

function gridLines(style, explicitCount, axis) {
  const start = style?.[`grid${axis}Start`] ?? "auto";
  const end = style?.[`grid${axis}End`] ?? "auto";
  // Line numbers are 1-based; negatives count back from the explicit end line.
  const index = (line) => line > 0 ? line - 1 : Math.max(0, explicitCount + 1 + line);
  let from = start.line != null ? index(start.line) : null;
  let to = end.line != null ? index(end.line) : null;
  let span = 1;
  if (from != null && to != null) {
    if (to < from) [from, to] = [to, from];
    span = Math.max(1, to - from);
  } else if (from != null) {
    span = end.span ?? 1;
  } else if (to != null) {
    span = start.span ?? 1;
    from = Math.max(0, to - span);
  } else {
    // Two spans: the end span is discarded (§8.3.1).
    span = start.span ?? end.span ?? 1;
  }
  return axis === "Column" ? { column: from, columnSpan: span } : { row: from, rowSpan: span };
}

function rowLines(style, explicitCount) {
  return gridLines(style, explicitCount, "Row");
}

/** Expands repeat() and resolves auto-fill/auto-fit repetitions (§7.2.3.2). */
function expandTrackList(list, available, gap) {
  const tracks = [];
  const autoFit = new Set();
  if (!list) return { tracks, autoFit };
  const autoEntry = list.find((entry) => typeof entry.repeat === "string");
  let repetitions = 1;
  if (autoEntry && available != null) {
    const fixedSize = (track) => {
      const max = numberOrNull(resolveLength(track.max, available));
      const min = numberOrNull(resolveLength(track.min, available));
      return max ?? min;
    };
    const other = list.filter((entry) => entry !== autoEntry)
      .flatMap((entry) => entry.repeat ? Array(entry.repeat).fill(entry.tracks).flat() : [entry]);
    const repeated = autoEntry.tracks.map(fixedSize);
    if (repeated.every((size) => size != null)) {
      const otherSize = other.reduce((sum, track) => sum + (fixedSize(track) ?? 0), 0);
      const repetitionSize = repeated.reduce((sum, size) => sum + size, 0);
      const count = (n) => other.length + n * autoEntry.tracks.length;
      repetitions = 1;
      while (otherSize + (repetitions + 1) * repetitionSize + gap * (count(repetitions + 1) - 1) <= available + 0.01) {
        repetitions++;
      }
    }
  }
  for (const entry of list) {
    if (!entry.repeat) {
      tracks.push(entry);
      continue;
    }
    const count = typeof entry.repeat === "number" ? entry.repeat : repetitions;
    for (let index = 0; index < count; index++) {
      for (const track of entry.tracks) {
        if (entry.repeat === "auto-fit") autoFit.add(tracks.length);
        tracks.push(track);
      }
    }
  }
  return { tracks, autoFit };
}

/** Track sizing for columns (§12.3–§12.8, span-1 contributions, simplified spanning). */
/**
 * An item's minimum contribution for an auto track minimum (CSS Grid 2
 * §6.6/§12.5): a specified min-width, else 0 for scroll containers (overflow
 * other than visible), else its min-content contribution.
 */
function minimumContribution(box, minContent, available) {
  const style = box.style;
  const margin = style?.margin ?? ZERO_BOX;
  const margins = numberOrZero(margin[1]) + numberOrZero(margin[3]);
  const specified = numberOrNull(resolveLength(style?.minWidth, available));
  if (specified != null) {
    const padding = style?.padding ?? ZERO_BOX;
    const extra = padding[1] + padding[3] + borderWidths(style)[1] + borderWidths(style)[3];
    return (style.boxSizing === "border-box" ? Math.max(specified, extra) : specified + extra) + margins;
  }
  if (style?.overflowX === "clip" || style?.overflowY === "clip") return margins;
  return minContent;
}

function sizeGridColumns(ctx, box, grid, available, gap, definite, intrinsic = "max") {
  const tracks = grid.columnTracks.map((track, index) => {
    const collapsed = grid.columnCollapsed[index];
    const min = collapsed ? 0 : resolveBreadth(track.min, definite ? available : null);
    const max = collapsed ? 0 : resolveBreadth(track.max, definite ? available : null);
    return {
      min,
      max,
      base: typeof min === "number" ? min : 0,
      growth: typeof max === "number" ? max : max?.fr != null ? null : Infinity,
    };
  });
  const contributions = (item) => {
    const margin = item.box.style?.margin ?? ZERO_BOX;
    const margins = numberOrZero(margin[1]) + numberOrZero(margin[3]);
    return { min: minContentWidth(ctx, item.box) + margins, max: maxContentWidth(ctx, item.box) + margins };
  };

  // Intrinsic sizes from items spanning one track (§12.5 step 2).
  for (const item of grid.items.filter((candidate) => candidate.columnSpan === 1)) {
    const track = tracks[item.column];
    if (grid.columnCollapsed[item.column]) continue;
    const contribution = contributions(item);
    if (track.min === "min-content") track.base = Math.max(track.base, contribution.min);
    else if (track.min === "auto") track.base = Math.max(track.base, minimumContribution(item.box, contribution.min, available));
    else if (track.min === "max-content") track.base = Math.max(track.base, contribution.max);
    if (track.max === "min-content") track.growth = updateGrowth(track, contribution.min);
    else if (track.max === "max-content" || track.max === "auto") track.growth = updateGrowth(track, contribution.max);
    else if (track.max?.fitContent != null) {
      const limit = resolveLength(track.max.fitContent, available);
      track.growth = updateGrowth(track, Math.min(contribution.max, Math.max(contribution.min, limit)));
    }
  }
  for (const track of tracks) {
    if (track.growth === Infinity) track.growth = track.base;
    if (track.growth != null) track.growth = Math.max(track.growth, track.base);
  }
  // Items spanning several tracks grow the intrinsic ones they cross (§12.5 step 3, simplified).
  for (const item of grid.items.filter((candidate) => candidate.columnSpan > 1)) {
    const spanned = tracks.slice(item.column, item.column + item.columnSpan);
    const intrinsic = spanned.filter((track) => typeof track.min !== "number");
    if (!intrinsic.length) continue;
    const current = spanned.reduce((sum, track) => sum + track.base, 0) + gap * (item.columnSpan - 1);
    const extra = contributions(item).min - current;
    if (extra > 0) for (const track of intrinsic) track.base += extra / intrinsic.length;
    for (const track of spanned) if (track.growth != null) track.growth = Math.max(track.growth, track.base);
  }

  const visible = tracks.filter((_, index) => !grid.columnCollapsed[index]);
  const gaps = gap * Math.max(0, visible.length - 1);
  const sizes = () => tracks.reduce((sum, track) => sum + track.base, 0) + gaps;

  // Maximize tracks (§12.6): grow bases toward growth limits equally.
  if (definite) {
    for (let guard = 0; guard < tracks.length + 1; guard++) {
      const growable = tracks.filter((track) => track.growth != null && track.growth > track.base + 1e-9);
      const free = available - sizes();
      if (!growable.length || free <= 1e-9) break;
      const share = free / growable.length;
      for (const track of growable) track.base = Math.min(track.growth, track.base + share);
    }
  } else if (intrinsic === "max") {
    // Max-content sizing: every track takes its growth limit.
    for (const track of tracks) if (track.growth != null) track.base = track.growth;
  }

  // Expand flexible tracks (§12.7).
  const flexible = tracks.filter((track) => track.max?.fr != null);
  if (flexible.length) {
    let frSize;
    if (definite) {
      const leftover = available - gaps - tracks.filter((track) => track.max?.fr == null)
        .reduce((sum, track) => sum + track.base, 0);
      const inflexible = new Set();
      for (let guard = 0; guard <= flexible.length; guard++) {
        const active = flexible.filter((track) => !inflexible.has(track));
        const factors = Math.max(1, active.reduce((sum, track) => sum + track.max.fr, 0));
        const space = leftover - [...inflexible].reduce((sum, track) => sum + track.base, 0);
        frSize = Math.max(0, space / factors);
        const violators = active.filter((track) => track.base > frSize * track.max.fr);
        if (!violators.length) break;
        for (const track of violators) inflexible.add(track);
      }
    } else if (intrinsic === "min") {
      frSize = 0;
    } else {
      // Indefinite: the fr size that fits every track's max-content contribution (§12.7.2).
      frSize = 0;
      for (const item of grid.items.filter((candidate) => candidate.columnSpan === 1)) {
        const track = tracks[item.column];
        if (track.max?.fr > 0) frSize = Math.max(frSize, contributions(item).max / Math.max(1, track.max.fr));
      }
    }
    for (const track of flexible) track.base = Math.max(track.base, frSize * track.max.fr);
  }

  // Stretch auto tracks into leftover space (§12.8, justify-content: normal).
  if (definite && ["normal", "stretch"].includes(box.style?.justifyContent ?? "normal")) {
    const stretchable = tracks.filter((track, index) => track.max === "auto" && !grid.columnCollapsed[index]);
    const free = available - sizes();
    if (stretchable.length && free > 0) for (const track of stretchable) track.base += free / stretchable.length;
  }
  return tracks.map((track) => track.base);
}

/** An infinite growth limit takes the first contribution, then the largest. */
function updateGrowth(track, value) {
  return track.growth === Infinity ? value : Math.max(track.growth, value);
}

/** Row sizing: explicit lengths are fixed; other rows fit their tallest item. */
function sizeGridRows(grid, gap) {
  const rows = grid.rowTracks.map((track) => {
    const fixed = numberOrNull(resolveBreadth(track.min, null));
    const fixedMax = numberOrNull(resolveBreadth(track.max, null));
    return fixed != null && fixedMax != null ? { size: fixedMax, fixed: true } : { size: fixed ?? 0, fixed: false };
  });
  for (const item of grid.items.filter((candidate) => candidate.rowSpan === 1)) {
    const row = rows[item.row];
    if (!row.fixed) row.size = Math.max(row.size, item.height);
  }
  for (const item of grid.items.filter((candidate) => candidate.rowSpan > 1)) {
    const spanned = rows.slice(item.row, item.row + item.rowSpan);
    const current = spanned.reduce((sum, row) => sum + row.size, 0) + gap * (item.rowSpan - 1);
    const flexible = spanned.filter((row) => !row.fixed);
    if (item.height > current && flexible.length) flexible.at(-1).size += item.height - current;
  }
  return rows.map((row) => row.size);
}

function resolveBreadth(breadth, available) {
  if (typeof breadth === "string" || breadth?.fr != null || breadth?.fitContent != null) return breadth;
  const value = available == null && breadth?.unit ? null : resolveLength(breadth, available);
  return Number.isFinite(value) ? value : "auto";
}

function trackStarts(sizes, collapsed, gap, origin) {
  const starts = [];
  let cursor = origin;
  let placedAny = false;
  sizes.forEach((size, index) => {
    if (!collapsed[index] && placedAny) cursor += gap;
    starts.push(cursor);
    cursor += size;
    if (!collapsed[index]) placedAny = true;
  });
  return starts;
}

function spanSize(sizes, collapsed, gap, start, span) {
  let total = 0;
  let visible = 0;
  for (let index = start; index < start + span; index++) {
    total += sizes[index] ?? 0;
    if (!collapsed[index]) visible++;
  }
  return total + gap * Math.max(0, visible - 1);
}

function gridIntrinsicWidth(ctx, box, kind) {
  const gap = box.style?.columnGap ?? 0;
  const grid = gridStructure(ctx, box, null, gap, false);
  const columns = sizeGridColumns(ctx, box, grid, 0, gap, false, kind);
  const visible = columns.filter((_, index) => !grid.columnCollapsed[index]);
  return columns.reduce((sum, size) => sum + size, 0) + gap * Math.max(0, visible.length - 1);
}

/** Lays a box out off-screen to learn its height and baseline at a given width. */
function dryLayout(ctx, box, width) {
  const fragments = ctx.fragments;
  const boxes = ctx.boxes;
  ctx.fragments = [];
  ctx.boxes = [];
  const result = layoutBlock(ctx, box, 0, width, 0);
  ctx.fragments = fragments;
  ctx.boxes = boxes;
  return { height: result.height, baselineOffset: result.baseline };
}

/** Resolves the used border-box width and horizontal margins of a block-level box. */
function resolveHorizontal(ctx, box, containingX, containingWidth, shrink) {
  const style = box.style;
  const padding = style?.padding ?? ZERO_BOX;
  const extra = padding[1] + padding[3] + borderWidths(style)[1] + borderWidths(style)[3];
  const borderBox = (value) => style?.boxSizing === "border-box" ? value : value + extra;
  const margin = style?.margin ?? ZERO_BOX;
  let marginLeft = numberOrZero(margin[3]);
  let marginRight = numberOrZero(margin[1]);
  const available = Math.max(0, containingWidth - marginLeft - marginRight);
  const specified = numberOrNull(resolveLength(style?.width, containingWidth));
  let width;
  if (box.replaced) width = imageDimensions(box.node, containingWidth).width + extra;
  else if (specified != null) width = borderBox(specified);
  else if (shrink) width = Math.min(maxContentWidth(ctx, box), available);
  else width = available;
  const maxWidth = numberOrNull(resolveLength(style?.maxWidth, containingWidth));
  if (maxWidth != null) width = Math.min(width, borderBox(maxWidth));
  const minWidth = numberOrNull(resolveLength(style?.minWidth, containingWidth));
  if (minWidth != null) width = Math.max(width, borderBox(minWidth));
  width = Math.max(width, extra);

  const remaining = Math.max(0, containingWidth - width - marginLeft - marginRight);
  if (margin[3] === "auto" && margin[1] === "auto") {
    marginLeft += remaining / 2;
    marginRight += remaining / 2;
  } else if (margin[3] === "auto") {
    marginLeft += remaining;
  } else if (margin[1] === "auto") {
    marginRight += remaining;
  }
  return { x: containingX + marginLeft, width, marginLeft, marginRight };
}

function maxContentWidth(ctx, box) {
  const cached = ctx.maxContent.get(box);
  if (cached != null) return cached;
  const style = box.style;
  const padding = style?.padding ?? ZERO_BOX;
  const extra = padding[1] + padding[3] + borderWidths(style)[1] + borderWidths(style)[3];
  let width;
  const specified = numberOrNull(style?.width);
  if (box.replaced) {
    width = imageDimensions(box.node, Infinity).width + extra;
  } else if (specified != null) {
    width = style.boxSizing === "border-box" ? specified : specified + extra;
  } else if (box.table) {
    width = tableIntrinsicWidth(ctx, box, "max") + extra;
  } else if (box.grid) {
    width = gridIntrinsicWidth(ctx, box, "max") + extra;
  } else if (box.flex === "row") {
    const gap = style?.columnGap ?? style?.gap ?? 0;
    const content = box.children.reduce((sum, child, index) => {
      const margin = child.style?.margin ?? ZERO_BOX;
      return sum + (index ? gap : 0) + maxContentWidth(ctx, child) + numberOrZero(margin[1]) + numberOrZero(margin[3]);
    }, 0);
    width = content + extra;
  } else {
    let content = 0;
    for (const child of inFlowChildren(box)) {
      if (child.kind === "ifc") {
        content = Math.max(content, inlineMaxContentWidth(ctx, child));
      } else {
        const margin = child.style?.margin ?? ZERO_BOX;
        content = Math.max(content, maxContentWidth(ctx, child) + numberOrZero(margin[1]) + numberOrZero(margin[3]));
      }
    }
    width = content + extra;
  }
  const maxWidth = numberOrNull(style?.maxWidth);
  if (maxWidth != null) width = Math.min(width, style.boxSizing === "border-box" ? maxWidth : maxWidth + extra);
  ctx.maxContent.set(box, width);
  return width;
}

function minContentWidth(ctx, box) {
  const cached = ctx.minContent.get(box);
  if (cached != null) return cached;
  const style = box.style;
  const padding = style?.padding ?? ZERO_BOX;
  const extra = padding[1] + padding[3] + borderWidths(style)[1] + borderWidths(style)[3];
  const specified = numberOrNull(style?.width);
  const outer = (child) => {
    const margin = child.style?.margin ?? ZERO_BOX;
    return minContentWidth(ctx, child) + numberOrZero(margin[1]) + numberOrZero(margin[3]);
  };
  let width;
  if (box.replaced) {
    width = imageDimensions(box.node, Infinity).width + extra;
  } else if (specified != null) {
    width = style.boxSizing === "border-box" ? specified : specified + extra;
  } else if (box.table) {
    width = tableIntrinsicWidth(ctx, box, "min") + extra;
  } else if (box.grid) {
    width = gridIntrinsicWidth(ctx, box, "min") + extra;
  } else if (box.flex === "row" && style?.flexWrap !== "wrap") {
    const gap = style?.columnGap ?? style?.gap ?? 0;
    width = box.children.reduce((sum, child, index) => sum + (index ? gap : 0) + outer(child), 0) + extra;
  } else {
    width = Math.max(0, ...inFlowChildren(box).map((child) => child.kind === "ifc"
      ? inlineMinContentWidth(ctx, child)
      : outer(child))) + extra;
  }
  ctx.minContent.set(box, width);
  return width;
}

function verticalMargins(style) {
  const margin = style?.margin ?? ZERO_BOX;
  return { top: numberOrZero(margin[0]), bottom: numberOrZero(margin[2]) };
}

// Margin collapsing. A box collapses with its first/last in-flow child when
// it does not establish a BFC and has no border or padding on that side.

function collapsesThroughTop(box) {
  return !box.bfc && box.kind === "block" && !box.replaced
    && borderWidths(box.style)[0] === 0 && (box.style?.padding ?? ZERO_BOX)[0] === 0
    && inFlowChildren(box)[0]?.kind === "block";
}

function collapsesThroughBottom(box) {
  return !box.bfc && box.kind === "block" && !box.replaced
    && borderWidths(box.style)[2] === 0 && (box.style?.padding ?? ZERO_BOX)[2] === 0
    && numberOrNull(box.style?.height) == null
    && inFlowChildren(box).at(-1)?.kind === "block";
}

function topStrut(box) {
  const own = marginStrut(verticalMargins(box.style).top);
  return collapsesThroughTop(box) ? combineStruts(own, topStrut(inFlowChildren(box)[0])) : own;
}

function bottomStrut(box) {
  const own = marginStrut(verticalMargins(box.style).bottom);
  return collapsesThroughBottom(box) ? combineStruts(own, bottomStrut(inFlowChildren(box).at(-1))) : own;
}

function inFlowChildren(box) {
  return box.children.filter((child) => child.kind !== "placeholder");
}

function marginStrut(value) {
  return value >= 0 ? { positive: value, negative: 0 } : { positive: 0, negative: value };
}

function combineStruts(left, right) {
  return {
    positive: Math.max(left.positive, right.positive),
    negative: Math.min(left.negative, right.negative),
  };
}

function strutValue(strut) {
  return strut.positive + strut.negative;
}

// ---------------------------------------------------------------------------
// Inline formatting context

function layoutInline(ctx, ifc, x, width, y) {
  const paragraph = buildParagraph(ctx, ifc);
  const atoms = new Map();
  const atomFor = (run) => {
    let atom = atoms.get(run);
    if (!atom) {
      atom = measureAtomic(ctx, run.box, width);
      atoms.set(run, atom);
    }
    return atom;
  };
  const lines = breakLines(ctx, paragraph, width, atomFor);
  let cursor = y;
  let baseline = null;
  for (const line of lines) {
    const placed = placeLine(ctx, ifc, paragraph, line, x, width, cursor, atomFor);
    cursor += placed.height;
    baseline = placed.baseline;
  }
  return { bottom: cursor, baseline };
}

function inlineMaxContentWidth(ctx, ifc) {
  const paragraph = buildParagraph(ctx, ifc);
  const atomFor = (run) => {
    const margin = run.box.style?.margin ?? ZERO_BOX;
    return {
      width: maxContentWidth(ctx, run.box),
      marginLeft: numberOrZero(margin[3]),
      marginRight: numberOrZero(margin[1]),
    };
  };
  const lines = breakLines(ctx, paragraph, Infinity, atomFor);
  return Math.max(0, ...lines.map((line) => line.width));
}

/** The widest unbreakable piece: the narrowest width without overflow. */
function inlineMinContentWidth(ctx, ifc) {
  const paragraph = buildParagraph(ctx, ifc);
  const atomFor = (run) => {
    const margin = run.box.style?.margin ?? ZERO_BOX;
    return {
      width: minContentWidth(ctx, run.box),
      marginLeft: numberOrZero(margin[3]),
      marginRight: numberOrZero(margin[1]),
    };
  };
  return Math.max(0, ...paragraph.pieces.map((piece) =>
    rangeWidth(ctx, paragraph, piece.start, piece.end, atomFor)
      - trailingHangWidth(ctx, paragraph, piece.end, atomFor)));
}

/**
 * Converts inline items into one paragraph string plus runs. Collapsible white
 * space is collapsed across element boundaries; atomic inlines become U+FFFC.
 */
function buildParagraph(ctx, ifc) {
  if (ifc.paragraph) return ifc.paragraph;
  let text = "";
  const runs = [];
  const forced = new Map();
  const stack = [];
  const inlineState = new Map();
  let pendingOpens = [];
  let afterSpace = true;

  const lastCollapsibleRun = () => {
    const run = runs.at(-1);
    return run && run.end > run.start && run.collapsible && text[run.end - 1] === " " ? run : null;
  };
  const trimTrailingSpace = () => {
    const run = lastCollapsibleRun();
    if (run && run.end === text.length) {
      run.end--;
      text = text.slice(0, -1);
    }
  };
  const pushRun = (run, value) => {
    run.start = text.length;
    text += value;
    run.end = text.length;
    run.inlines = [...stack];
    run.opens = pendingOpens;
    run.closes = [];
    for (const open of pendingOpens) inlineState.get(open).firstRun = run;
    pendingOpens = [];
    for (const inline of stack) inlineState.get(inline).lastRun = run;
    runs.push(run);
  };

  for (const item of ifc.items) {
    if (item.kind === "open") {
      stack.push(item.node);
      inlineState.set(item.node, { style: item.style, firstRun: null, lastRun: null });
      pendingOpens.push(item.node);
    } else if (item.kind === "close") {
      const index = stack.lastIndexOf(item.node);
      if (index >= 0) stack.splice(index, 1);
      pendingOpens = pendingOpens.filter((node) => node !== item.node);
      inlineState.get(item.node)?.lastRun?.closes.unshift(item.node);
    } else if (item.kind === "text") {
      let value = String(item.text).replace(/\r\n?/g, "\n");
      if (item.preserve) {
        const pieces = value.split("\n");
        pieces.forEach((piece, index) => {
          if (index > 0) forced.set(text.length, (forced.get(text.length) ?? 0) + 1);
          if (piece) {
            pushRun({ kind: "text", nodeId: item.node.id, style: item.style, collapsible: false, wrap: item.wrap }, piece);
          }
        });
        afterSpace = false;
      } else {
        value = value.replace(/[\t\n\f\r ]+/g, " ");
        if (afterSpace) value = value.replace(/^ /, "");
        if (value) {
          pushRun({ kind: "text", nodeId: item.node.id, style: item.style, collapsible: true, wrap: item.wrap }, value);
          afterSpace = value.endsWith(" ");
        }
      }
    } else if (item.kind === "break") {
      trimTrailingSpace();
      forced.set(text.length, (forced.get(text.length) ?? 0) + 1);
      afterSpace = true;
    } else if (item.kind === "image" || item.kind === "atomic") {
      pushRun({ kind: item.kind, nodeId: item.node.id, style: item.node.style ?? null, node: item.node, box: item.box, wrap: true }, "￼");
      afterSpace = false;
    }
  }
  trimTrailingSpace();

  const visibleRuns = runs;
  for (const run of visibleRuns) {
    run.startInset = run.opens.reduce((sum, node) => sum + inlineInsets(inlineState.get(node).style).left, 0);
    run.endInset = run.closes.reduce((sum, node) => sum + inlineInsets(inlineState.get(node).style).right, 0);
  }

  const runAt = new Array(text.length);
  for (const run of visibleRuns) for (let index = run.start; index < run.end; index++) runAt[index] = run;
  const opportunities = new Set();
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
  for (const { segment, index } of graphemes) {
    const run = runAt[index];
    const end = index + segment.length;
    if (!run) continue;
    if (run.collapsible && run.wrap && segment === " ") opportunities.add(end);
    else if (run.kind === "image" || run.kind === "atomic") {
      opportunities.add(index);
      opportunities.add(end);
    } else if (run.wrap && run.kind === "text" && (Bun.stringWidth(segment) > 1 || (!run.collapsible && segment === " "))) {
      if (Bun.stringWidth(segment) > 1) opportunities.add(index);
      opportunities.add(end);
    }
  }

  const pieces = [];
  let start = 0;
  const pushPiece = (end, forcedCount) => {
    pieces.push({ start, end, forced: forcedCount > 0 });
    for (let count = 1; count < forcedCount; count++) pieces.push({ start: end, end, forced: true });
    start = end;
  };
  for (let position = 0; position <= text.length; position++) {
    const forcedCount = forced.get(position) ?? 0;
    if (forcedCount > 0) pushPiece(position, forcedCount);
    else if (position > start && (opportunities.has(position) || position === text.length)) pushPiece(position, 0);
  }

  ifc.paragraph = { text, runs: visibleRuns, runAt, pieces, inlineState, graphemes };
  return ifc.paragraph;
}

/** CSS Text 3 §5.2/§5.5: breaking inside a word needs overflow-wrap or word-break. */
function mayBreakWithinWords(paragraph, piece) {
  const run = paragraph.runAt[piece.start];
  const style = run?.style;
  // white-space: nowrap / pre never wrap, whatever overflow-wrap says.
  if (!style || run.wrap === false) return false;
  return (style.overflowWrap ?? "normal") !== "normal" || style.wordBreak === "break-all" || style.wordBreak === "break-word";
}

/**
 * text-overflow: ellipsis (CSS Overflow 3 §3): a line wider than a clipping
 * block container loses content from its end, at grapheme boundaries, to make
 * room for "…". Mutates `segments`; returns the ellipsis to append, or null.
 */
function truncateForEllipsis(ctx, style, paragraph, segments, line, width) {
  if (style?.textOverflow !== "ellipsis" || style.overflowX !== "clip" || line.width <= width + 0.5) return null;
  const lastText = [...segments].reverse().find((segment) => segment.run.kind === "text");
  if (!lastText) return null;
  const text = "\u2026";
  const ellipsisWidth = ctx.measure(text, lastText.run.style);
  let budget = width - ellipsisWidth;
  let keep = 0;
  for (; keep < segments.length; keep++) {
    const segment = segments[keep];
    if (segment.width <= budget) {
      budget -= segment.width;
      continue;
    }
    if (segment.run.kind === "text") {
      // The longest grapheme-aligned prefix that fits.
      let end = segment.start;
      let used = 0;
      for (const { index, segment: grapheme } of paragraph.graphemes) {
        if (index < segment.start || index >= segment.end) continue;
        const next = ctx.measure(paragraph.text.slice(segment.start, index + grapheme.length), segment.run.style);
        if (next > budget) break;
        end = index + grapheme.length;
        used = next;
      }
      if (end > segment.start) {
        segments[keep] = { ...segment, end, width: used };
        keep++;
      }
    }
    break;
  }
  segments.splice(keep);
  line.width = segments.reduce((sum, segment) => sum + segment.width, 0) + ellipsisWidth;
  return { text, width: ellipsisWidth, run: lastText.run, metrics: textMetrics(ctx, lastText.run.style) };
}

function inlineImageMargins(node) {
  const margin = node.style?.margin ?? ZERO_BOX;
  return { left: numberOrZero(margin[3]), right: numberOrZero(margin[1]) };
}

/**
 * The top of an inline image relative to the baseline (CSS 2 §10.8.1
 * vertical-align), with the line's text metrics for text-top/text-bottom.
 */
function inlineImageTop(style, height, metrics) {
  switch (style?.verticalAlign) {
    case "text-bottom":
    case "bottom":
      return metrics.descent - height;
    case "text-top":
    case "top":
      return -metrics.ascent;
    case "middle":
      // Centred on the baseline plus half the x-height (about 0.25em).
      return -(style.fontSize ?? 16) * 0.25 - height / 2;
    default:
      return -height;
  }
}

function inlineInsets(style) {
  const margin = style?.margin ?? ZERO_BOX;
  const padding = style?.padding ?? ZERO_BOX;
  const border = borderWidths(style);
  return {
    left: numberOrZero(margin[3]) + border[3] + padding[3],
    right: numberOrZero(margin[1]) + border[1] + padding[1],
  };
}

function rangeWidth(ctx, paragraph, start, end, atomFor) {
  let width = 0;
  for (const run of paragraph.runs) {
    if (run.end <= start || run.start >= end) continue;
    if (run.start >= start) width += run.startInset;
    if (run.end <= end) width += run.endInset;
    width += runSliceWidth(ctx, run, Math.max(start, run.start), Math.min(end, run.end), paragraph.text, atomFor);
  }
  return width;
}

function runSliceWidth(ctx, run, start, end, text, atomFor) {
  if (end <= start) return 0;
  if (run.kind === "image") {
    const margins = inlineImageMargins(run.node);
    return imageDimensions(run.node, Infinity).width + margins.left + margins.right;
  }
  if (run.kind === "atomic") {
    const atom = atomFor(run);
    return atom.width + atom.marginLeft + atom.marginRight;
  }
  return ctx.measure(text.slice(start, end), run.style);
}

function trailingHangWidth(ctx, paragraph, end, atomFor) {
  const run = paragraph.runAt[end - 1];
  if (!run?.collapsible || paragraph.text[end - 1] !== " ") return 0;
  return runSliceWidth(ctx, run, end - 1, end, paragraph.text, atomFor);
}

function breakLines(ctx, paragraph, maxWidth, atomFor) {
  const lines = [];
  let line = null;
  const finish = () => {
    if (!line) return;
    let end = line.end;
    while (end > line.start && paragraph.runAt[end - 1]?.collapsible && paragraph.text[end - 1] === " ") end--;
    // Use the same piece-wise sum the break decision used, so a max-content
    // width measured here never wraps when laid out at exactly that width.
    lines.push({ start: line.start, end, width: line.width - (line.hang ?? 0) });
    line = null;
  };

  for (const piece of paragraph.pieces) {
    const width = rangeWidth(ctx, paragraph, piece.start, piece.end, atomFor);
    const hang = trailingHangWidth(ctx, paragraph, piece.end, atomFor);
    if (line && line.width + width - hang > maxWidth + 0.01) finish();
    if (!line && width - hang > maxWidth + 0.01 && piece.end - piece.start > 1 && mayBreakWithinWords(paragraph, piece)) {
      // Emergency break inside an unbreakable piece, one grapheme at a time
      // (only where overflow-wrap or word-break allow it; otherwise it overflows).
      let start = piece.start;
      let used = 0;
      for (const { segment, index } of paragraph.graphemes) {
        if (index < piece.start || index >= piece.end) continue;
        const graphemeWidth = rangeWidth(ctx, paragraph, index, index + segment.length, atomFor);
        if (index > start && used + graphemeWidth > maxWidth + 0.01) {
          line = { start, end: index, width: used, hang: 0 };
          finish();
          start = index;
          used = 0;
        }
        used += graphemeWidth;
      }
      line = { start, end: piece.end, width: used, hang: 0 };
    } else if (line) {
      line.end = piece.end;
      line.width += width;
      line.hang = hang;
    } else {
      line = { start: piece.start, end: piece.end, width, hang };
    }
    if (piece.forced) {
      line ??= { start: piece.end, end: piece.end, width: 0, hang: 0 };
      finish();
    }
  }
  finish();
  return lines;
}

function placeLine(ctx, ifc, paragraph, line, x, width, y, atomFor) {
  const style = ifc.style;
  const segments = [];
  for (const run of paragraph.runs) {
    const start = Math.max(line.start, run.start);
    const end = Math.min(line.end, run.end);
    if (end <= start) continue;
    segments.push({ run, start, end, width: runSliceWidth(ctx, run, start, end, paragraph.text, atomFor) });
  }

  // Vertical metrics: align every item on a shared baseline, including the
  // container's strut.
  const strut = textMetrics(ctx, style);
  let ascent = strut.ascent;
  let descent = strut.descent;
  for (const segment of segments) {
    const { run } = segment;
    if (run.kind === "image") {
      segment.dimensions = imageDimensions(run.node, width);
      segment.imageTop = inlineImageTop(run.node.style, segment.dimensions.height, strut);
      ascent = Math.max(ascent, -segment.imageTop);
      descent = Math.max(descent, segment.imageTop + segment.dimensions.height);
    } else if (run.kind === "atomic") {
      const atom = atomFor(run);
      const atomAscent = atom.marginTop + (atom.baseline ?? atom.height) ;
      segment.atomAscent = atomAscent;
      ascent = Math.max(ascent, atomAscent);
      descent = Math.max(descent, atom.marginTop + atom.height + atom.marginBottom - atomAscent);
    } else {
      segment.metrics = textMetrics(ctx, run.style);
      ascent = Math.max(ascent, segment.metrics.ascent);
      descent = Math.max(descent, segment.metrics.descent);
    }
  }
  const baselineY = y + ascent;
  const lineHeight = ascent + descent;

  // Horizontal alignment.
  const alignment = style?.textAlign;
  const free = Math.max(0, width - line.width);
  const lineX = x + (alignment === "center" ? free / 2 : alignment === "end" ? free : 0);

  const ellipsis = truncateForEllipsis(ctx, style, paragraph, segments, line, width);

  let cursor = lineX;
  const edges = new Map();
  const runs = [];
  const atomsToPlace = [];
  // Right floats (approximated as atomic inlines) go to the end of the line.
  const rightFloats = segments.filter((segment) => segment.run.kind === "atomic" && segment.run.style?.float === "right");
  const rightFloatWidth = rightFloats.reduce((sum, segment) => sum + segment.width, 0);
  const ordered = rightFloats.length
    ? [...segments.filter((segment) => !rightFloats.includes(segment)), ...rightFloats]
    : segments;
  for (const segment of ordered) {
    const { run } = segment;
    if (segment === rightFloats[0]) cursor = Math.max(cursor, x + width - rightFloatWidth);
    if (segment.start === run.start) {
      for (const node of run.opens) {
        const insets = inlineInsets(paragraph.inlineState.get(node).style);
        const margin = paragraph.inlineState.get(node).style?.margin ?? ZERO_BOX;
        edges.set(node, { ...edges.get(node), left: cursor + numberOrZero(margin[3]) });
        cursor += insets.left;
      }
    }
    const segmentWidth = segment.width;
    const common = {
      nodeId: run.nodeId,
      text: run.kind === "text" ? paragraph.text.slice(segment.start, segment.end) : "",
      start: segment.start - line.start,
      end: segment.end - line.start,
      style: run.style ?? style,
    };
    if (run.kind === "image") {
      runs.push({
        ...common,
        type: "image",
        x: cursor + inlineImageMargins(run.node).left,
        y: baselineY + segment.imageTop,
        width: segment.dimensions.width,
        height: segment.dimensions.height,
        resource: run.node.resource,
        video: run.node.tagName === "VIDEO",
        svg: run.node.svg ?? null,
      });
    } else if (run.kind === "atomic") {
      const atom = atomFor(run);
      const atomY = baselineY - segment.atomAscent + atom.marginTop;
      runs.push({ ...common, type: "atomic", x: cursor, y: atomY, width: segmentWidth, height: atom.height });
      atomsToPlace.push({ box: run.box, x: cursor + atom.marginLeft, y: atomY, width: atom.width });
    } else {
      runs.push({
        ...common,
        x: cursor,
        y: baselineY - segment.metrics.contentAscent,
        width: Math.max(1, segmentWidth),
        height: null,
      });
    }
    for (const node of run.inlines) {
      const edge = edges.get(node) ?? {};
      edge.first ??= cursor;
      edge.last = cursor + segmentWidth;
      edges.set(node, edge);
    }
    cursor += segmentWidth;
    if (segment.end === run.end) {
      for (const node of run.closes) {
        const state = paragraph.inlineState.get(node);
        const insets = inlineInsets(state.style);
        const margin = state.style?.margin ?? ZERO_BOX;
        cursor += insets.right;
        const edge = edges.get(node) ?? {};
        edge.right = cursor - numberOrZero(margin[1]);
        edges.set(node, edge);
      }
    }
  }
  if (ellipsis) {
    const end = segments.at(-1)?.end ?? line.start;
    runs.push({
      nodeId: ellipsis.run.nodeId,
      text: ellipsis.text,
      start: end - line.start,
      end: end - line.start,
      style: ellipsis.run.style ?? style,
      x: cursor,
      y: baselineY - ellipsis.metrics.contentAscent,
      width: ellipsis.width,
      height: null,
    });
    cursor += ellipsis.width;
  }

  // Decorated inline boxes (background/border) for this line.
  for (const [node, edge] of edges) {
    const nodeStyle = paragraph.inlineState.get(node)?.style;
    if (!isDecorated(nodeStyle) || edge.first == null) continue;
    const padding = nodeStyle.padding ?? ZERO_BOX;
    const border = borderWidths(nodeStyle);
    const metrics = textMetrics(ctx, nodeStyle);
    const left = edge.left ?? edge.first;
    const right = edge.right ?? edge.last;
    ctx.boxes.push({
      nodeId: node.id,
      x: left,
      y: baselineY - metrics.contentAscent - padding[0] - border[0],
      width: right - left,
      height: metrics.contentHeight + padding[0] + padding[2] + border[0] + border[2],
      style: nodeStyle,
      inline: true,
    });
  }

  ctx.fragments.push(lineFragment(
    style,
    paragraph.text.slice(line.start, line.end),
    [...new Set(runs.map((run) => run.nodeId))],
    runs,
    lineX,
    y,
    line.width,
    lineHeight,
    baselineY,
  ));
  for (const atom of atomsToPlace) layoutBlock(ctx, atom.box, atom.x, atom.width, atom.y);
  return { height: lineHeight, baseline: baselineY };
}

function measureAtomic(ctx, box, availableWidth) {
  const placed = resolveHorizontal(ctx, box, 0, availableWidth, true);
  const result = dryLayout(ctx, box, placed.width);
  const margin = verticalMargins(box.style);
  return {
    width: placed.width,
    height: result.height,
    baseline: result.baselineOffset,
    marginLeft: placed.marginLeft,
    marginRight: placed.marginRight,
    marginTop: margin.top,
    marginBottom: margin.bottom,
  };
}

function textMetrics(ctx, style) {
  const font = ctx.metrics(style);
  // `line-height: normal` (null) uses the font's own content height.
  const lineHeight = ctx.lineHeight ?? (style ? style.lineHeight ?? font.height : ctx.fallbackLineHeight);
  const halfLeading = (lineHeight - font.height) / 2;
  const ascent = halfLeading + font.ascent;
  return { ascent, descent: lineHeight - ascent, contentAscent: font.ascent, contentHeight: font.height };
}

function isDecorated(style) {
  return Boolean(style && ((style.backgroundColor && style.backgroundColor !== "rgba(0, 0, 0, 0)")
    || borderWidths(style).some((width) => width > 0)));
}

function borderWidths(style) {
  return style?.borderWidths ?? ZERO_BOX;
}

function lineFragment(style, text, nodeIds, runs, x, y, width, height, baseline = null) {
  return {
    type: "line",
    baseline,
    text,
    nodeIds: Object.freeze(nodeIds),
    runs: Object.freeze(runs.map((run) => Object.freeze(run))),
    x,
    y,
    width,
    height: Math.max(height, ...runs.map((run) => run.height ?? 0)),
    style,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers

function cachedMeasure(measureText) {
  const byStyle = new Map();
  return (text, style) => {
    if (!text) return 0;
    let cache = byStyle.get(style ?? null);
    if (!cache) byStyle.set(style ?? null, cache = new Map());
    let width = cache.get(text);
    if (width === undefined) cache.set(text, width = measureText(text, style ?? null));
    return width;
  };
}

function cachedMetrics(fontMetrics) {
  const cache = new Map();
  return (style) => {
    const fontSize = style?.fontSize ?? 16;
    const key = `${fontSize}/${style?.fontWeight ?? 400}/${style?.fontFamily?.join(",")}`;
    let metrics = cache.get(key);
    if (!metrics) {
      metrics = typeof fontMetrics === "function" ? fontMetrics(style ?? null) : null;
      if (!(metrics?.height > 0)) {
        metrics = { ascent: fontSize * DEFAULT_ASCENT, height: fontSize * DEFAULT_CONTENT_HEIGHT };
      }
      cache.set(key, metrics);
    }
    return metrics;
  };
}

function imageDimensions(node, referenceWidth) {
  const intrinsicWidth = node.resource?.width ?? node.widthAttribute ?? 300;
  const intrinsicHeight = node.resource?.height ?? node.heightAttribute ?? 150;
  const ratio = intrinsicWidth / intrinsicHeight;
  const cssWidth = node.style?.width;
  const cssHeight = node.style?.height;
  let width = cssWidth !== "auto" && cssWidth != null
    ? resolveLength(cssWidth, referenceWidth)
    : node.widthAttribute;
  let height = cssHeight !== "auto" && cssHeight != null
    ? resolveLength(cssHeight, referenceWidth)
    : node.heightAttribute;
  if (!Number.isFinite(width)) width = null;
  if (!Number.isFinite(height)) height = null;
  if (width == null && height == null) [width, height] = [intrinsicWidth, intrinsicHeight];
  else if (width == null) width = height * ratio;
  else if (height == null) height = width / ratio;
  if (node.style?.maxWidth !== "none" && node.style?.maxWidth != null) {
    const maximum = resolveLength(node.style.maxWidth, referenceWidth);
    if (Number.isFinite(maximum) && width > maximum) [width, height] = [maximum, maximum / ratio];
  }
  if (node.tagName === "VIDEO") {
    if (Number.isFinite(referenceWidth) && width > referenceWidth) [width, height] = [referenceWidth, referenceWidth / ratio];
    const minHeight = resolveLength(node.style?.minHeight, referenceWidth);
    const maxHeight = resolveLength(node.style?.maxHeight, referenceWidth);
    if (Number.isFinite(minHeight) && height < minHeight) height = minHeight;
    if (Number.isFinite(maxHeight) && height > maxHeight) [width, height] = [maxHeight * ratio, maxHeight];
  }
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function resolveLength(value, reference) {
  if (!value || typeof value !== "object") return value;
  if (value.unit === "%") return reference * value.value / 100;
  if (value.unit === "math" && value.kind === "calc") return value.px + reference * value.percent / 100;
  if (value.unit === "math") {
    const values = value.values.map((part) => resolveLength(part, reference));
    if (value.kind === "min") return Math.min(...values);
    if (value.kind === "max") return Math.max(...values);
    return Math.max(values[0], Math.min(values[1], values[2]));
  }
  return value;
}
