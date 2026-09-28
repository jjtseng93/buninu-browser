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
const INHERITED = new Set([
  "color", "font-family", "font-size", "font-weight", "line-height", "list-style-type", "text-align", "white-space",
]);
const LIST_STYLE_TYPES = new Set([
  "none", "disc", "circle", "square", "decimal", "decimal-leading-zero",
  "lower-alpha", "upper-alpha", "lower-latin", "upper-latin", "lower-roman", "upper-roman",
]);
const DISPLAYS = new Set([
  "none", "block", "flex", "grid", "inline", "inline-block", "inline-flex", "inline-grid", "list-item",
]);
const AUTO_TRACK = Object.freeze({ min: "auto", max: "auto" });
const FLEX_ALIGNMENT = Object.freeze({ "flex-start": "start", "flex-end": "end", left: "start", right: "end" });
const GRADIENT = /^\s*(?:repeating-)?(?:linear|radial)-gradient\(/i;
const BOX_SIDES = Object.freeze(["top", "right", "bottom", "left"]);
const WHITE_SPACES = new Set(["normal", "nowrap", "pre", "pre-wrap"]);

const INITIAL = Object.freeze({
  display: "inline",
  color: "rgba(0, 0, 0, 1)",
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: null,
  backgroundClip: "border-box",
  boxShadow: null,
  fontFamily: Object.freeze(["sans-serif"]),
  fontSize: 16,
  fontWeight: 400,
  // null means `line-height: normal`, which layout resolves from font metrics.
  lineHeight: null,
  lineHeightFactor: null,
  textAlign: "start",
  whiteSpace: "normal",
  listStyleType: "disc",
  margin: Object.freeze([0, 0, 0, 0]),
  padding: Object.freeze([0, 0, 0, 0]),
  width: "auto",
  height: "auto",
  minWidth: "auto",
  maxWidth: "none",
  boxSizing: "content-box",
  // Used border widths (0 where border-style is none/hidden), top/right/bottom/left.
  borderWidths: Object.freeze([0, 0, 0, 0]),
  borderColors: Object.freeze([null, null, null, null]),
  borderStyles: Object.freeze(["none", "none", "none", "none"]),
  borderSpecifiedWidths: Object.freeze([3, 3, 3, 3]),
  borderRadius: 0,
  flexDirection: "row",
  flexWrap: "nowrap",
  justifyContent: "normal",
  alignItems: "normal",
  alignSelf: "auto",
  gap: 0,
  rowGap: 0,
  columnGap: 0,
  flexGrow: 0,
  flexShrink: 1,
  flexBasis: "auto",
  content: null,
  position: "static",
  // top/right/bottom/left: "auto", px, or a percentage of the containing block.
  inset: Object.freeze(["auto", "auto", "auto", "auto"]),
  zIndex: "auto",
  transform: null,
  justifyItems: "normal",
  justifySelf: "auto",
  gridTemplateColumns: null,
  gridTemplateRows: null,
  gridAutoColumns: Object.freeze([AUTO_TRACK]),
  gridAutoRows: Object.freeze([AUTO_TRACK]),
  gridAutoFlow: Object.freeze({ column: false, dense: false }),
  gridColumnStart: "auto",
  gridColumnEnd: "auto",
  gridRowStart: "auto",
  gridRowEnd: "auto",
});

/**
 * User-agent defaults from the HTML Standard's suggested rendering rules
 * (WHATWG HTML §15.3, CC BY 4.0) for the elements the renderer lays out.
 */
const UA_DECLARATIONS = new Map(Object.entries({
  BODY: "margin: 8px",
  P: "margin: 1em 0",
  H1: "font-size: 2em; font-weight: bold; margin: 0.67em 0",
  H2: "font-size: 1.5em; font-weight: bold; margin: 0.83em 0",
  H3: "font-size: 1.17em; font-weight: bold; margin: 1em 0",
  H4: "font-weight: bold; margin: 1.33em 0",
  H5: "font-size: 0.83em; font-weight: bold; margin: 1.67em 0",
  H6: "font-size: 0.67em; font-weight: bold; margin: 2.33em 0",
  UL: "margin: 1em 0; padding-left: 40px; list-style-type: disc",
  OL: "margin: 1em 0; padding-left: 40px; list-style-type: decimal",
  DL: "margin: 1em 0",
  DD: "margin-left: 40px",
  BLOCKQUOTE: "margin: 1em 40px",
  FIGURE: "margin: 1em 40px",
  PRE: "margin: 1em 0; font-family: monospace",
  CODE: "font-family: monospace",
  KBD: "font-family: monospace",
  SAMP: "font-family: monospace",
  TT: "font-family: monospace",
  HR: "margin: 0.5em 0; border: 1px solid gray",
}).map(([tag, source]) => [tag, parseDeclarations(source)]));

const DEFAULT_ENVIRONMENT = Object.freeze({ viewportWidth: 800, viewportHeight: 600, rootFontSize: 16 });
let environment = DEFAULT_ENVIRONMENT;

export class StyleEngine {
  #styles = new WeakMap();
  #customProperties = new WeakMap();
  #pseudoStyles = new WeakMap();

  compute(document, styleSheets = [], viewport = {}) {
    this.#styles = new WeakMap();
    this.#customProperties = new WeakMap();
    this.#pseudoStyles = new WeakMap();
    const previous = environment;
    environment = {
      viewportWidth: viewport.width ?? DEFAULT_ENVIRONMENT.viewportWidth,
      viewportHeight: viewport.height ?? DEFAULT_ENVIRONMENT.viewportHeight,
      rootFontSize: DEFAULT_ENVIRONMENT.rootFontSize,
    };
    try {
      const counter = { order: 0 };
      const rules = styleSheets.flatMap((source) => parseStyleSheet(source, environment, counter));
      if (document.documentElement) this.#visit(document.documentElement, null, null, rules);
    } finally {
      environment = previous;
    }
    return this;
  }

  get(element) {
    return this.#styles.get(element) ?? INITIAL;
  }

  /** The computed style of an element's ::before/::after box, or null when it generates none. */
  getPseudo(element, pseudo) {
    return this.#pseudoStyles.get(element)?.[pseudo] ?? null;
  }

  #visit(element, parentStyle, parentCustomProperties, rules) {
    const customProperties = new Map(parentCustomProperties ?? []);
    const declarations = cascadeDeclarations(element, rules);
    for (const declaration of declarations.values()) {
      if (declaration.name.startsWith("--")) customProperties.set(declaration.name, declaration.value);
    }
    const style = computeElementStyle(element, parentStyle, declarations, customProperties);
    // rem units resolve against the root element's computed font size.
    if (!parentStyle) environment = { ...environment, rootFontSize: style.fontSize };
    this.#styles.set(element, style);
    this.#customProperties.set(element, customProperties);
    const pseudoStyles = {};
    for (const pseudo of ["before", "after"]) {
      const pseudoDeclarations = cascadeDeclarations(element, rules, pseudo);
      if (!pseudoDeclarations.has("content")) continue;
      const pseudoCustom = new Map(customProperties);
      for (const declaration of pseudoDeclarations.values()) {
        if (declaration.name.startsWith("--")) pseudoCustom.set(declaration.name, declaration.value);
      }
      const pseudoStyle = computeElementStyle(pseudoElement(pseudo), style, pseudoDeclarations, pseudoCustom);
      // `content: none | normal` generates no box (CSS Pseudo 4 §2.3).
      if (pseudoStyle.content != null && pseudoStyle.display !== "none") pseudoStyles[pseudo] = pseudoStyle;
    }
    if (pseudoStyles.before || pseudoStyles.after) this.#pseudoStyles.set(element, pseudoStyles);
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
  for (const declaration of UA_DECLARATIONS.get(element.tagName)?.values() ?? []) {
    if (!declarations.has(declaration.name)) {
      declarations.set(declaration.name, { ...declaration, specificity: -1, order: -1 });
    }
  }
  for (const declaration of parseDeclarations(element.getAttribute("style") ?? "").values()) {
    const current = declarations.get(declaration.name);
    if (!current?.important || declaration.important) {
      declarations.set(declaration.name, { ...declaration, specificity: 1_000_000, order: Infinity });
    }
  }
  const fontSize = declarations.get("font-size");
  if (fontSize) setProperty(values, fontSize.name, resolveVariables(fontSize.value, customProperties), parentStyle);
  // Apply in cascade order so a later shorthand overrides earlier longhands and vice versa.
  const ordered = [...declarations.values()].sort((left, right) => compareCascade(
    { important: false, specificity: 0, order: 0, ...left, important: Boolean(left.important) },
    { important: false, specificity: 0, order: 0, ...right, important: Boolean(right.important) },
  ));
  for (const declaration of ordered) {
    if (!declaration.name.startsWith("--") && declaration.name !== "font-size") {
      setProperty(values, declaration.name, resolveVariables(declaration.value, customProperties), parentStyle);
    }
  }
  // A border side is only drawn with a visible style; currentColor follows `color`.
  values.borderWidths = Object.freeze(values.borderSpecifiedWidths.map((width, index) =>
    ["none", "hidden"].includes(values.borderStyles[index]) ? 0 : width));
  values.borderColors = Object.freeze(values.borderColors.map((color) => color ?? values.color));
  values.borderStyles = Object.freeze([...values.borderStyles]);
  values.borderSpecifiedWidths = Object.freeze([...values.borderSpecifiedWidths]);
  // A unitless line-height inherits as a factor of each element's own font size.
  if (values.lineHeightFactor != null) values.lineHeight = values.lineHeightFactor * values.fontSize;
  if (values.color === "rgba(0, 0, 0, 0)" && values.backgroundClip === "text" && values.backgroundImage) {
    values.color = gradientFallbackColor(values.backgroundImage) ?? values.color;
  }
  values.margin = Object.freeze(values.margin);
  values.inset = Object.freeze([...values.inset]);
  values.padding = Object.freeze(values.padding);
  return Object.freeze(values);
}

/**
 * Parses style rules, descending into conditional group rules. `@media` is
 * evaluated against the viewport; `@supports` and `@layer` blocks are applied;
 * other at-rules (`@font-face`, `@keyframes`, ...) are skipped.
 */
export function parseStyleSheet(source, viewport = environment, counter = { order: 0 }) {
  const rules = [];
  const css = String(source).replace(/\/\*[\s\S]*?\*\//g, "");

  function parseBlock(start, end) {
    let index = start;
    while (index < end) {
      const open = findTopLevel(css, "{", index, end);
      const semicolon = findTopLevel(css, ";", index, end);
      if (semicolon !== -1 && (open === -1 || semicolon < open)) {
        index = semicolon + 1;
        continue;
      }
      if (open === -1) break;
      const close = matchingBrace(css, open, end);
      const prelude = css.slice(index, open).trim();
      if (prelude.startsWith("@")) {
        const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase();
        const condition = prelude.slice(name ? name.length + 1 : 1).trim();
        if ((name === "media" && mediaQueryMatches(condition, viewport))
          || name === "supports" || name === "layer") {
          parseBlock(open + 1, close);
        }
      } else if (prelude) {
        const declarations = parseDeclarations(css.slice(open + 1, close));
        for (const selectorText of splitTopLevel(prelude, ",").filter(Boolean)) {
          const { selector, pseudo } = splitPseudoElement(selectorText);
          if (pseudo === undefined) continue;
          rules.push({ selector, pseudo, specificity: selectorSpecificity(selectorText), declarations, order: counter.order++ });
        }
      }
      index = close + 1;
    }
  }

  parseBlock(0, css.length);
  return rules;
}

function findTopLevel(source, character, start, end) {
  let quote = "";
  let depth = 0;
  for (let index = start; index < end; index++) {
    const current = source[index];
    if (quote) {
      if (current === "\\") index++;
      else if (current === quote) quote = "";
    } else if (current === '"' || current === "'") quote = current;
    else if (current === "(") depth++;
    else if (current === ")") depth = Math.max(0, depth - 1);
    else if (current === character && depth === 0) return index;
    else if (current === "{" || current === "}") return character === current ? index : -1;
  }
  return -1;
}

function matchingBrace(source, open, end) {
  let depth = 0;
  let quote = "";
  for (let index = open; index < end; index++) {
    const current = source[index];
    if (quote) {
      if (current === "\\") index++;
      else if (current === quote) quote = "";
    } else if (current === '"' || current === "'") quote = current;
    else if (current === "{") depth++;
    else if (current === "}" && --depth === 0) return index;
  }
  return end;
}

/** Evaluates a media query list for a screen viewport (light scheme, no print). */
export function mediaQueryMatches(query, viewport = environment) {
  const width = viewport.viewportWidth ?? viewport.width ?? DEFAULT_ENVIRONMENT.viewportWidth;
  const height = viewport.viewportHeight ?? viewport.height ?? DEFAULT_ENVIRONMENT.viewportHeight;
  const text = query.trim().toLowerCase();
  if (!text) return true;
  return splitTopLevel(text, ",").some((single) => {
    let negate = false;
    let rest = single.trim();
    if (rest.startsWith("not ")) {
      negate = true;
      rest = rest.slice(4).trim();
    }
    rest = rest.replace(/^only\s+/, "");
    const matches = rest.split(/\s+and\s+/).every((part) => {
      part = part.trim();
      if (["all", "screen"].includes(part)) return true;
      if (/^[a-z-]+$/.test(part)) return false;
      const feature = /^\(\s*([a-z-]+)\s*(?::\s*(.+?))?\s*\)$/.exec(part);
      if (feature) return mediaFeatureMatches(feature[1], feature[2], width, height);
      const range = /^\(\s*(width|height)\s*(<=|>=|<|>|=)\s*(.+?)\s*\)$/.exec(part);
      if (!range) return false;
      const actual = range[1] === "width" ? width : height;
      const limit = mediaLength(range[3]);
      return { "<=": actual <= limit, ">=": actual >= limit, "<": actual < limit, ">": actual > limit, "=": actual === limit }[range[2]];
    });
    return negate ? !matches : matches;
  });
}

function mediaFeatureMatches(name, value, width, height) {
  switch (name) {
    case "min-width": return width >= mediaLength(value);
    case "max-width": return width <= mediaLength(value);
    case "min-height": return height >= mediaLength(value);
    case "max-height": return height <= mediaLength(value);
    case "orientation": return value === (height >= width ? "portrait" : "landscape");
    case "prefers-color-scheme": return value === "light";
    case "prefers-reduced-motion": return value === "no-preference";
    case "color": return true;
    default: return false;
  }
}

function mediaLength(value) {
  // Media queries resolve em/rem against the initial font size, not the root style.
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(px|em|rem)?$/.exec(String(value).trim());
  if (!match) return NaN;
  return Number(match[1]) * (match[2] && match[2] !== "px" ? DEFAULT_ENVIRONMENT.rootFontSize : 1);
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
      // The shorthand resets both longhands; only the final layer may carry a color.
      const layers = splitTopLevel(value, ",");
      const images = layers.filter((layer) => GRADIENT.test(layer));
      const color = splitTopLevel(layers.at(-1) ?? "", " ")
        .map((token) => Bun.color(token, "rgba"))
        .find(Boolean);
      style.backgroundColor = color ?? INITIAL.backgroundColor;
      style.backgroundImage = images.length ? images.join(", ") : null;
      break;
    }
    case "background-image": {
      if (value === "none") style.backgroundImage = null;
      else {
        const images = splitTopLevel(value, ",").filter((layer) => GRADIENT.test(layer));
        if (images.length) style.backgroundImage = images.join(", ");
      }
      break;
    }
    case "box-shadow": {
      const shadows = value === "none" ? null : parseBoxShadows(value, style.fontSize);
      if (value === "none" || shadows) style.boxShadow = shadows;
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
    case "position":
      if (["static", "relative", "absolute", "fixed", "sticky"].includes(value)) style.position = value;
      break;
    case "top":
    case "right":
    case "bottom":
    case "left": {
      const length = value === "auto" ? "auto" : computedLength(value, style.fontSize, true);
      if (length === "auto" || Number.isFinite(length) || length?.unit) style.inset = style.inset.with(BOX_SIDES.indexOf(name), length);
      break;
    }
    case "inset": {
      const parts = splitTopLevel(value, " ").filter(Boolean)
        .map((part) => part === "auto" ? "auto" : computedLength(part, style.fontSize, true));
      if (!parts.length || parts.length > 4 || parts.some((part) => part !== "auto" && !Number.isFinite(part) && !part?.unit)) break;
      const [top, right = top, bottom = top, left = right] = parts;
      style.inset = [top, right, bottom, left];
      break;
    }
    case "z-index": {
      const number = Number(value);
      if (value === "auto" || (Number.isInteger(number) && value.trim() !== "")) style.zIndex = value === "auto" ? "auto" : number;
      break;
    }
    case "transform": {
      const transform = value === "none" ? null : parseTranslate(value, style.fontSize);
      if (transform !== undefined) style.transform = transform;
      break;
    }
    case "content": {
      const content = parseContent(value);
      if (content !== undefined) style.content = content;
      break;
    }
    case "list-style-type": if (LIST_STYLE_TYPES.has(value)) style.listStyleType = value; break;
    case "list-style": {
      // Only the marker type is rendered; position and image are ignored.
      const type = value.split(/\s+/).find((token) => LIST_STYLE_TYPES.has(token));
      if (type) style.listStyleType = type;
      break;
    }
    case "font-family": {
      const families = splitTopLevel(value, ",")
        .map((family) => family.replace(/^(["'])(.*)\1$/, "$2").trim())
        .filter(Boolean);
      if (families.length) style.fontFamily = Object.freeze(families);
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
      if (value === "normal") {
        style.lineHeight = null;
        style.lineHeightFactor = null;
      } else if (Number.isFinite(numeric) && numeric > 0) {
        style.lineHeight = numeric * style.fontSize;
        style.lineHeightFactor = numeric;
      } else {
        const length = computedLength(value, style.fontSize);
        if (length > 0) {
          style.lineHeight = length;
          style.lineHeightFactor = null;
        }
      }
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
    case "margin-top":
    case "margin-right":
    case "margin-bottom":
    case "margin-left":
    case "padding-top":
    case "padding-right":
    case "padding-bottom":
    case "padding-left": {
      const [box, side] = name.split("-");
      const isMargin = box === "margin";
      const length = isMargin && value === "auto" ? "auto" : computedLength(value, style.fontSize);
      if (length === "auto" || (Number.isFinite(length) && (isMargin || length >= 0))) {
        style[box] = style[box].with(BOX_SIDES.indexOf(side), length);
      }
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
    case "border":
    case "border-top":
    case "border-right":
    case "border-bottom":
    case "border-left": {
      // Shorthands reset width (medium), style (none) and color (currentColor).
      const parsed = parseBorderShorthand(value, style.fontSize);
      if (!parsed) break;
      const sides = name === "border" ? [0, 1, 2, 3] : [BOX_SIDES.indexOf(name.slice(7))];
      for (const side of sides) {
        style.borderSpecifiedWidths = style.borderSpecifiedWidths.with(side, parsed.width);
        style.borderStyles = style.borderStyles.with(side, parsed.style);
        style.borderColors = style.borderColors.with(side, parsed.color);
      }
      break;
    }
    case "border-width":
    case "border-style":
    case "border-color": {
      const parts = splitTopLevel(value, " ").filter(Boolean).map((part) => name === "border-width"
        ? borderWidth(part, style.fontSize)
        : name === "border-style" ? (BORDER_STYLES.has(part) ? part : null) : borderColor(part));
      if (!parts.length || parts.length > 4 || parts.some((part) => part === undefined || (name !== "border-color" && part == null))) break;
      const [top, right = top, bottom = top, left = right] = parts;
      const values = [top, right, bottom, left];
      if (name === "border-width") style.borderSpecifiedWidths = values;
      else if (name === "border-style") style.borderStyles = values;
      else style.borderColors = values;
      break;
    }
    case "border-top-width": case "border-right-width": case "border-bottom-width": case "border-left-width":
    case "border-top-style": case "border-right-style": case "border-bottom-style": case "border-left-style":
    case "border-top-color": case "border-right-color": case "border-bottom-color": case "border-left-color": {
      const [, side, part] = name.split("-");
      const index = BOX_SIDES.indexOf(side);
      if (part === "width") {
        const width = borderWidth(value, style.fontSize);
        if (width != null) style.borderSpecifiedWidths = style.borderSpecifiedWidths.with(index, width);
      } else if (part === "style") {
        if (BORDER_STYLES.has(value)) style.borderStyles = style.borderStyles.with(index, value);
      } else {
        const color = borderColor(value);
        if (color !== undefined) style.borderColors = style.borderColors.with(index, color);
      }
      break;
    }
    case "border-radius": {
      // One radius for every corner; percentages resolve against the box at paint time.
      const length = computedLength(splitTopLevel(value.split("/")[0], " ").filter(Boolean)[0] ?? "", style.fontSize, true);
      if (length >= 0 || length?.unit === "%") style.borderRadius = length;
      break;
    }
    case "box-sizing": if (["content-box", "border-box"].includes(value)) style.boxSizing = value; break;
    case "flex-direction": if (["row", "column"].includes(value)) style.flexDirection = value; break;
    case "flex-wrap": if (["nowrap", "wrap"].includes(value)) style.flexWrap = value; break;
    case "justify-content": {
      const justify = FLEX_ALIGNMENT[value] ?? value;
      if (["normal", "start", "end", "center", "space-between", "space-around", "space-evenly"].includes(justify)) style.justifyContent = justify;
      break;
    }
    case "align-items": {
      const alignment = FLEX_ALIGNMENT[value] ?? value;
      if (["normal", "stretch", "start", "end", "center", "baseline"].includes(alignment)) style.alignItems = alignment;
      break;
    }
    case "gap": {
      const [row, column = row] = splitTopLevel(value, " ").filter(Boolean)
        .map((part) => part === "normal" ? 0 : computedLength(part, style.fontSize));
      if (row >= 0 && column >= 0) {
        style.gap = row;
        style.rowGap = row;
        style.columnGap = column;
      }
      break;
    }
    case "grid-gap": return setProperty(style, "gap", value, parentStyle);
    case "grid-row-gap": return setProperty(style, "row-gap", value, parentStyle);
    case "grid-column-gap": return setProperty(style, "column-gap", value, parentStyle);
    case "grid-template-columns":
    case "grid-template-rows": {
      const tracks = value === "none" ? null : parseTrackList(value, style.fontSize);
      if (value === "none" || tracks) style[name === "grid-template-columns" ? "gridTemplateColumns" : "gridTemplateRows"] = tracks;
      break;
    }
    case "grid-auto-columns":
    case "grid-auto-rows": {
      const tracks = parseTrackList(value, style.fontSize);
      if (tracks?.length && tracks.every((entry) => !entry.repeat)) {
        style[name === "grid-auto-columns" ? "gridAutoColumns" : "gridAutoRows"] = tracks;
      }
      break;
    }
    case "grid-auto-flow": {
      const words = value.split(/\s+/);
      if (words.every((word) => ["row", "column", "dense"].includes(word))) {
        style.gridAutoFlow = Object.freeze({ column: words.includes("column"), dense: words.includes("dense") });
      }
      break;
    }
    case "grid-column-start":
    case "grid-column-end":
    case "grid-row-start":
    case "grid-row-end": {
      const property = name.replace(/-(\w)/g, (_, letter) => letter.toUpperCase());
      style[property] = parseGridLine(value);
      break;
    }
    case "grid-column":
    case "grid-row": {
      const [start, end] = value.split("/").map((part) => parseGridLine(part.trim()));
      const axis = name === "grid-column" ? "Column" : "Row";
      style[`grid${axis}Start`] = start;
      // A single integer leaves the end auto (spanning one track).
      style[`grid${axis}End`] = end ?? "auto";
      break;
    }
    case "grid-area": {
      const [rowStart, columnStart = "auto", rowEnd = "auto", columnEnd = "auto"] = value.split("/")
        .map((part) => parseGridLine(part.trim()));
      Object.assign(style, { gridRowStart: rowStart, gridColumnStart: columnStart, gridRowEnd: rowEnd, gridColumnEnd: columnEnd });
      break;
    }
    case "justify-items":
    case "justify-self": {
      const alignment = FLEX_ALIGNMENT[value] ?? value;
      const allowed = name === "justify-items" ? ["normal", "stretch", "start", "end", "center"] : ["auto", "normal", "stretch", "start", "end", "center"];
      if (allowed.includes(alignment)) style[name === "justify-items" ? "justifyItems" : "justifySelf"] = alignment;
      break;
    }
    case "row-gap":
    case "column-gap": {
      const length = value === "normal" ? 0 : computedLength(value, style.fontSize);
      if (length >= 0) style[name === "row-gap" ? "rowGap" : "columnGap"] = length;
      break;
    }
    case "align-self": {
      const alignment = FLEX_ALIGNMENT[value] ?? value;
      if (["auto", "normal", "stretch", "start", "end", "center", "baseline"].includes(alignment)) style.alignSelf = alignment;
      break;
    }
    case "flex-grow":
    case "flex-shrink": {
      const number = Number(value);
      if (value !== "" && Number.isFinite(number) && number >= 0) style[name === "flex-grow" ? "flexGrow" : "flexShrink"] = number;
      break;
    }
    case "flex-basis": {
      const basis = flexBasis(value, style.fontSize);
      if (basis != null) style.flexBasis = basis;
      break;
    }
    case "flex": {
      const flex = flexShorthand(value, style.fontSize);
      if (flex) Object.assign(style, flex);
      break;
    }
  }
}

function cascadeDeclarations(element, rules, pseudo = null) {
  const result = new Map();
  for (const rule of rules) {
    if (rule.pseudo !== pseudo || !matchesSelector(element, rule)) continue;
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

const PSEUDO_ELEMENT = /(?:::?(before|after)|::([\w-]+))$/i;

/**
 * Splits a trailing pseudo-element off a selector. Returns pseudo null for
 * element selectors, "before"/"after" for generated content, and undefined for
 * pseudo-elements that are not rendered (::placeholder, ::selection, ...).
 */
function splitPseudoElement(selectorText) {
  const match = PSEUDO_ELEMENT.exec(selectorText);
  if (!match) return { selector: selectorText, pseudo: null };
  const selector = selectorText.slice(0, match.index).trim() || "*";
  return { selector, pseudo: match[1] ? match[1].toLowerCase() : undefined };
}

/**
 * Selectors 4 §16 specificity as a*10000 + b*100 + c. :is()/:not()/:has()
 * take their most specific argument, :where() counts zero, and
 * pseudo-elements count as types.
 */
function selectorSpecificity(selector) {
  let a = 0;
  let b = 0;
  let c = 0;
  let text = selector;
  // Functional pseudo-classes first, replacing each with a neutral placeholder.
  for (;;) {
    const match = /:(is|not|has|where|matches|-webkit-any|nth-child|nth-last-child)\(/i.exec(text);
    if (!match) break;
    let depth = 1;
    let index = match.index + match[0].length;
    for (; index < text.length && depth > 0; index++) {
      if (text[index] === "(") depth++;
      else if (text[index] === ")") depth--;
    }
    const argument = text.slice(match.index + match[0].length, index - 1);
    const name = match[1].toLowerCase();
    if (name.startsWith("nth")) {
      b++;
      const of = /\bof\s+(.+)$/i.exec(argument);
      if (of) [a, b, c] = addSpecificity([a, b, c], maxSpecificity(of[1]));
    } else if (name !== "where") {
      [a, b, c] = addSpecificity([a, b, c], maxSpecificity(argument));
    }
    text = text.slice(0, match.index) + " " + text.slice(index);
  }
  text = text.replace(/\[[^\]]*\]/g, () => {
    b++;
    return " ";
  });
  a += (text.match(/#[\w-]+/g) ?? []).length;
  b += (text.match(/\.[\w-]+/g) ?? []).length;
  const pseudoElements = (text.match(/::[\w-]+|:(?:before|after|first-line|first-letter)\b/gi) ?? []).length;
  text = text.replace(/::[\w-]+|:(?:before|after|first-line|first-letter)\b/gi, " ");
  b += (text.match(/:[\w-]+/g) ?? []).length;
  c += pseudoElements + (text.match(/(?:^|[\s>+~(])[a-z][\w-]*/gi) ?? []).length;
  return a * 10_000 + b * 100 + c;
}

function maxSpecificity(list) {
  const values = splitTopLevel(list, ",").filter(Boolean).map(selectorSpecificity);
  const max = Math.max(0, ...values);
  return [Math.floor(max / 10_000), Math.floor(max / 100) % 100, max % 100];
}

function addSpecificity(left, right) {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

/** Matches through the DOM's own selector engine; invalid selectors never match. */
function matchesSelector(element, rule) {
  if (rule.invalid || typeof element.matches !== "function") return false;
  try {
    return element.matches(rule.selector);
  } catch {
    rule.invalid = true;
    return false;
  }
}

/** A stand-in for the pseudo-element's originating element when computing its style. */
function pseudoElement(pseudo) {
  return { tagName: `::${pseudo}`, getAttribute: () => null, hasAttribute: () => false };
}

/**
 * Keeps the translation part of a transform list as { x, y } lengths (px or
 * percentages of the element's own border box). Other functions are ignored
 * until transforms are painted with matrices.
 */
function parseTranslate(value, fontSize) {
  let x = 0;
  let y = 0;
  let found = false;
  for (const match of value.matchAll(/(translate|translateX|translateY|translate3d)\(([^)]*)\)/gi)) {
    const args = splitTopLevel(match[2], ",").map((part) => computedLength(part, fontSize, true));
    if (args.some((part) => !Number.isFinite(part) && !part?.unit)) return undefined;
    const kind = match[1].toLowerCase();
    if (kind === "translatey") y = args[0];
    else {
      x = args[0];
      if (kind !== "translatex") y = args[1] ?? 0;
    }
    found = true;
  }
  return found ? Object.freeze({ x, y }) : null;
}

/** Parses `content` into its string, null for none/normal, undefined if unsupported. */
function parseContent(value) {
  if (value === "none" || value === "normal") return null;
  let text = "";
  const tokens = value.match(/(["'])(?:\\.|(?!\1)[^\\])*\1|\S+/g) ?? [];
  for (const token of tokens) {
    const string = /^(["'])(.*)\1$/s.exec(token);
    if (!string) return undefined;
    text += string[2].replace(/\\([0-9a-f]{1,6})\s?|\\(.)/gi, (_, hex, escaped) =>
      hex ? String.fromCodePoint(parseInt(hex, 16)) : escaped);
  }
  return text;
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
    "font-family": style.fontFamily.map((family) => JSON.stringify(family)).join(", "),
    "font-size": `${style.fontSize}px`,
    "font-weight": String(style.fontWeight),
    "line-height": style.lineHeightFactor != null ? String(style.lineHeightFactor)
      : style.lineHeight == null ? "normal" : `${style.lineHeight}px`,
    "list-style-type": style.listStyleType,
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
  const text = String(value).trim();
  if (allowPercentage) {
    const percentage = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(text);
    if (percentage) return Object.freeze({ unit: "%", value: Number(percentage[1]) });
  }
  const absolute = pixelLength(text);
  if (Number.isFinite(absolute)) return absolute;
  const math = /^(clamp|min|max)\((.*)\)$/i.exec(text);
  if (math) {
    const kind = math[1].toLowerCase();
    const values = splitTopLevel(math[2], ",").map((part) => computedLength(part, emSize, allowPercentage));
    if (!values.length || values.some((part) => !Number.isFinite(part) && !(part?.unit))) return NaN;
    // Percentages inside math functions resolve at layout time.
    if (values.some((part) => part?.unit)) {
      return (kind === "clamp" && values.length !== 3)
        ? NaN
        : Object.freeze({ unit: "math", kind, values: Object.freeze(values) });
    }
    if (kind === "min") return Math.min(...values);
    if (kind === "max") return Math.max(...values);
    return values.length === 3 ? Math.max(values[0], Math.min(values[1], values[2])) : NaN;
  }
  const relative = /^([+-]?(?:\d+\.?\d*|\.\d+))(rem|em|vw|vh|pt)$/i.exec(text);
  if (!relative) return NaN;
  const unit = relative[2].toLowerCase();
  const scale = unit === "rem" ? environment.rootFontSize
    : unit === "em" ? emSize
      : unit === "vw" ? environment.viewportWidth / 100
        : unit === "vh" ? environment.viewportHeight / 100
          : 4 / 3;
  return Number(relative[1]) * scale;
}

/** Parses `box-shadow` layers: [inset] <x> <y> [<blur> [<spread>]] [<color>]. */
function parseBoxShadows(value, fontSize) {
  const shadows = [];
  for (const layer of splitTopLevel(value, ",")) {
    const lengths = [];
    let color = null;
    let inset = false;
    for (const token of splitTopLevel(layer, " ").filter(Boolean)) {
      if (token === "inset") inset = true;
      else if (Number.isFinite(computedLength(token, fontSize))) lengths.push(computedLength(token, fontSize));
      else if (Bun.color(token, "rgba")) color = Bun.color(token, "rgba");
      else return null;
    }
    if (lengths.length < 2 || lengths.length > 4 || lengths[2] < 0) return null;
    const [x, y, blur = 0, spread = 0] = lengths;
    shadows.push(Object.freeze({ x, y, blur, spread, color: color ?? "rgba(0, 0, 0, 1)", inset }));
  }
  return shadows.length ? Object.freeze(shadows) : null;
}

/**
 * Parses a <track-list> into [{ min, max }] and { repeat, tracks } entries.
 * Breadths are px numbers, percentage/math objects resolved at layout time,
 * keywords, { fr }, or { fitContent }. Line names are ignored.
 */
function parseTrackList(value, fontSize) {
  const entries = [];
  const tokens = splitTopLevel(value.replace(/\[[^\]]*\]/g, " "), " ").filter(Boolean);
  for (const token of tokens) {
    const repeat = /^repeat\((.*)\)$/i.exec(token);
    if (repeat) {
      const [countText, trackText] = splitTopLevel(repeat[1], ",");
      const tracks = trackText ? parseTrackList(trackText, fontSize) : null;
      if (!tracks?.length || tracks.some((entry) => entry.repeat)) return null;
      const count = ["auto-fill", "auto-fit"].includes(countText) ? countText : Number(countText);
      if (typeof count === "number" && !(Number.isInteger(count) && count > 0)) return null;
      entries.push(Object.freeze({ repeat: count, tracks: Object.freeze(tracks) }));
      continue;
    }
    const track = parseTrackSize(token, fontSize);
    if (!track) return null;
    entries.push(track);
  }
  return entries.length ? Object.freeze(entries) : null;
}

function parseTrackSize(token, fontSize) {
  const minmax = /^minmax\((.*)\)$/i.exec(token);
  if (minmax) {
    const [min, max] = splitTopLevel(minmax[1], ",").map((part) => parseBreadth(part, fontSize));
    return min != null && max != null && !min.fr ? Object.freeze({ min, max }) : null;
  }
  const fit = /^fit-content\((.*)\)$/i.exec(token);
  if (fit) {
    const limit = computedLength(fit[1], fontSize, true);
    return isLength(limit) ? Object.freeze({ min: "auto", max: Object.freeze({ fitContent: limit }) }) : null;
  }
  const breadth = parseBreadth(token, fontSize);
  if (breadth == null) return null;
  return Object.freeze({ min: breadth.fr ? "auto" : breadth, max: breadth });
}

function parseBreadth(token, fontSize) {
  if (["auto", "min-content", "max-content"].includes(token)) return token;
  const fr = /^(\d+\.?\d*|\.\d+)fr$/.exec(token);
  if (fr) return Object.freeze({ fr: Number(fr[1]) });
  const length = computedLength(token, fontSize, true);
  return isLength(length) ? length : null;
}

function isLength(value) {
  return (Number.isFinite(value) && value >= 0) || (value && typeof value === "object" && ["%", "math"].includes(value.unit));
}

function parseGridLine(token) {
  if (!token || token === "auto") return "auto";
  const span = /^span\s+(\d+)$|^(\d+)\s+span$/.exec(token);
  if (span) return Object.freeze({ span: Math.max(1, Number(span[1] ?? span[2])) });
  const line = Number(token);
  if (Number.isInteger(line) && line !== 0) return Object.freeze({ line });
  // Named lines and areas are not supported yet; treat them as auto.
  return "auto";
}

const BORDER_STYLES = new Set(["none", "hidden", "solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset"]);
const BORDER_WIDTH_KEYWORDS = Object.freeze({ thin: 1, medium: 3, thick: 5 });

/** Returns a px width, or null when the token is not a <line-width>. */
function borderWidth(token, fontSize) {
  if (token in BORDER_WIDTH_KEYWORDS) return BORDER_WIDTH_KEYWORDS[token];
  const length = computedLength(token, fontSize);
  return Number.isFinite(length) && length >= 0 ? length : null;
}

/** Returns an rgba color, null for currentColor, or undefined when invalid. */
function borderColor(token) {
  if (token.toLowerCase() === "currentcolor") return null;
  return Bun.color(token, "rgba") ?? undefined;
}

function parseBorderShorthand(value, fontSize) {
  const border = { width: 3, style: "none", color: null };
  for (const token of splitTopLevel(value, " ").filter(Boolean)) {
    if (BORDER_STYLES.has(token)) border.style = token;
    else if (borderWidth(token, fontSize) != null) border.width = borderWidth(token, fontSize);
    else if (borderColor(token) !== undefined) border.color = borderColor(token);
    else return null;
  }
  return border;
}

function flexBasis(value, fontSize) {
  if (["auto", "content"].includes(value)) return value;
  const length = computedLength(value, fontSize, true);
  return isPercentage(length) || length >= 0 ? length : null;
}

/** Expands the `flex` shorthand (CSS Flexbox §7.2). */
function flexShorthand(value, fontSize) {
  if (value === "none") return { flexGrow: 0, flexShrink: 0, flexBasis: "auto" };
  if (value === "auto") return { flexGrow: 1, flexShrink: 1, flexBasis: "auto" };
  const parts = value.trim().split(/\s+/);
  const numbers = [];
  let basis = null;
  for (const part of parts) {
    const number = Number(part);
    if (part !== "" && Number.isFinite(number) && numbers.length < 2 && basis == null) numbers.push(number);
    else if (basis == null && (basis = flexBasis(part, fontSize)) != null) continue;
    else return null;
  }
  if (!numbers.length && basis == null) return null;
  // A unitless zero after the factors is a basis, per the grammar.
  return {
    flexGrow: numbers[0] ?? 1,
    flexShrink: numbers[1] ?? 1,
    flexBasis: basis ?? (numbers.length ? 0 : "auto"),
  };
}

function splitTopLevel(source, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "(") depth++;
    else if (character === ")") depth--;
    else if (character === separator && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts;
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
