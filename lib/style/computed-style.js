/**
 * Initial style model informed by TermDOM's UA/cascade tests and UA element
 * categories (bikeshaving/termdom, MIT, pinned in Architecture.md). The data
 * model and parser here are project-owned and intentionally cover only the
 * properties the current pixel renderer consumes.
 */

const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "DD", "DETAILS", "DIV", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HR", "HTML", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "UL",
]);
const NONE_TAGS = new Set(["HEAD", "LINK", "META", "NOFRAMES", "SCRIPT", "STYLE", "TEMPLATE", "TITLE"]);
const INHERITED = new Set(["color", "font-size", "font-weight", "line-height", "text-align", "white-space"]);
const DISPLAYS = new Set(["none", "block", "flex", "inline", "inline-block", "inline-flex", "list-item"]);
const WHITE_SPACES = new Set(["normal", "nowrap", "pre", "pre-wrap"]);

const INITIAL = Object.freeze({
  display: "inline",
  color: "rgba(0, 0, 0, 1)",
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: null,
  backgroundClip: "border-box",
  fontSize: 22,
  fontWeight: 400,
  lineHeight: 31,
  textAlign: "start",
  whiteSpace: "normal",
  margin: Object.freeze([0, 0, 0, 0]),
  padding: Object.freeze([0, 0, 0, 0]),
  width: "auto",
  height: "auto",
  minWidth: "auto",
  maxWidth: "none",
  borderWidth: 0,
  borderColor: "rgba(0, 0, 0, 1)",
  borderRadius: 0,
  flexDirection: "row",
  flexWrap: "nowrap",
  justifyContent: "normal",
  alignItems: "normal",
  gap: 0,
});

export class StyleEngine {
  #styles = new WeakMap();
  #customProperties = new WeakMap();

  compute(document, styleSheets = []) {
    this.#styles = new WeakMap();
    this.#customProperties = new WeakMap();
    const rules = styleSheets.flatMap(parseStyleSheet);
    if (document.documentElement) this.#visit(document.documentElement, null, null, rules);
    return this;
  }

  get(element) {
    return this.#styles.get(element) ?? INITIAL;
  }

  #visit(element, parentStyle, parentCustomProperties, rules) {
    const customProperties = new Map(parentCustomProperties ?? []);
    const declarations = cascadeDeclarations(element, rules);
    for (const declaration of declarations.values()) {
      if (declaration.name.startsWith("--")) customProperties.set(declaration.name, declaration.value);
    }
    const style = computeElementStyle(element, parentStyle, declarations, customProperties);
    this.#styles.set(element, style);
    this.#customProperties.set(element, customProperties);
    for (const child of element.children) this.#visit(child, style, customProperties, rules);
  }
}

export function computeElementStyle(element, parentStyle = null, authorDeclarations = null, customProperties = new Map()) {
  const values = { ...INITIAL };
  for (const property of INHERITED) {
    if (parentStyle) setProperty(values, property, cssValue(parentStyle, property));
  }
  if (NONE_TAGS.has(element.tagName) || element.hasAttribute("hidden")) values.display = "none";
  else if (BLOCK_TAGS.has(element.tagName)) values.display = element.tagName === "LI" ? "list-item" : "block";
  else if (["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(element.tagName)) values.display = "inline-block";
  if (["B", "STRONG"].includes(element.tagName)) values.fontWeight = 700;
  if (element.tagName === "PRE") values.whiteSpace = "pre";

  const declarations = new Map(authorDeclarations ?? []);
  for (const declaration of parseDeclarations(element.getAttribute("style") ?? "").values()) {
    const current = declarations.get(declaration.name);
    if (!current?.important || declaration.important) {
      declarations.set(declaration.name, { ...declaration, specificity: 1_000_000, order: Infinity });
    }
  }
  const fontSize = declarations.get("font-size");
  if (fontSize) setProperty(values, fontSize.name, resolveVariables(fontSize.value, customProperties), parentStyle);
  for (const declaration of declarations.values()) {
    if (!declaration.name.startsWith("--") && declaration.name !== "font-size") {
      setProperty(values, declaration.name, resolveVariables(declaration.value, customProperties), parentStyle);
    }
  }
  if (values.color === "rgba(0, 0, 0, 0)" && values.backgroundClip === "text" && values.backgroundImage) {
    values.color = gradientFallbackColor(values.backgroundImage) ?? values.color;
  }
  values.margin = Object.freeze(values.margin);
  values.padding = Object.freeze(values.padding);
  return Object.freeze(values);
}

export function parseStyleSheet(source) {
  const rules = [];
  const css = String(source).replace(/\/\*[\s\S]*?\*\//g, "");
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  let order = 0;
  while ((match = rulePattern.exec(css))) {
    const selectorText = match[1].trim();
    if (!selectorText || selectorText.startsWith("@")) continue;
    const declarations = parseDeclarations(match[2]);
    for (const selector of selectorText.split(",").map((part) => part.trim()).filter(Boolean)) {
      const specificity = selectorSpecificity(selector);
      if (specificity) rules.push({ selector, specificity, declarations, order: order++ });
    }
  }
  return rules;
}

export function parseDeclarations(source) {
  const declarations = new Map();
  for (const part of splitDeclarations(String(source))) {
    const colon = part.indexOf(":");
    if (colon < 1) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    let value = part.slice(colon + 1).trim();
    const important = /\s*!important\s*$/i.test(value);
    value = value.replace(/\s*!important\s*$/i, "").trim();
    if (!name || !value || (declarations.get(name)?.important && !important)) continue;
    declarations.set(name, { name, value, important });
  }
  return declarations;
}

function setProperty(style, name, value, parentStyle = null) {
  if (value === "inherit") value = parentStyle ? cssValue(parentStyle, name) : "initial";
  if (["initial", "unset", "revert", "revert-layer"].includes(value)) value = cssValue(INITIAL, name);
  switch (name) {
    case "display": if (DISPLAYS.has(value)) style.display = value; break;
    case "color": {
      const color = Bun.color(value, "rgba");
      if (color) style.color = color;
      break;
    }
    case "background-color": {
      const color = Bun.color(value, "rgba");
      if (color) style.backgroundColor = color;
      break;
    }
    case "background": {
      const color = Bun.color(value, "rgba");
      if (color) style.backgroundColor = color;
      else if (/^(?:linear|radial)-gradient\(/i.test(value)) style.backgroundImage = value;
      break;
    }
    case "background-image": {
      if (value === "none" || /^(?:linear|radial)-gradient\(/i.test(value)) style.backgroundImage = value === "none" ? null : value;
      break;
    }
    case "background-clip":
    case "-webkit-background-clip":
      if (["border-box", "padding-box", "content-box", "text"].includes(value)) style.backgroundClip = value;
      break;
    case "font-size": {
      const length = computedLength(value, parentStyle?.fontSize ?? INITIAL.fontSize);
      if (length > 0) style.fontSize = length;
      break;
    }
    case "font-weight": {
      const weight = value === "bold" ? 700 : value === "normal" ? 400 : Number(value);
      if (Number.isFinite(weight) && weight >= 1 && weight <= 1000) style.fontWeight = weight;
      break;
    }
    case "white-space": if (WHITE_SPACES.has(value)) style.whiteSpace = value; break;
    case "text-align": {
      const alignment = value === "left" ? "start" : value === "right" ? "end" : value;
      if (["start", "end", "center"].includes(alignment)) style.textAlign = alignment;
      break;
    }
    case "line-height": {
      const numeric = Number(value);
      const length = Number.isFinite(numeric) && numeric > 0
        ? numeric * style.fontSize
        : computedLength(value, style.fontSize);
      if (length > 0) style.lineHeight = length;
      break;
    }
    case "margin": {
      const box = boxLengths(value, true, style.fontSize, true);
      if (box) style.margin = box;
      break;
    }
    case "padding": {
      const box = boxLengths(value, false, style.fontSize, false);
      if (box) style.padding = box;
      break;
    }
    case "width":
    case "height": {
      const length = value === "auto" ? "auto" : computedLength(value, style.fontSize, true);
      if (length === "auto" || length >= 0 || isPercentage(length)) style[name] = length;
      break;
    }
    case "min-width":
    case "max-width": {
      const none = name === "max-width" && value === "none";
      const length = none ? "none" : computedLength(value, style.fontSize, true);
      if (none || length >= 0 || isPercentage(length)) {
        style[name === "min-width" ? "minWidth" : "maxWidth"] = length;
      }
      break;
    }
    case "border": {
      const width = value.match(/(?:^|\s)([\d.]+(?:px|rem|em)|0)(?:\s|$)/)?.[1];
      const colorValue = value.split(/\s+/).find((part) => Bun.color(part, "rgba"));
      const computed = width && computedLength(width, style.fontSize);
      if (computed >= 0) style.borderWidth = computed;
      if (colorValue) style.borderColor = Bun.color(colorValue, "rgba");
      break;
    }
    case "border-width": {
      const length = computedLength(value, style.fontSize);
      if (length >= 0) style.borderWidth = length;
      break;
    }
    case "border-color": {
      const color = Bun.color(value, "rgba");
      if (color) style.borderColor = color;
      break;
    }
    case "border-radius": {
      const length = computedLength(value, style.fontSize);
      if (length >= 0) style.borderRadius = length;
      break;
    }
    case "flex-direction": if (["row", "column"].includes(value)) style.flexDirection = value; break;
    case "flex-wrap": if (["nowrap", "wrap"].includes(value)) style.flexWrap = value; break;
    case "justify-content": if (["normal", "start", "end", "center", "space-between", "space-around", "space-evenly"].includes(value)) style.justifyContent = value; break;
    case "align-items": if (["normal", "stretch", "start", "end", "center"].includes(value)) style.alignItems = value; break;
    case "gap": {
      const length = computedLength(value, style.fontSize);
      if (length >= 0) style.gap = length;
      break;
    }
  }
}

function cascadeDeclarations(element, rules) {
  const result = new Map();
  for (const rule of rules) {
    if (!matchesSelector(element, rule.selector)) continue;
    for (const declaration of rule.declarations.values()) {
      const candidate = { ...declaration, specificity: rule.specificity, order: rule.order };
      const current = result.get(candidate.name);
      if (!current || compareCascade(candidate, current) >= 0) result.set(candidate.name, candidate);
    }
  }
  return result;
}

function compareCascade(left, right) {
  if (left.important !== right.important) return left.important ? 1 : -1;
  if (left.specificity !== right.specificity) return left.specificity - right.specificity;
  return left.order - right.order;
}

function selectorSpecificity(selector) {
  if (/[:\[>+~]/.test(selector.replace(/:root/g, ""))) return 0;
  const parts = selector.trim().split(/\s+/);
  if (parts.some((part) => !/^\*|(?:[a-z][\w-]*)?(?:[.#][\w-]+)*$/i.test(part))) return 0;
  let score = 1;
  for (const part of parts) {
    score += (part.match(/#/g)?.length ?? 0) * 10_000;
    score += (part.match(/\./g)?.length ?? 0) * 100;
    if (/^[a-z]/i.test(part)) score += 1;
  }
  if (selector === ":root") score += 100;
  return score;
}

function matchesSelector(element, selector) {
  if (selector === ":root") return element === element.ownerDocument.documentElement;
  const parts = selector.trim().split(/\s+/);
  let candidate = element;
  for (let index = parts.length - 1; index >= 0; index--) {
    if (index === parts.length - 1) {
      if (!matchesCompound(candidate, parts[index])) return false;
    } else {
      candidate = candidate.parentElement;
      while (candidate && !matchesCompound(candidate, parts[index])) candidate = candidate.parentElement;
      if (!candidate) return false;
    }
  }
  return true;
}

function matchesCompound(element, selector) {
  if (!element) return false;
  const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
  if (tag && element.tagName !== tag.toUpperCase()) return false;
  const id = selector.match(/#([\w-]+)/)?.[1];
  if (id && element.id !== id) return false;
  return [...selector.matchAll(/\.([\w-]+)/g)].every((match) => element.classList.contains(match[1]));
}

function resolveVariables(value, customProperties, seen = new Set()) {
  return String(value).replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_, name, fallback = "") => {
    if (seen.has(name)) return fallback.trim();
    const replacement = customProperties.get(name);
    if (replacement == null) return fallback.trim();
    return resolveVariables(replacement, customProperties, new Set([...seen, name]));
  }).trim();
}

function cssValue(style, name) {
  return ({
    "background-color": style.backgroundColor,
    "font-size": `${style.fontSize}px`,
    "font-weight": String(style.fontWeight),
    "line-height": `${style.lineHeight}px`,
    "text-align": style.textAlign,
    "white-space": style.whiteSpace,
  })[name] ?? style[name];
}

function pixelLength(value) {
  if (value === "0") return 0;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))px$/i.exec(String(value));
  return match ? Number(match[1]) : NaN;
}

function computedLength(value, emSize, allowPercentage = false) {
  if (allowPercentage) {
    const percentage = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(String(value));
    if (percentage) return Object.freeze({ unit: "%", value: Number(percentage[1]) });
  }
  const absolute = pixelLength(value);
  if (Number.isFinite(absolute)) return absolute;
  const relative = /^([+-]?(?:\d+\.?\d*|\.\d+))(rem|em)$/i.exec(String(value));
  if (!relative) return NaN;
  return Number(relative[1]) * (relative[2].toLowerCase() === "rem" ? INITIAL.fontSize : emSize);
}

function boxLengths(value, allowNegative, emSize, allowAuto) {
  const parts = value.trim().split(/\s+/).map((part) =>
    allowAuto && part === "auto" ? "auto" : computedLength(part, emSize));
  if (parts.length < 1 || parts.length > 4 || parts.some((part) =>
    part !== "auto" && (!Number.isFinite(part) || (!allowNegative && part < 0)))) return null;
  const [top, right = top, bottom = top, left = right] = parts.length === 3
    ? [parts[0], parts[1], parts[2], parts[1]]
    : parts.length === 2
      ? [parts[0], parts[1], parts[0], parts[1]]
      : parts;
  return [top, right, bottom, left];
}

function isPercentage(value) {
  return value && typeof value === "object" && value.unit === "%";
}

function gradientFallbackColor(value) {
  const candidates = String(value).match(/#[\da-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi) ?? [];
  for (const candidate of candidates) {
    const color = Bun.color(candidate, "rgba");
    if (color) return color;
  }
  return null;
}

function splitDeclarations(source) {
  const parts = [];
  let quote = "";
  let depth = 0;
  let start = 0;
  for (let index = 0; index <= source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index++;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth++;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if ((character === ";" || index === source.length) && depth === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  return parts;
}
