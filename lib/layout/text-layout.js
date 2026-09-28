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
  const measureText = typeof options.measureText === "function" ? options.measureText : null;
  const lines = collectLines(tree.root).flatMap((line) => wrapLine(line, columns));
  const fragments = lines.map((line, index) => {
    const style = tree.nodesById.get(line.nodeIds[0])?.style ?? null;
    return Object.freeze({
      id: `${tree.generation}:${index}`,
      type: "line",
      text: line.text,
      nodeIds: Object.freeze(line.nodeIds),
      runs: Object.freeze(line.runs.map((run) => Object.freeze({
        nodeId: run.nodeId,
        x: x + (measureText ? measureText(line.text.slice(0, run.start), style) : run.column * columnWidth),
        width: Math.max(1, measureText
          ? measureText(line.text.slice(0, run.end), style) - measureText(line.text.slice(0, run.start), style)
          : run.width * columnWidth),
      }))),
      x,
      y: y + index * lineHeight,
      width: Bun.stringWidth(line.text),
      height: lineHeight,
      style,
    });
  });

  return Object.freeze({
    generation: tree.generation,
    columns,
    columnWidth,
    width: x + Math.max(0, ...fragments.map((fragment) => fragment.width)),
    height: fragments.length ? fragments[fragments.length - 1].y + lineHeight : 0,
    fragments: Object.freeze(fragments),
  });
}

function collectLines(root) {
  const lines = [{ text: "", nodeIds: new Set(), runs: [] }];

  function current() {
    return lines[lines.length - 1];
  }

  function newline(force = false) {
    if (force || current().text) lines.push({ text: "", nodeIds: new Set(), runs: [] });
  }

  function append(text, nodeId, preserveWhitespace) {
    const pieces = String(text).replace(/\r\n?/g, "\n").split("\n");
    for (let index = 0; index < pieces.length; index++) {
      let piece = pieces[index];
      if (!preserveWhitespace) {
        piece = piece.replace(/[\t\f\v ]+/g, " ");
        if (!current().text) piece = piece.trimStart();
        if (current().text.endsWith(" ")) piece = piece.replace(/^ +/, "");
      }
      if (piece) {
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

  function visit(node, preserveWhitespace = false) {
    if (node.type === "text") {
      append(node.text, node.id, preserveWhitespace);
      return;
    }
    if (node.type === "line-break") {
      newline(true);
      return;
    }

    const isBlock = node.type === "block";
    const isPreformatted = preserveWhitespace || node.tagName === "PRE" || ["pre", "pre-wrap"].includes(node.style?.whiteSpace);
    if (isBlock && current().text) newline();
    for (const child of node.children) visit(child, isPreformatted);
    if (isBlock && current().text) newline();
  }

  visit(root);
  while (lines.length > 1 && !lines[lines.length - 1].text) lines.pop();
  return lines.map((line) => ({
    text: line.text.trimEnd(),
    nodeIds: [...line.nodeIds],
    runs: line.runs,
  }));
}

function wrapLine(line, columns) {
  if (!line.text) return [{ text: "", nodeIds: line.nodeIds, runs: [] }];
  let offset = 0;
  return Bun.wrapAnsi(line.text, columns, { hard: true, trim: false })
    .split("\n")
    .map((text) => {
      const start = offset;
      const end = start + text.length;
      offset = end;
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
    });
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
