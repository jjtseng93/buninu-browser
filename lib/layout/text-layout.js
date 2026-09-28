/**
 * Produces immutable line fragments for the first text-only layout stage.
 * Column wrapping is intentionally fixed until CSS inline sizing is added.
 */
export function layoutText(tree, options = {}) {
  const columns = positiveInteger(options.columns, 40);
  const x = finiteNumber(options.x, 16);
  const y = finiteNumber(options.y, 12);
  const lineHeight = positiveNumber(options.lineHeight, 31);
  const lines = collectLines(tree.root).flatMap((line) => wrapLine(line, columns));
  const fragments = lines.map((line, index) => Object.freeze({
    id: `${tree.generation}:${index}`,
    type: "line",
    text: line.text,
    nodeIds: Object.freeze(line.nodeIds),
    x,
    y: y + index * lineHeight,
    width: Bun.stringWidth(line.text),
    height: lineHeight,
  }));

  return Object.freeze({
    generation: tree.generation,
    columns,
    width: x + Math.max(0, ...fragments.map((fragment) => fragment.width)),
    height: fragments.length ? fragments[fragments.length - 1].y + lineHeight : 0,
    fragments: Object.freeze(fragments),
  });
}

function collectLines(root) {
  const lines = [{ text: "", nodeIds: new Set() }];

  function current() {
    return lines[lines.length - 1];
  }

  function newline(force = false) {
    if (force || current().text) lines.push({ text: "", nodeIds: new Set() });
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
        current().text += piece;
        current().nodeIds.add(nodeId);
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
    const isPreformatted = preserveWhitespace || node.tagName === "PRE";
    if (isBlock && current().text) newline();
    for (const child of node.children) visit(child, isPreformatted);
    if (isBlock && current().text) newline();
  }

  visit(root);
  while (lines.length > 1 && !lines[lines.length - 1].text) lines.pop();
  return lines.map((line) => ({
    text: line.text.trimEnd(),
    nodeIds: [...line.nodeIds],
  }));
}

function wrapLine(line, columns) {
  if (!line.text) return [{ text: "", nodeIds: line.nodeIds }];
  return Bun.wrapAnsi(line.text, columns, { hard: true, trim: false })
    .split("\n")
    .map((text) => ({ text, nodeIds: line.nodeIds }));
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
