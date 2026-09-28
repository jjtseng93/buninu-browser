/**
 * Produces immutable line fragments for the first text-only layout stage.
 * Column wrapping is intentionally fixed until CSS inline sizing is added.
 */
export function layoutText(tree, options = {}) {
  const columns = positiveInteger(options.columns, 40);
  const x = finiteNumber(options.x, 16);
  const y = finiteNumber(options.y, 12);
  const lineHeight = positiveNumber(options.lineHeight, 31);
  const columnWidth = positiveNumber(options.columnWidth, 13);
  const viewportWidth = positiveNumber(options.width, 0);
  const measureText = typeof options.measureText === "function" ? options.measureText : null;
  const fragments = [];
  const boxes = [];
  let cursorY = y;
  let fragmentIndex = 0;
  const logicalLines = collectLines(tree.root);
  for (let lineIndex = 0; lineIndex < logicalLines.length;) {
    const blockId = logicalLines[lineIndex].blockId;
    const group = [];
    while (lineIndex < logicalLines.length && logicalLines[lineIndex].blockId === blockId) {
      group.push(logicalLines[lineIndex++]);
    }
    const block = tree.nodesById.get(blockId);
    const style = block?.style ?? tree.nodesById.get(group[0]?.nodeIds[0])?.style ?? null;
    const rawMargin = style?.margin ?? [0, 0, 0, 0];
    const padding = style?.padding ?? [0, 0, 0, 0];
    const containingWidth = (viewportWidth || columns * columnWidth) - x * 2;
    let availableWidth = style?.width === "auto" || style?.width == null
      ? containingWidth - numberOrZero(rawMargin[1]) - numberOrZero(rawMargin[3]) - padding[1] - padding[3]
      : resolveLength(style.width, containingWidth);
    if (style?.maxWidth !== "none" && style?.maxWidth != null) {
      availableWidth = Math.min(availableWidth, resolveLength(style.maxWidth, containingWidth));
    }
    if (style?.minWidth !== "auto" && style?.minWidth != null) {
      availableWidth = Math.max(availableWidth, resolveLength(style.minWidth, containingWidth));
    }
    availableWidth = Math.max(1, availableWidth || columns * columnWidth);
    const remaining = Math.max(0, containingWidth - availableWidth - padding[1] - padding[3]
      - numberOrZero(rawMargin[1]) - numberOrZero(rawMargin[3]));
    const autoMargins = Number(rawMargin[1] === "auto") + Number(rawMargin[3] === "auto");
    const margin = rawMargin.map((value, index) => value === "auto"
      ? index % 2 === 1 && autoMargins ? remaining / autoMargins : 0
      : value);
    const boxX = x + margin[3];
    const contentX = boxX + padding[3];
    cursorY += margin[0];
    const boxY = cursorY;
    cursorY += padding[0];
    const firstFragment = fragments.length;
    for (const logicalLine of group) {
      const wrapped = wrapLine(logicalLine, columns, availableWidth, measureText, tree);
      for (const line of wrapped) {
        const usedLineHeight = options.lineHeight == null
          ? Math.max(style?.lineHeight ?? lineHeight, ...line.runs.map((run) =>
            tree.nodesById.get(run.nodeId)?.style?.lineHeight ?? lineHeight))
          : lineHeight;
        const positionedRuns = line.runs.map((run) => {
          const runStyle = tree.nodesById.get(run.nodeId)?.style ?? style;
          return Object.freeze({
            nodeId: run.nodeId,
            text: line.text.slice(run.start, run.end),
            start: run.start,
            end: run.end,
            style: runStyle,
            x: contentX + measureLineRange(line, 0, run.start, measureText, tree, columnWidth),
            width: Math.max(1, measureLineRange(line, run.start, run.end, measureText, tree, columnWidth)),
          });
        });
        fragments.push(Object.freeze({
          id: `${tree.generation}:${fragmentIndex++}`,
          type: "line",
          text: line.text,
          nodeIds: Object.freeze(line.nodeIds),
          runs: Object.freeze(positionedRuns),
          x: contentX,
          y: cursorY,
          width: measureText
            ? measureLineRange(line, 0, line.text.length, measureText, tree, columnWidth)
            : Bun.stringWidth(line.text),
          height: usedLineHeight,
          style,
        }));
        cursorY += usedLineHeight;
      }
    }
    const contentHeight = Math.max(0, cursorY - boxY - padding[0]);
    cursorY += padding[2];
    const boxHeight = Math.max(contentHeight + padding[0] + padding[2], style?.height === "auto" ? 0 : style?.height ?? 0);
    cursorY = Math.max(cursorY, boxY + boxHeight) + margin[2];
    boxes.push(Object.freeze({
      nodeId: blockId,
      x: boxX,
      y: boxY,
      width: availableWidth + padding[1] + padding[3],
      height: boxHeight,
      firstFragment,
      fragmentCount: fragments.length - firstFragment,
      style,
    }));
  }

  return Object.freeze({
    generation: tree.generation,
    columns,
    columnWidth,
    width: Math.max(viewportWidth, x + Math.max(0, ...boxes.map((box) => box.x + box.width))),
    height: cursorY,
    boxes: Object.freeze(boxes),
    fragments: Object.freeze(fragments),
  });
}

function collectLines(root) {
  const lines = [{ text: "", nodeIds: new Set(), runs: [], blockId: null }];

  function current() {
    return lines[lines.length - 1];
  }

  function newline(force = false) {
    if (force || current().text) lines.push({ text: "", nodeIds: new Set(), runs: [], blockId: null });
  }

  function append(text, nodeId, preserveWhitespace, blockId) {
    const pieces = String(text).replace(/\r\n?/g, "\n").split("\n");
    for (let index = 0; index < pieces.length; index++) {
      let piece = pieces[index];
      if (!preserveWhitespace) {
        piece = piece.replace(/[\t\f\v ]+/g, " ");
        if (!current().text) piece = piece.trimStart();
        if (current().text.endsWith(" ")) piece = piece.replace(/^ +/, "");
      }
      if (piece) {
        current().blockId ??= blockId;
        const start = current().text.length;
        current().text += piece;
        current().nodeIds.add(nodeId);
        current().runs.push({ nodeId, start, end: current().text.length });
      }
      if (index < pieces.length - 1 && preserveWhitespace) newline(true);
      else if (index < pieces.length - 1 && current().text && !current().text.endsWith(" ")) {
        current().text += " ";
      }
    }
  }

  function visit(node, preserveWhitespace = false, blockId = root.id) {
    if (node.type === "text") {
      append(node.text, node.id, preserveWhitespace, blockId);
      return;
    }
    if (node.type === "line-break") {
      newline(true);
      return;
    }

    const isBlock = node.type === "block";
    if (isBlock) blockId = node.id;
    const isPreformatted = preserveWhitespace || node.tagName === "PRE" || ["pre", "pre-wrap"].includes(node.style?.whiteSpace);
    if (isBlock && current().text) newline();
    for (const child of node.children) visit(child, isPreformatted, blockId);
    if (isBlock && current().text) newline();
  }

  visit(root);
  while (lines.length > 1 && !lines[lines.length - 1].text) lines.pop();
  return lines.map((line) => ({
    text: line.text.trimEnd(),
    nodeIds: [...line.nodeIds],
    runs: line.runs,
    blockId: line.blockId ?? root.id,
  }));
}

function wrapLine(line, columns, maxWidth = 0, measureText = null, tree = null) {
  if (!line.text) return [{ text: "", nodeIds: line.nodeIds, runs: [] }];
  if (maxWidth > 0 && measureText) {
    const slices = [];
    let start = 0;
    const boundaries = [
      ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line.text),
    ].map((segment) => segment.index).concat(line.text.length);
    for (let index = 1; index < boundaries.length; index++) {
      const end = boundaries[index];
      if (measureLineRange(line, start, end, measureText, tree, 1) > maxWidth && boundaries[index - 1] > start) {
        slices.push(sliceLine(line, start, boundaries[index - 1]));
        start = boundaries[index - 1];
      }
    }
    if (start < line.text.length) slices.push(sliceLine(line, start, line.text.length));
    return slices;
  }
  let offset = 0;
  return Bun.wrapAnsi(line.text, columns, { hard: true, trim: false })
    .split("\n")
    .map((text) => {
      const start = offset;
      const end = start + text.length;
      offset = end;
      return sliceLine(line, start, end, text);
    });
}

function measureLineRange(line, start, end, measureText, tree, columnWidth) {
  if (end <= start) return 0;
  if (!measureText) return Bun.stringWidth(line.text.slice(start, end)) * columnWidth;
  let width = 0;
  let coveredUntil = start;
  for (const run of line.runs) {
    const overlapStart = Math.max(start, run.start);
    const overlapEnd = Math.min(end, run.end);
    if (overlapEnd <= overlapStart) continue;
    if (overlapStart > coveredUntil) {
      width += measureText(line.text.slice(coveredUntil, overlapStart), null);
    }
    const style = tree?.nodesById.get(run.nodeId)?.style ?? null;
    width += measureText(line.text.slice(overlapStart, overlapEnd), style);
    coveredUntil = overlapEnd;
  }
  if (coveredUntil < end) width += measureText(line.text.slice(coveredUntil, end), null);
  return width;
}

function sliceLine(line, start, end, text = line.text.slice(start, end)) {
  const runs = line.runs.flatMap((run) => {
    const overlapStart = Math.max(start, run.start);
    const overlapEnd = Math.min(end, run.end);
    if (overlapEnd <= overlapStart) return [];
    return [{
      nodeId: run.nodeId,
      start: overlapStart - start,
      end: overlapEnd - start,
      column: Bun.stringWidth(line.text.slice(start, overlapStart)),
      width: Bun.stringWidth(line.text.slice(overlapStart, overlapEnd)),
    }];
  });
  return { text, nodeIds: [...new Set(runs.map((run) => run.nodeId))], runs };
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

function resolveLength(value, reference) {
  return value && typeof value === "object" && value.unit === "%"
    ? reference * value.value / 100
    : value;
}
