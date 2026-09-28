/**
 * Box-tree layout: block formatting contexts with margin collapsing, inline
 * formatting contexts with line boxes, atomic inlines, and a flex
 * approximation (column items are stacked; row items are flattened onto lines).
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
  };

  const root = buildBox(tree.root, inheritedFlags(tree.root, { preserve: false, wrap: true }));
  const containingWidth = options.measureText || viewportWidth
    ? Math.max(1, (viewportWidth || columns * columnWidth) - x * 2)
    : columns * columnWidth;
  const horizontal = resolveHorizontal(ctx, root, x, containingWidth, false);
  const margin = verticalMargins(root.style);
  const result = layoutBlock(ctx, root, horizontal.x, horizontal.width, y + margin.top);
  const height = y + margin.top + result.height + margin.bottom;

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

function buildBox(node, flags, blockified = false) {
  const style = node.style ?? null;
  if (node.type === "image") {
    return { kind: "block", node, style, replaced: true, bfc: true, children: [] };
  }
  const flex = ["flex", "inline-flex"].includes(node.type)
    ? style?.flexDirection === "column" ? "column" : "row"
    : null;
  const box = {
    kind: "block",
    node,
    style,
    flex,
    bfc: blockified || node.type === "root" || flex !== null || isAtomic(node),
    children: [],
  };
  if (flex === "row") {
    const items = flattenFlexRow(node, flags);
    if (hasInlineContent(items)) box.children = [{ kind: "ifc", node, style, items, flexRow: true }];
  } else if (flex === "column") {
    for (const child of node.children) {
      if (child.type === "line-break" || (child.type === "text" && !child.text.trim())) continue;
      if (child.type === "text") {
        box.children.push({ kind: "ifc", node, style, items: [textItem(child, flags)] });
      } else {
        box.children.push(buildBox(child, inheritedFlags(child, flags), true));
      }
    }
  } else {
    box.children = blockChildren(node, flags);
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
    if (child.type === "text") {
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

function flattenFlexRow(container, flags) {
  const items = [];

  function row(node, rowFlags) {
    const children = node.children.filter((child) => child.type !== "text" || child.text.trim());
    children.forEach((child, index) => {
      if (index > 0) items.push({ kind: "gap", node, style: node.style ?? null });
      flexItem(child, inheritedFlags(child, rowFlags));
    });
  }

  function flexItem(child, childFlags) {
    if (child.type === "text") items.push(textItem(child, childFlags));
    else if (child.type === "line-break") items.push({ kind: "break", node: child });
    else if (child.type === "image") items.push({ kind: "image", node: child });
    else if (isAtomic(child) || (child.type === "flex" && child.style?.flexDirection === "column")
      || hasBlockDescendant(child)) {
      items.push({ kind: "atomic", node: child, box: buildBox(child, childFlags, true) });
    } else {
      items.push({ kind: "open", node: child, style: child.style ?? null });
      if (child.type === "flex") row(child, childFlags);
      else for (const grandchild of child.children) inline(grandchild, inheritedFlags(grandchild, childFlags));
      items.push({ kind: "close", node: child });
    }
  }

  function inline(node, nodeFlags) {
    if (node.type === "text") items.push(textItem(node, nodeFlags));
    else if (node.type === "line-break") items.push({ kind: "break", node });
    else if (node.type === "image") items.push({ kind: "image", node });
    else if (isAtomic(node)) items.push({ kind: "atomic", node, box: buildBox(node, nodeFlags) });
    else {
      items.push({ kind: "open", node, style: node.style ?? null });
      for (const child of node.children) inline(child, inheritedFlags(child, nodeFlags));
      items.push({ kind: "close", node });
    }
  }

  row(container, flags);
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

function isBlockLevel(node) {
  return ["block", "flex"].includes(node.type) || (node.type === "image" && node.style?.display === "block");
}

function isAtomic(node) {
  return ["inline-block", "inline-flex"].includes(node.type);
}

function hasBlockDescendant(node) {
  return node.children.some((child) => isBlockLevel(child)
    || (!isAtomic(child) && child.type !== "text" && hasBlockDescendant(child)));
}

function hasInlineContent(items) {
  return items.some((item) => item.kind === "text"
    ? item.preserve ? item.text.length > 0 : /[^\t\n\f\r ]/.test(item.text)
    : ["break", "image", "atomic"].includes(item.kind));
}

// ---------------------------------------------------------------------------
// Block layout

function layoutBlock(ctx, box, x, width, y, absorbTop = false) {
  const style = box.style;
  const border = style?.borderWidth ?? 0;
  const padding = style?.padding ?? ZERO_BOX;
  const record = { nodeId: box.node.id, x, y, width, height: 0, style };
  ctx.boxes.push(record);
  if (box.replaced) {
    const dimensions = imageDimensions(box.node, width);
    const imageX = x + border + padding[3];
    const imageY = y + border + padding[0];
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
    }], imageX, imageY, dimensions.width, dimensions.height));
    record.height = dimensions.height + padding[0] + padding[2] + border * 2;
    return { height: record.height, baseline: null };
  }

  const contentX = x + border + padding[3];
  const contentWidth = Math.max(1, width - border * 2 - padding[1] - padding[3]);
  const contentTop = y + border + padding[0];
  let contentBottom = contentTop;
  let baseline = null;

  if (box.flex === "column") {
    const gap = style?.gap ?? 0;
    let cursor = contentTop;
    box.children.forEach((child, index) => {
      if (index > 0) cursor += gap;
      if (child.kind === "ifc") {
        const result = layoutInline(ctx, child, contentX, contentWidth, cursor);
        cursor = result.bottom;
        baseline = result.baseline ?? baseline;
        return;
      }
      const alignment = style?.alignItems ?? "normal";
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
    box.children.forEach((child, index) => {
      if (child.kind === "ifc") {
        cursor += strutValue(pending ?? ZERO_STRUT);
        pending = ZERO_STRUT;
        const result = layoutInline(ctx, child, contentX, contentWidth, cursor);
        cursor = result.bottom;
        baseline = result.baseline ?? baseline;
        return;
      }
      const combined = index === 0 && absorbTop
        ? ZERO_STRUT
        : combineStruts(pending ?? ZERO_STRUT, topStrut(child));
      const childY = cursor + strutValue(combined);
      const placed = resolveHorizontal(ctx, child, contentX, contentWidth, false);
      const result = layoutBlock(ctx, child, placed.x, placed.width, childY, collapsesThroughTop(child));
      cursor = childY + result.height;
      pending = bottomStrut(child);
      baseline = result.baseline ?? baseline;
    });
    contentBottom = collapsesThroughBottom(box) ? cursor : cursor + strutValue(pending ?? ZERO_STRUT);
  }

  let contentHeight = Math.max(0, contentBottom - contentTop);
  const specifiedHeight = numberOrNull(style?.height);
  if (specifiedHeight != null) {
    contentHeight = style.boxSizing === "border-box"
      ? Math.max(0, specifiedHeight - border * 2 - padding[0] - padding[2])
      : specifiedHeight;
  }
  record.height = contentHeight + padding[0] + padding[2] + border * 2;
  return { height: record.height, baseline };
}

/** Resolves the used border-box width and horizontal margins of a block-level box. */
function resolveHorizontal(ctx, box, containingX, containingWidth, shrink) {
  const style = box.style;
  const padding = style?.padding ?? ZERO_BOX;
  const border = style?.borderWidth ?? 0;
  const extra = padding[1] + padding[3] + border * 2;
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
  const extra = padding[1] + padding[3] + (style?.borderWidth ?? 0) * 2;
  let width;
  const specified = numberOrNull(style?.width);
  if (box.replaced) {
    width = imageDimensions(box.node, Infinity).width + extra;
  } else if (specified != null) {
    width = style.boxSizing === "border-box" ? specified : specified + extra;
  } else {
    let content = 0;
    for (const child of box.children) {
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

function verticalMargins(style) {
  const margin = style?.margin ?? ZERO_BOX;
  return { top: numberOrZero(margin[0]), bottom: numberOrZero(margin[2]) };
}

// Margin collapsing. A box collapses with its first/last in-flow child when
// it does not establish a BFC and has no border or padding on that side.

function collapsesThroughTop(box) {
  return !box.bfc && box.kind === "block" && !box.replaced
    && (box.style?.borderWidth ?? 0) === 0 && (box.style?.padding ?? ZERO_BOX)[0] === 0
    && box.children[0]?.kind === "block";
}

function collapsesThroughBottom(box) {
  return !box.bfc && box.kind === "block" && !box.replaced
    && (box.style?.borderWidth ?? 0) === 0 && (box.style?.padding ?? ZERO_BOX)[2] === 0
    && numberOrNull(box.style?.height) == null
    && box.children.at(-1)?.kind === "block";
}

function topStrut(box) {
  const own = marginStrut(verticalMargins(box.style).top);
  return collapsesThroughTop(box) ? combineStruts(own, topStrut(box.children[0])) : own;
}

function bottomStrut(box) {
  const own = marginStrut(verticalMargins(box.style).bottom);
  return collapsesThroughBottom(box) ? combineStruts(own, bottomStrut(box.children.at(-1))) : own;
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
    } else if (item.kind === "gap") {
      trimTrailingSpace();
      pushRun({ kind: "gap", nodeId: item.node.id, style: item.style, collapsible: true, wrap: true }, " ");
      afterSpace = true;
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
    if (run.kind === "gap" || (run.collapsible && run.wrap && segment === " ")) opportunities.add(end);
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

function inlineInsets(style) {
  const margin = style?.margin ?? ZERO_BOX;
  const padding = style?.padding ?? ZERO_BOX;
  const border = style?.borderWidth ?? 0;
  return {
    left: numberOrZero(margin[3]) + border + padding[3],
    right: numberOrZero(margin[1]) + border + padding[1],
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
  if (run.kind === "gap") return gapWidth(ctx, run);
  if (run.kind === "image") return imageDimensions(run.node, Infinity).width;
  if (run.kind === "atomic") {
    const atom = atomFor(run);
    return atom.width + atom.marginLeft + atom.marginRight;
  }
  return ctx.measure(text.slice(start, end), run.style);
}

function gapWidth(ctx, run) {
  return run.style?.gap > 0 ? run.style.gap : ctx.measure(" ", null);
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
    lines.push({ start: line.start, end, width: rangeWidth(ctx, paragraph, line.start, end, atomFor) });
    line = null;
  };

  for (const piece of paragraph.pieces) {
    const width = rangeWidth(ctx, paragraph, piece.start, piece.end, atomFor);
    const hang = trailingHangWidth(ctx, paragraph, piece.end, atomFor);
    if (line && line.width + width - hang > maxWidth + 0.01) finish();
    if (!line && width - hang > maxWidth + 0.01 && piece.end - piece.start > 1) {
      // Emergency break inside an unbreakable piece, one grapheme at a time.
      let start = piece.start;
      let used = 0;
      for (const { segment, index } of paragraph.graphemes) {
        if (index < piece.start || index >= piece.end) continue;
        const graphemeWidth = rangeWidth(ctx, paragraph, index, index + segment.length, atomFor);
        if (index > start && used + graphemeWidth > maxWidth + 0.01) {
          line = { start, end: index, width: used };
          finish();
          start = index;
          used = 0;
        }
        used += graphemeWidth;
      }
      line = { start, end: piece.end, width: used };
    } else if (line) {
      line.end = piece.end;
      line.width += width;
    } else {
      line = { start: piece.start, end: piece.end, width };
    }
    if (piece.forced) {
      line ??= { start: piece.end, end: piece.end, width: 0 };
      finish();
    }
  }
  finish();
  return lines;
}

function placeLine(ctx, ifc, paragraph, line, x, width, y, atomFor) {
  const style = ifc.style;
  const flexRow = ifc.flexRow === true;
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
      ascent = Math.max(ascent, segment.dimensions.height);
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
  const alignment = flexRow && style?.display !== "inline-flex" && style?.flexDirection !== "column"
    ? style?.justifyContent
    : style?.textAlign;
  const free = Math.max(0, width - line.width);
  const gapRuns = flexRow
    ? segments.filter((segment) => segment.run.kind === "gap" && segment.run.nodeId === ifc.node.id)
    : [];
  let distributed = 0;
  let inset = 0;
  if (gapRuns.length && alignment === "space-between") {
    distributed = free / gapRuns.length;
  } else if (gapRuns.length && alignment === "space-around") {
    distributed = free / (gapRuns.length + 1);
    inset = distributed / 2;
  } else if (gapRuns.length && alignment === "space-evenly") {
    distributed = free / (gapRuns.length + 2);
    inset = distributed;
  }
  const lineX = x + inset + (alignment === "center" ? free / 2 : alignment === "end" ? free : 0);

  let cursor = lineX;
  const edges = new Map();
  const runs = [];
  const atomsToPlace = [];
  for (const segment of segments) {
    const { run } = segment;
    if (segment.start === run.start) {
      for (const node of run.opens) {
        const insets = inlineInsets(paragraph.inlineState.get(node).style);
        const margin = paragraph.inlineState.get(node).style?.margin ?? ZERO_BOX;
        edges.set(node, { ...edges.get(node), left: cursor + numberOrZero(margin[3]) });
        cursor += insets.left;
      }
    }
    let segmentWidth = segment.width;
    if (run.kind === "gap" && gapRuns.includes(segment)) segmentWidth += distributed;
    const common = {
      nodeId: run.nodeId,
      text: run.kind === "text" || run.kind === "gap" ? paragraph.text.slice(segment.start, segment.end) : "",
      start: segment.start - line.start,
      end: segment.end - line.start,
      style: run.style ?? style,
    };
    if (run.kind === "image") {
      runs.push({
        ...common,
        type: "image",
        x: cursor,
        y: baselineY - segment.dimensions.height,
        width: segment.dimensions.width,
        height: segment.dimensions.height,
        resource: run.node.resource,
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

  // Decorated inline boxes (background/border) for this line.
  for (const [node, edge] of edges) {
    const nodeStyle = paragraph.inlineState.get(node)?.style;
    if (!isDecorated(nodeStyle) || edge.first == null) continue;
    const padding = nodeStyle.padding ?? ZERO_BOX;
    const border = nodeStyle.borderWidth ?? 0;
    const metrics = textMetrics(ctx, nodeStyle);
    const left = edge.left ?? edge.first;
    const right = edge.right ?? edge.last;
    ctx.boxes.push({
      nodeId: node.id,
      x: left,
      y: baselineY - metrics.contentAscent - padding[0] - border,
      width: right - left,
      height: metrics.contentHeight + padding[0] + padding[2] + border * 2,
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
  ));
  for (const atom of atomsToPlace) layoutBlock(ctx, atom.box, atom.x, atom.width, atom.y);
  return { height: lineHeight, baseline: baselineY };
}

function measureAtomic(ctx, box, availableWidth) {
  const placed = resolveHorizontal(ctx, box, 0, availableWidth, true);
  const fragments = ctx.fragments;
  const boxes = ctx.boxes;
  ctx.fragments = [];
  ctx.boxes = [];
  const result = layoutBlock(ctx, box, 0, placed.width, 0);
  ctx.fragments = fragments;
  ctx.boxes = boxes;
  const margin = verticalMargins(box.style);
  return {
    width: placed.width,
    height: result.height,
    baseline: result.baseline,
    marginLeft: placed.marginLeft,
    marginRight: placed.marginRight,
    marginTop: margin.top,
    marginBottom: margin.bottom,
  };
}

function textMetrics(ctx, style) {
  const lineHeight = ctx.lineHeight ?? style?.lineHeight ?? ctx.fallbackLineHeight;
  const font = ctx.metrics(style);
  const halfLeading = (lineHeight - font.height) / 2;
  const ascent = halfLeading + font.ascent;
  return { ascent, descent: lineHeight - ascent, contentAscent: font.ascent, contentHeight: font.height };
}

function isDecorated(style) {
  return Boolean(style && ((style.backgroundColor && style.backgroundColor !== "rgba(0, 0, 0, 0)")
    || style.borderWidth > 0));
}

function lineFragment(style, text, nodeIds, runs, x, y, width, height) {
  return {
    type: "line",
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
    const fontSize = style?.fontSize ?? 22;
    const key = `${fontSize}/${style?.fontWeight ?? 400}`;
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
  return value && typeof value === "object" && value.unit === "%"
    ? reference * value.value / 100
    : value;
}
