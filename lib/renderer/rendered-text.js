/** HTML innerText's rendered-text collection using the engine's computed styles. */
export function renderedText(element, computedStyle) {
  if (!element.isConnected) return element.textContent;
  const styles = new Map();
  const styleOf = (node) => {
    if (!styles.has(node)) styles.set(node, computedStyle(node));
    return styles.get(node);
  };
  // An element outside rendering (including a display:none ancestor) returns
  // raw descendant text. Hidden descendants of a rendered element do not.
  for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
    if (styleOf(ancestor)?.display === "none") return element.textContent;
  }
  for (let child = element, ancestor = element.parentElement; ancestor; child = ancestor, ancestor = ancestor.parentElement) {
    if (ancestor.tagName === "DETAILS" && !ancestor.open && child !== firstSummary(ancestor)) return "";
  }
  let output = "";
  let breaks = 0;
  let space = false;
  const boundary = (count) => { breaks = Math.max(breaks, count); space = false; };
  const beforeText = () => {
    if (breaks && output) output += "\n".repeat(breaks);
    else if (space && output && !output.endsWith("\n")) output += " ";
    breaks = 0;
    space = false;
  };
  const text = (value, style) => {
    if (style?.visibility === "hidden" || style?.visibility === "collapse") return;
    value = value.replace(/\r\n?/g, "\n");
    if (style?.textTransform === "uppercase") value = value.toUpperCase();
    else if (style?.textTransform === "lowercase") value = value.toLowerCase();
    else if (style?.textTransform === "capitalize") value = value.replace(/(^|\s)\S/g, (part) => part.toUpperCase());
    if (["pre", "pre-wrap", "break-spaces"].includes(style?.whiteSpace)) {
      if (!value) return;
      beforeText();
      output += value;
      return;
    }
    // Collapse across adjacent text nodes too: separate spans do not create
    // extra spaces, and whitespace at block boundaries is not rendered.
    const pattern = style?.whiteSpace === "pre-line" ? /([\t\f ]+|\n)/g : /([\t\f \n]+)/g;
    for (const token of value.split(pattern)) {
      if (!token) continue;
      if (style?.whiteSpace === "pre-line" && token === "\n") {
        beforeText();
        output += "\n";
      } else if (/^[\t\f \n]+$/.test(token)) space = !breaks;
      else { beforeText(); output += token; }
    }
  };
  const stack = [{ node: element, root: true }];
  while (stack.length) {
    const item = stack.pop();
    if (item.after) {
      if (item.tab) { beforeText(); output += "\t"; }
      if (item.breaks) boundary(item.breaks);
      continue;
    }
    const node = item.node;
    if (node.nodeType === 3) { text(node.data, styleOf(node.parentElement)); continue; }
    if (node.nodeType !== 1) continue;
    // SVG descriptive/resource elements never paint their own text, even
    // though getComputedStyle(title).display is "inline" in browsers.
    if (node.namespaceURI === SVG_NAMESPACE && NON_RENDERED_SVG.has(node.localName)) continue;
    const style = styleOf(node);
    if (style?.display === "none") continue;
    if (node.tagName === "BR") {
      if (style?.visibility !== "hidden" && style?.visibility !== "collapse") {
        beforeText(); output += "\n";
      }
      continue;
    }
    const count = item.root ? 0 : node.tagName === "P" ? 2
      : BLOCK_DISPLAYS.has(style?.display) ? 1 : 0;
    if (count) boundary(count);
    const tab = style?.display === "table-cell" && node.nextElementSibling !== null;
    if (count || tab) stack.push({ after: true, breaks: count, tab });
    if (node.tagName === "DETAILS" && !node.open) {
      const summary = firstSummary(node);
      if (summary) stack.push({ node: summary });
      continue;
    }
    for (let child = node.lastChild; child; child = child.previousSibling) stack.push({ node: child });
  }
  return output;
}

function firstSummary(details) {
  for (const child of details.children) if (child.tagName === "SUMMARY") return child;
  return null;
}

const BLOCK_DISPLAYS = new Set(["block", "flow-root", "flex", "grid", "list-item", "table", "table-caption", "table-row"]);
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const NON_RENDERED_SVG = new Set(["title", "desc", "metadata", "defs", "symbol", "clipPath", "mask", "pattern",
  "linearGradient", "radialGradient", "filter"]);

/** innerText assignment turns CR/LF line boundaries into BR elements. */
export function setRenderedText(element, value) {
  const document = element.ownerDocument;
  const fragment = document.createDocumentFragment();
  const lines = String(value ?? "").split(/\r\n|[\r\n]/);
  for (let index = 0; index < lines.length; index++) {
    if (index) fragment.appendChild(document.createElement("br"));
    if (lines[index]) fragment.appendChild(document.createTextNode(lines[index]));
  }
  element.replaceChildren(fragment);
}
