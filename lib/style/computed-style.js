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
  "color", "color-scheme", "font-family", "font-size", "font-weight", "line-height", "list-style-type", "text-align", "white-space",
  "visibility", "overflow-wrap", "word-break", "border-spacing", "border-collapse", "pointer-events",
]);
// Inherited properties whose computed value is copied from the parent as is.
// line-height is not: a unitless factor resolves against each element's own
// font size, so it goes through its specified form (copyProperty).
const INHERITED_FIELDS = new Map([
  ["color", "color"], ["font-family", "fontFamily"], ["font-size", "fontSize"], ["font-weight", "fontWeight"],
  ["list-style-type", "listStyleType"], ["text-align", "textAlign"], ["white-space", "whiteSpace"],
  ["visibility", "visibility"], ["overflow-wrap", "overflowWrap"], ["word-break", "wordBreak"],
  ["border-spacing", "borderSpacing"], ["border-collapse", "borderCollapse"], ["pointer-events", "pointerEvents"],
]);
const LIST_STYLE_TYPES = new Set([
  "none", "disc", "circle", "square", "decimal", "decimal-leading-zero",
  "lower-alpha", "upper-alpha", "lower-latin", "upper-latin", "lower-roman", "upper-roman",
]);
const DISPLAYS = new Set([
  "none", "block", "flex", "grid", "inline", "inline-block", "inline-flex", "inline-grid", "list-item",
  "table", "inline-table", "table-row-group", "table-header-group", "table-footer-group", "table-row",
  "table-cell", "table-caption", "table-column", "table-column-group",
]);
/** CSS Fonts 4 §2.5 absolute-size keywords (medium = 16px). */
const FONT_SIZE_KEYWORDS = Object.freeze({
  "xx-small": 9, "x-small": 10, small: 13, medium: 16, large: 18, "x-large": 24, "xx-large": 32, "xxx-large": 48,
});
/** HTML §15.3.8 table elements and their display types. */
const TABLE_DISPLAYS = new Map(Object.entries({
  TABLE: "table", CAPTION: "table-caption", COLGROUP: "table-column-group", COL: "table-column",
  THEAD: "table-header-group", TBODY: "table-row-group", TFOOT: "table-footer-group", TR: "table-row",
  TD: "table-cell", TH: "table-cell",
}));
const VERTICAL_ALIGNS = new Set(["baseline", "top", "middle", "bottom", "text-top", "text-bottom", "sub", "super"]);
const AUTO_TRACK = Object.freeze({ min: "auto", max: "auto" });
const FLEX_ALIGNMENT = Object.freeze({ "flex-start": "start", "flex-end": "end", left: "start", right: "end" });
const GRADIENT = /^\s*(?:repeating-)?(?:linear|radial)-gradient\(/i;
const BOX_SIDES = Object.freeze(["top", "right", "bottom", "left"]);
const WHITE_SPACES = new Set(["normal", "nowrap", "pre", "pre-wrap"]);
// CSS Cascade 4 §7.3 CSS-wide keywords; revert is treated as unset (no user/UA origin split).
const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
// Computed-style fields a shorthand (or a property not named after its field) covers.
const PROPERTY_FIELDS = Object.freeze({
  background: ["backgroundColor", "backgroundImage"],
  flex: ["flexGrow", "flexShrink", "flexBasis"],
  "flex-flow": ["flexDirection", "flexWrap"],
  gap: ["rowGap", "columnGap", "gap"],
  "grid-gap": ["rowGap", "columnGap", "gap"],
  "grid-area": ["gridRowStart", "gridColumnStart", "gridRowEnd", "gridColumnEnd"],
  "grid-row": ["gridRowStart", "gridRowEnd"],
  "grid-column": ["gridColumnStart", "gridColumnEnd"],
  "grid-template": ["gridTemplateColumns", "gridTemplateRows"],
  "place-content": ["alignContent", "justifyContent"],
  "place-items": ["alignItems", "justifyItems"],
  "place-self": ["alignSelf", "justifySelf"],
  "line-height": ["lineHeight", "lineHeightFactor"],
  "list-style": ["listStyleType"],
  "border-radius": ["borderRadius"],
  "text-decoration": ["textDecorationLine", "textDecorationColor"],
  "text-decoration-line": ["textDecorationLine"],
  "text-decoration-color": ["textDecorationColor"],
  top: ["inset"], right: ["inset"], bottom: ["inset"], left: ["inset"],
});
const BORDER_FIELDS = Object.freeze(["borderSpecifiedWidths", "borderStyles", "borderColors", "borderWidths"]);

const INITIAL = Object.freeze({
  display: "inline",
  // text-decoration: this element's own lines ("none" or an array) and color
  // (null = currentColor); textDecorations adds what ancestors propagate.
  textDecorationLine: "none",
  textDecorationColor: null,
  textDecorations: null,
  color: "rgba(0, 0, 0, 1)",
  colorScheme: "light",
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
  minHeight: "auto",
  maxHeight: "none",
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
  alignContent: "normal",
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
  // Painting only: visibility (inherited), group opacity, overflow clipping
  // ("visible" or "clip"), and clip / clip-path rectangles.
  float: "none",
  // Tables: spacing [horizontal, vertical] (inherited), collapse, and cell alignment.
  borderSpacing: Object.freeze([0, 0]),
  borderCollapse: "separate",
  tableLayout: "auto",
  verticalAlign: "baseline",
  visibility: "visible",
  // Hit testing only (inherited): "none" lets clicks pass through.
  pointerEvents: "auto",
  // Breaking inside words (CSS Text 3 §5): only with these set.
  overflowWrap: "normal",
  wordBreak: "normal",
  opacity: 1,
  overflowX: "visible",
  overflowY: "visible",
  textOverflow: "clip",
  clip: null,
  clipPath: null,
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
  // HTML §15.3.8 tables (vertical-align of rows and groups is inherited by cells).
  TABLE: "border-spacing: 2px; border-collapse: separate",
  THEAD: "vertical-align: middle",
  TBODY: "vertical-align: middle",
  TFOOT: "vertical-align: middle",
  TR: "vertical-align: inherit",
  TD: "padding: 1px; vertical-align: inherit",
  TH: "padding: 1px; vertical-align: inherit; font-weight: bold; text-align: center",
  CAPTION: "text-align: center",
}).map(([tag, source]) => [tag, parseDeclarations(source)]));
/**
 * Form controls (HTML §15.5 describes their rendering only loosely): a 1px
 * gray border, white field background and the 13.33px system font, close to
 * what browsers draw. Checkboxes and radios are 13px boxes; the render tree
 * fills them in when checked.
 */
const CONTROL_FONT = "font-size: 13.333px; font-family: sans-serif";
const FIELD = `${CONTROL_FONT}; border: 1px solid #767676; background-color: white`;
const BUTTON_LIKE = `${CONTROL_FONT}; border: 1px solid #767676; border-radius: 2px; padding: 1px 6px; background-color: #efefef; text-align: center`;
const UA_CONTROL_DECLARATIONS = Object.freeze({
  textarea: parseDeclarations(`${FIELD}; font-family: monospace; padding: 2px; white-space: pre-wrap; overflow-wrap: break-word`),
  text: parseDeclarations(`${FIELD}; padding: 1px 2px; white-space: pre`),
  checkbox: parseDeclarations("width: 13px; height: 13px; margin: 3px 3px 3px 4px; border: 1px solid #767676; border-radius: 2px; background-color: white; box-sizing: border-box"),
  radio: parseDeclarations("width: 13px; height: 13px; margin: 3px 3px 0 5px; border: 1px solid #767676; border-radius: 50%; background-color: white; box-sizing: border-box"),
  button: parseDeclarations(`${BUTTON_LIKE}; white-space: pre`),
  select: parseDeclarations(`${FIELD}; border-radius: 2px; padding: 0 4px; white-space: pre`),
});
const BUTTON_INPUTS = new Set(["button", "submit", "reset", "image", "file", "color"]);

/** Which UA control defaults an element gets, or null. */
export function controlKind(element) {
  switch (element.tagName) {
    case "TEXTAREA": return "textarea";
    case "SELECT": return "select";
    case "BUTTON": return "button";
    case "INPUT": {
      const type = String(element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "hidden") return "hidden";
      if (type === "checkbox" || type === "radio") return type;
      return BUTTON_INPUTS.has(type) ? "button" : "text";
    }
    default: return null;
  }
}

/** HTML §15.3.4: :link (visited links are not tracked). */
const UA_LINK_DECLARATIONS = parseDeclarations("color: #0000EE; text-decoration: underline; cursor: pointer");
const DECORATION_LINES = new Set(["underline", "overline", "line-through"]);
const DECORATION_STYLES = new Set(["solid", "double", "dotted", "dashed", "wavy"]);

const DEFAULT_ENVIRONMENT = Object.freeze({ viewportWidth: 800, viewportHeight: 600, rootFontSize: 16 });
let environment = DEFAULT_ENVIRONMENT;

export class StyleEngine {
  #styles = new WeakMap();
  #customProperties = new WeakMap();
  #pseudoStyles = new WeakMap();
  // Parsed and indexed rules for the last style sheet list and viewport:
  // restyles after script changes reuse them instead of re-parsing.
  #ruleCache = { styleSheets: null, key: "", index: null };

  compute(document, styleSheets = [], viewport = {}) {
    this.#styles = new WeakMap();
    this.#customProperties = new WeakMap();
    this.#pseudoStyles = new WeakMap();
    const previous = environment;
    environment = {
      viewportWidth: viewport.width ?? DEFAULT_ENVIRONMENT.viewportWidth,
      viewportHeight: viewport.height ?? DEFAULT_ENVIRONMENT.viewportHeight,
      rootFontSize: DEFAULT_ENVIRONMENT.rootFontSize,
      mobile: viewport.mobile === true,
    };
    try {
      const rules = this.#rulesFor(styleSheets);
      if (document.documentElement) this.#visit(document.documentElement, null, null, rules);
    } finally {
      environment = previous;
    }
    return this;
  }

  #rulesFor(styleSheets) {
    const key = `${environment.viewportWidth}x${environment.viewportHeight}${environment.mobile ? ":mobile" : ""}`;
    const cache = this.#ruleCache;
    if (cache.styleSheets !== styleSheets || cache.key !== key || cache.length !== styleSheets.length) {
      const counter = { order: 0 };
      const rules = styleSheets.flatMap((source) => parseStyleSheet(source, environment, counter));
      if (counter.layers) rankLayers(counter.layers, rules);
      this.#ruleCache = { styleSheets, key, length: styleSheets.length, index: new RuleIndex(rules) };
    }
    return this.#ruleCache.index;
  }

  get(element) {
    return this.#styles.get(element) ?? INITIAL;
  }

  /** The computed style of an element's ::before/::after box, or null when it generates none. */
  getPseudo(element, pseudo) {
    return this.#pseudoStyles.get(element)?.[pseudo] ?? null;
  }

  #visit(element, parentStyle, parentCustomProperties, rules, ancestors = new Map()) {
    const keys = elementKeys(element);
    // Inline style takes part in the cascade before custom properties are
    // resolved: style="--x: ..." must win over stylesheet values of --x.
    const declarations = withInlineStyle(element, cascadeDeclarations(element, rules, null, keys, ancestors));
    const customProperties = withCustomProperties(parentCustomProperties ?? EMPTY_MAP, declarations);
    const style = computeElementStyle(element, parentStyle, declarations, customProperties);
    // rem units resolve against the root element's computed font size.
    if (!parentStyle) environment = { ...environment, rootFontSize: style.fontSize };
    this.#styles.set(element, style);
    this.#customProperties.set(element, customProperties);
    const pseudoStyles = {};
    for (const pseudo of ["before", "after"]) {
      const pseudoDeclarations = cascadeDeclarations(element, rules, pseudo, keys, ancestors);
      if (!pseudoDeclarations.has("content")) continue;
      const pseudoCustom = withCustomProperties(customProperties, pseudoDeclarations);
      const pseudoStyle = computeElementStyle(pseudoElement(pseudo), style, pseudoDeclarations, pseudoCustom);
      // `content: none | normal` generates no box (CSS Pseudo 4 §2.3).
      if (pseudoStyle.content != null && pseudoStyle.display !== "none") pseudoStyles[pseudo] = pseudoStyle;
    }
    if (pseudoStyles.before || pseudoStyles.after) this.#pseudoStyles.set(element, pseudoStyles);
    // The element is an ancestor of everything below it.
    const own = ancestorFilterKeys(keys);
    for (const key of own) ancestors.set(key, (ancestors.get(key) ?? 0) + 1);
    for (const child of element.children) this.#visit(child, style, customProperties, rules, ancestors);
    for (const key of own) {
      const count = ancestors.get(key) - 1;
      if (count) ancestors.set(key, count);
      else ancestors.delete(key);
    }
  }
}

const EMPTY_MAP = new Map();

/** The cascaded declarations with the element's style attribute applied on top. */
function withInlineStyle(element, declarations) {
  const inline = element.getAttribute?.("style");
  if (!inline) return declarations;
  for (const declaration of parseDeclarations(inline).values()) {
    const current = declarations.get(declaration.name);
    if (!current?.important || declaration.important) {
      declarations.set(declaration.name, { ...declaration, specificity: 1_000_000, order: Infinity });
      if (declaration.name.startsWith("--")) declarations.hasCustomProperties = true;
    }
  }
  return declarations;
}

/**
 * Custom properties after an element's declarations. Most elements declare
 * none and share their parent's map; a copy is made only when one is set.
 * (Copying a Map per element is slow once SES lockdown() has frozen the
 * Map intrinsics, which disables JSC's fast paths for them.)
 */
function withCustomProperties(inherited, declarations) {
  if (declarations.hasCustomProperties === false) return inherited;
  let result = inherited;
  for (const declaration of declarations.values()) {
    if (!declaration.name.startsWith("--")) continue;
    if (result === inherited) result = new Map(inherited);
    result.set(declaration.name, declaration.value);
  }
  return result;
}

export function computeElementStyle(element, parentStyle = null, authorDeclarations = null, customProperties = new Map()) {
  const values = { ...INITIAL };
  if (parentStyle) {
    for (const property of INHERITED) {
      const field = INHERITED_FIELDS.get(property);
      if (field) values[field] = parentStyle[field];
      else copyProperty(values, property, parentStyle);
    }
  }
  // vertical-align is not inherited, except through the table UA rules' "inherit".
  values.verticalAlign = "baseline";
  if (NONE_TAGS.has(element.tagName) || element.hasAttribute("hidden")) values.display = "none";
  else if (TABLE_DISPLAYS.has(element.tagName)) values.display = TABLE_DISPLAYS.get(element.tagName);
  else if (BLOCK_TAGS.has(element.tagName)) values.display = element.tagName === "LI" ? "list-item" : "block";
  else if (["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(element.tagName)) values.display = "inline-block";
  if (["B", "STRONG"].includes(element.tagName)) values.fontWeight = 700;
  if (element.tagName === "PRE") values.whiteSpace = "pre";

  const declarations = new Map(authorDeclarations ?? []);
  const isLink = (element.tagName === "A" || element.tagName === "AREA") && element.hasAttribute("href");
  const control = controlKind(element);
  if (control === "hidden") values.display = "none";
  for (const declaration of [...(UA_DECLARATIONS.get(element.tagName)?.values() ?? []),
    ...(isLink ? UA_LINK_DECLARATIONS.values() : []), ...(UA_CONTROL_DECLARATIONS[control]?.values() ?? [])]) {
    if (!declarations.has(declaration.name)) {
      declarations.set(declaration.name, { ...declaration, specificity: -1, order: -1, layer: -Infinity });
    }
  }
  for (const declaration of parseDeclarations(element.getAttribute("style") ?? "").values()) {
    const current = declarations.get(declaration.name);
    if (!current?.important || declaration.important) {
      declarations.set(declaration.name, { ...declaration, specificity: 1_000_000, order: Infinity });
    }
  }
  // The font size comes first (em lengths use it), from whichever of
  // font-size and the font shorthand wins the cascade.
  const fontSize = declarations.get("font-size");
  const font = declarations.get("font");
  const cascadeKey = (declaration) => ({ important: false, specificity: 0, order: 0, ...declaration, important: Boolean(declaration.important) });
  if (font && (!fontSize || compareCascade(cascadeKey(font), cascadeKey(fontSize)) > 0)) {
    const parsed = parseFontShorthand(resolveVariables(font.value, customProperties));
    if (parsed) setProperty(values, "font-size", parsed.size, parentStyle);
  } else if (fontSize) {
    applyDeclaration(values, fontSize, customProperties, parentStyle);
  }
  // light-dark() depends on the used scheme regardless of declaration order.
  const colorScheme = declarations.get("color-scheme");
  if (colorScheme) applyDeclaration(values, colorScheme, customProperties, parentStyle);
  // Apply in cascade order so a later shorthand overrides earlier longhands and vice versa.
  const ordered = [...declarations.values()].sort((left, right) => compareCascade(
    { important: false, specificity: 0, order: 0, ...left, important: Boolean(left.important) },
    { important: false, specificity: 0, order: 0, ...right, important: Boolean(right.important) },
  ));
  for (const declaration of ordered) {
    if (declaration.name.startsWith("--") || declaration.name === "font-size" || declaration.name === "color-scheme") continue;
    // The shorthand's size was settled above; its other parts apply in order.
    applyDeclaration(values, declaration.name === "font" ? { ...declaration, name: "font-parts" } : declaration, customProperties, parentStyle);
  }
  // Floats (approximation): laid out as atomic inlines in the line, left floats
  // in order and right floats at the line's end. Absolutely positioned boxes
  // and flex/grid items do not float (CSS 2 §9.7, Flexbox §4, Grid §6).
  const parentDisplay = parentStyle?.display ?? "block";
  const flexOrGridItem = ["flex", "inline-flex", "grid", "inline-grid"].includes(parentDisplay);
  if (values.float !== "none" && (["absolute", "fixed"].includes(values.position) || flexOrGridItem)) values.float = "none";
  if (values.float !== "none" && values.display !== "none") {
    values.display = { flex: "inline-flex", grid: "inline-grid", "inline-flex": "inline-flex", "inline-grid": "inline-grid" }[values.display]
      ?? "inline-block";
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
  // Text decorations propagate to in-flow descendants, but not into atomic
  // inlines or out-of-flow boxes (CSS Text Decoration 3 §2.1). Each ancestor's
  // lines keep their own color in the spec; here the innermost color wins.
  const atomic = /^inline-/.test(values.display) || ["absolute", "fixed"].includes(values.position);
  let decorations = atomic ? null : parentStyle?.textDecorations ?? null;
  if (Array.isArray(values.textDecorationLine)) {
    decorations = Object.freeze({
      lines: Object.freeze([...new Set([...(decorations?.lines ?? []), ...values.textDecorationLine])]),
      color: values.textDecorationColor ?? values.color,
    });
  }
  values.textDecorations = decorations;
  if (control === "textarea" || control === "text") applyControlSize(element, control, values);
  values.margin = Object.freeze(values.margin);
  values.inset = Object.freeze([...values.inset]);
  values.padding = Object.freeze(values.padding);
  return Object.freeze(values);
}

/**
 * A declaration block, parsed on first use. A large site ships tens of
 * thousands of rules and only a few percent ever match, so blocks are kept
 * as ranges of the sheet text until a rule applies (the idea of Blink's
 * CSSLazyParsingState, core/css/parser/css_lazy_parsing_state.cc, BSD).
 */
class DeclarationBlock {
  #css;
  #start;
  #end;
  #parsed = null;

  constructor(css, start, end) {
    this.#css = css;
    this.#start = start;
    this.#end = end;
  }

  #parse() {
    if (!this.#parsed) {
      const map = parseDeclarations(this.#css.slice(this.#start, this.#end));
      // Arrays and flags for the cascade loop: iterating Maps is slow once SES
      // lockdown() has frozen their intrinsics.
      const list = [...map.values()];
      this.#parsed = { map, list, custom: list.some((declaration) => declaration.name.startsWith("--")) };
      this.#css = null;
    }
    return this.#parsed;
  }

  get map() {
    return this.#parse().map;
  }

  get list() {
    return this.#parse().list;
  }

  get hasCustomProperties() {
    return this.#parse().custom;
  }
}

/**
 * One selector of a style rule. Specificity and declarations are computed on
 * first use: most selectors of a large site never match.
 */
class StyleRule {
  #selectorText;
  #specificity = null;
  #block;

  constructor(selector, selectorText, pseudo, block, order) {
    this.selector = selector;
    this.#selectorText = selectorText;
    this.pseudo = pseudo;
    this.#block = block;
    this.order = order;
  }

  get specificity() {
    return this.#specificity ??= selectorSpecificity(this.#selectorText);
  }

  get declarations() {
    return this.#block.map;
  }

  get declarationList() {
    return this.#block.list;
  }

  get hasCustomProperties() {
    return this.#block.hasCustomProperties;
  }
}

/**
 * Parses style rules, descending into conditional group rules. `@media` is
 * evaluated against the viewport; `@supports` and `@layer` blocks are applied;
 * other at-rules (`@font-face`, `@keyframes`, ...) are skipped.
 */
export function parseStyleSheet(source, viewport = environment, counter = { order: 0 }) {
  const rules = [];
  const css = String(source).replace(/\/\*[\s\S]*?\*\//g, "");
  // Cascade layers are ordered across every sheet parsed with this counter.
  counter.layers ??= newLayer(null);

  function parseBlock(start, end, layer = null) {
    let index = start;
    while (index < end) {
      const open = findTopLevel(css, "{", index, end);
      const semicolon = findTopLevel(css, ";", index, end);
      if (semicolon !== -1 && (open === -1 || semicolon < open)) {
        // `@layer a, b;` declares layer order without rules.
        const statement = css.slice(index, semicolon).trim();
        if (/^@layer\s/i.test(statement)) {
          for (const name of statement.slice(6).split(",").map((part) => part.trim()).filter(Boolean)) {
            declareLayer(layer ?? counter.layers, name);
          }
        }
        index = semicolon + 1;
        continue;
      }
      if (open === -1) break;
      const close = matchingBrace(css, open, end);
      const prelude = css.slice(index, open).trim();
      if (prelude.startsWith("@")) {
        const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase();
        const condition = prelude.slice(name ? name.length + 1 : 1).trim();
        if (name === "layer") {
          // A named layer block, or an anonymous one (a layer of its own).
          const parent = layer ?? counter.layers;
          const inner = condition ? declareLayer(parent, condition) : declareLayer(parent, `\0anonymous${counter.order}`);
          parseBlock(open + 1, close, inner);
        } else if ((name === "media" && mediaQueryMatches(condition, viewport)) || name === "supports") {
          parseBlock(open + 1, close, layer);
        }
      } else if (prelude) {
        const block = new DeclarationBlock(css, open + 1, close);
        for (const selectorText of splitTopLevel(prelude, ",").filter(Boolean)) {
          const { selector, pseudo } = splitPseudoElement(selectorText);
          if (pseudo === undefined) continue;
          const rule = new StyleRule(selector, selectorText, pseudo, block, counter.order++);
          rule.layerNode = layer;
          rules.push(rule);
        }
      }
      index = close + 1;
    }
  }

  parseBlock(0, css.length);
  return rules;
}

function newLayer(parent) {
  return { parent, children: new Map(), rank: Infinity };
}

/** Finds or creates a (possibly dotted) layer name under `parent`, in first-seen order. */
function declareLayer(parent, name) {
  let node = parent;
  for (const part of name.split(".").map((piece) => piece.trim()).filter(Boolean)) {
    let child = node.children.get(part);
    if (!child) node.children.set(part, child = newLayer(node));
    node = child;
  }
  return node;
}

/**
 * Cascade layer ranks (CSS Cascade 5 §6.4): layers in first-seen order, a
 * layer's sublayers before its own rules; unlayered rules rank highest.
 */
export function rankLayers(root, rules) {
  let next = 0;
  (function visit(node) {
    for (const child of node.children.values()) visit(child);
    if (node !== root) node.rank = next++;
  })(root);
  for (const rule of rules) rule.layer = rule.layerNode ? rule.layerNode.rank : Infinity;
}

/** Splits a `font` shorthand value into size, line height, weight and family. */
function parseFontShorthand(value) {
  const tokens = splitTopLevel(value, " ").filter(Boolean);
  let weight = null;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const lower = token.toLowerCase();
    if (["normal", "italic", "oblique", "small-caps"].includes(lower) || /^(?:ultra-|extra-|semi-)?(?:condensed|expanded)$/.test(lower)) continue;
    if (["bold", "bolder", "lighter"].includes(lower) || /^[1-9]00$/.test(lower)) {
      weight = lower === "bolder" ? "700" : lower === "lighter" ? "300" : lower;
      continue;
    }
    // The size, optionally with /line-height (spaces around "/" allowed),
    // then the family list.
    let [size, lineHeight] = token.split("/");
    let rest = index + 1;
    if (lineHeight === "") lineHeight = tokens[rest++]; // "14px/ 1.5"
    else if (lineHeight === undefined && tokens[rest] === "/") { // "14px / 1.5"
      lineHeight = tokens[rest + 1];
      rest += 2;
    } else if (lineHeight === undefined && tokens[rest]?.startsWith("/")) lineHeight = tokens[rest++].slice(1); // "14px /1.5"
    const family = tokens.slice(rest).join(" ").trim();
    if (!family || !(FONT_SIZE_KEYWORDS[size] || /^[\d.]/.test(size) || /^(?:calc|clamp|min|max)\(/.test(size))) return null;
    return { size, lineHeight: lineHeight || null, weight, family };
  }
  return null;
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
  const mobile = viewport.mobile === true;
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
      if (feature) return mediaFeatureMatches(feature[1], feature[2], width, height, mobile);
      const range = /^\(\s*(width|height)\s*(<=|>=|<|>|=)\s*(.+?)\s*\)$/.exec(part);
      if (!range) return false;
      const actual = range[1] === "width" ? width : height;
      const limit = mediaLength(range[3]);
      return { "<=": actual <= limit, ">=": actual >= limit, "<": actual < limit, ">": actual > limit, "=": actual === limit }[range[2]];
    });
    return negate ? !matches : matches;
  });
}

function mediaFeatureMatches(name, value, width, height, mobile = false) {
  switch (name) {
    // Input features are only answered in --mobile mode (a touch screen);
    // otherwise they match nothing, as before.
    case "hover":
    case "any-hover":
      return mobile && value === "none";
    case "pointer":
    case "any-pointer":
      return mobile && (value === undefined || value === "coarse");
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
    // Custom property names are case-sensitive (CSS Variables 1 §2).
    const rawName = part.slice(0, colon).trim();
    const name = rawName.startsWith("--") ? rawName : rawName.toLowerCase();
    let value = part.slice(colon + 1).trim();
    const important = /\s*!important\s*$/i.test(value);
    value = value.replace(/\s*!important\s*$/i, "").trim();
    if (!name || !value || (declarations.get(name)?.important && !important)) continue;
    declarations.set(name, { name, value, important });
  }
  return declarations;
}

const reportedDeclarationErrors = new Set();

/**
 * Applies one cascaded declaration. A declaration the engine cannot handle is
 * dropped, as an invalid declaration would be, instead of failing the page.
 */
function applyDeclaration(style, declaration, customProperties, parentStyle) {
  try {
    setProperty(style, declaration.name, resolveVariables(declaration.value, customProperties), parentStyle);
  } catch (error) {
    const key = `${declaration.name}: ${declaration.value}`;
    if (reportedDeclarationErrors.size < 100 && !reportedDeclarationErrors.has(key)) {
      reportedDeclarationErrors.add(key);
      console.error(`buninu-browser: style: dropped "${key}": ${error?.message ?? error}`);
    }
  }
}

function setProperty(style, name, value, parentStyle = null) {
  if (CSS_WIDE_KEYWORDS.has(value)) {
    const inherits = value === "inherit" || (value !== "initial" && INHERITED.has(name));
    copyProperty(style, name, inherits && parentStyle ? parentStyle : INITIAL);
    return;
  }
  if (typeof value !== "string") return;
  switch (name) {
    case "color-scheme": {
      const schemes = value.toLowerCase().split(/\s+/).filter((part) => part !== "only");
      if (schemes.every((part) => ["normal", "light", "dark"].includes(part))) {
        style.colorScheme = schemes.includes("light") || !schemes.includes("dark") ? "light" : "dark";
      }
      break;
    }
    case "display": if (DISPLAYS.has(value)) style.display = value; break;
    case "text-decoration-line": {
      const lines = parseDecorationLines(value);
      if (lines) style.textDecorationLine = lines;
      break;
    }
    case "text-decoration-color": {
      if (value.toLowerCase() === "currentcolor") style.textDecorationColor = null;
      else if (Bun.color(value, "rgba")) style.textDecorationColor = Bun.color(value, "rgba");
      break;
    }
    case "text-decoration": {
      // <line> || <style> || <color> || <thickness>; only lines and color are drawn.
      let lines = "none";
      let color = null;
      for (const token of splitTopLevel(value, " ").filter(Boolean)) {
        const lower = token.toLowerCase();
        if (DECORATION_LINES.has(lower) || lower === "none") {
          const parsed = parseDecorationLines(lower === "none" ? "none" : [...(Array.isArray(lines) ? lines : []), lower].join(" "));
          if (!parsed) return;
          lines = parsed;
        } else if (DECORATION_STYLES.has(lower) || lower === "auto" || lower === "from-font"
          || Number.isFinite(computedLength(token, style.fontSize, true)) || /%$/.test(token)) {
          continue;
        } else if (lower === "currentcolor") {
          color = null;
        } else if (Bun.color(token, "rgba")) {
          color = Bun.color(token, "rgba");
        } else {
          return;
        }
      }
      style.textDecorationLine = lines;
      style.textDecorationColor = color;
      break;
    }
    case "visibility":
      if (["visible", "hidden", "collapse"].includes(value)) style.visibility = value === "collapse" ? "hidden" : value;
      break;
    // SVG-only values (visiblePainted, fill, ...) hit like auto for HTML boxes.
    case "pointer-events":
      if (/^[a-z]+$/i.test(value)) style.pointerEvents = value === "none" ? "none" : "auto";
      break;
    case "opacity": {
      const number = /^([+-]?(?:\d+\.?\d*|\.\d+))(%?)$/.exec(value);
      if (number) style.opacity = Math.min(1, Math.max(0, Number(number[1]) / (number[2] ? 100 : 1)));
      break;
    }
    case "overflow":
    case "overflow-x":
    case "overflow-y": {
      // Scrolling boxes are not implemented: every non-visible value clips.
      const parts = value.split(/\s+/);
      const clips = (part) => (["hidden", "clip", "auto", "scroll", "overlay"].includes(part) ? "clip" : part === "visible" ? "visible" : null);
      const x = clips(parts[0]);
      const y = clips(parts[1] ?? parts[0]);
      if (name !== "overflow-y" && x) style.overflowX = x;
      if (name !== "overflow-x" && (name === "overflow" ? y : x)) style.overflowY = name === "overflow" ? y : x;
      break;
    }
    case "text-overflow":
      if (["clip", "ellipsis"].includes(value)) style.textOverflow = value;
      break;
    case "clip": {
      // CSS 2 clip (absolutely positioned boxes): rect(top, right, bottom, left), auto keeps an edge.
      if (value === "auto") style.clip = null;
      const rect = /^rect\(\s*(.*)\s*\)$/i.exec(value);
      if (rect) {
        const edges = rect[1].split(/\s*,\s*|\s+/).map((part) => (part === "auto" ? "auto" : computedLength(part, style.fontSize)));
        if (edges.length === 4 && edges.every((edge) => edge === "auto" || Number.isFinite(edge))) style.clip = Object.freeze(edges);
      }
      break;
    }
    case "clip-path": {
      // Only rectangles: inset(top right bottom left) and rect(0 0 0 0)-style empty clips.
      if (value === "none") style.clipPath = null;
      const inset = /^inset\(\s*([^)]*?)\s*(?:round\s[^)]*)?\)$/i.exec(value);
      if (inset) {
        const box = boxLengths(inset[1], false, style.fontSize, false, true);
        if (box) style.clipPath = Object.freeze({ inset: box });
      } else if (/^rect\(\s*0(?:px)?\s+0(?:px)?\s+0(?:px)?\s+0(?:px)?\s*\)$/i.test(value)) {
        style.clipPath = Object.freeze({ empty: true });
      }
      break;
    }
    case "color": {
      const color = resolvedColor(value, style.colorScheme);
      if (color) style.color = color;
      break;
    }
    case "background-color": {
      const color = resolvedColor(value, style.colorScheme);
      if (color) style.backgroundColor = color;
      break;
    }
    case "background": {
      // The shorthand resets both longhands; only the final layer may carry a color.
      const layers = splitTopLevel(value, ",");
      const images = layers.filter((layer) => GRADIENT.test(layer));
      const color = splitTopLevel(layers.at(-1) ?? "", " ")
        .map((token) => resolvedColor(token, style.colorScheme))
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
      const parentSize = parentStyle?.fontSize ?? INITIAL.fontSize;
      const length = FONT_SIZE_KEYWORDS[value] ?? (value === "larger" ? parentSize * 1.2 : value === "smaller" ? parentSize / 1.2
        : computedLength(value, parentSize));
      if (length > 0) style.fontSize = length;
      break;
    }
    case "font":
    case "font-parts": {
      // CSS Fonts 4 §3.7: [style] [variant] [weight] [stretch] size[/line-height] family.
      // Omitted parts reset to their initial values; system fonts are not supported.
      // ("font-parts" is the shorthand without its size, used by the cascade.)
      const parsed = parseFontShorthand(value);
      if (!parsed) break;
      if (name === "font") setProperty(style, "font-size", parsed.size, parentStyle);
      setProperty(style, "line-height", parsed.lineHeight ?? "normal", parentStyle);
      setProperty(style, "font-weight", parsed.weight ?? "normal", parentStyle);
      setProperty(style, "font-family", parsed.family, parentStyle);
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
    case "border-spacing": {
      const parts = value.split(/\s+/).map((part) => computedLength(part, style.fontSize));
      if (parts.length <= 2 && parts.every((part) => Number.isFinite(part) && part >= 0)) {
        style.borderSpacing = Object.freeze([parts[0], parts[1] ?? parts[0]]);
      }
      break;
    }
    case "border-collapse":
      if (["separate", "collapse"].includes(value)) style.borderCollapse = value;
      break;
    case "table-layout":
      if (["auto", "fixed"].includes(value)) style.tableLayout = value;
      break;
    case "vertical-align":
      if (VERTICAL_ALIGNS.has(value)) style.verticalAlign = value;
      break;
    case "float":
      if (["none", "left", "right", "inline-start", "inline-end"].includes(value)) {
        style.float = value === "inline-start" ? "left" : value === "inline-end" ? "right" : value;
      }
      break;
    case "overflow-wrap":
    case "word-wrap":
      if (["normal", "break-word", "anywhere"].includes(value)) style.overflowWrap = value;
      break;
    case "word-break":
      if (["normal", "break-all", "keep-all", "break-word"].includes(value)) style.wordBreak = value;
      break;
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
      if (length === "auto" || isLength(length)) style[name] = length;
      break;
    }
    case "min-width":
    case "max-width":
    case "min-height":
    case "max-height": {
      const none = name.startsWith("max-") && value === "none";
      const length = none ? "none" : computedLength(value, style.fontSize, true);
      if (none || isLength(length)) {
        style[{ "min-width": "minWidth", "max-width": "maxWidth", "min-height": "minHeight", "max-height": "maxHeight" }[name]] = length;
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
    case "align-content": {
      const alignment = FLEX_ALIGNMENT[value] ?? value;
      if (["normal", "stretch", "start", "end", "center", "space-between", "space-around", "space-evenly"].includes(alignment)) {
        style.alignContent = alignment;
      }
      break;
    }
    // CSS Box Alignment 3 §5.1/§6.1/§6.2: <align> [<justify>]; one value sets both.
    case "place-content":
    case "place-items":
    case "place-self": {
      const [align, justify = align] = splitTopLevel(value, " ").filter(Boolean);
      if (!align) break;
      const part = name.slice("place-".length);
      setProperty(style, `align-${part}`, align, parentStyle);
      setProperty(style, `justify-${part}`, justify, parentStyle);
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

/**
 * Rules bucketed by the rightmost compound selector's id, class, attribute
 * name or type (as Blink's RuleSet does), so an element is only matched
 * against rules that could apply to it. Rules without such a key go to the
 * universal bucket. Each rule also lists keys its ancestors must carry
 * (from compounds joined by descendant or child combinators), which rejects
 * most non-matching rules before the selector engine runs, like Blink's
 * ancestor Bloom filter.
 */
class RuleIndex {
  #byPseudo = new Map();
  #stamp = 0;

  constructor(rules) {
    for (const rule of rules) {
      let buckets = this.#byPseudo.get(rule.pseudo);
      if (!buckets) {
        buckets = { id: new Map(), class: new Map(), attr: new Map(), tag: new Map(), universal: [] };
        this.#byPseudo.set(rule.pseudo, buckets);
      }
      const parts = selectorParts(rule.selector);
      rule.ancestorKeys = parts ? ancestorKeys(parts) : [];
      rule.seen = 0;
      const keys = parts ? subjectKeys(parts.compounds.at(-1)) : null;
      if (!keys) {
        buckets.universal.push(rule);
        continue;
      }
      for (const key of keys) {
        const map = buckets[key.kind];
        const list = map.get(key.name);
        if (list) list.push(rule);
        else map.set(key.name, [rule]);
      }
    }
  }

  /**
   * Rules that may match `element` for `pseudo`, in cascade order.
   * @param {ReturnType<typeof elementKeys>} keys the element's own keys
   * @param {Map<string, number>} ancestors keys present on its ancestors
   */
  candidates(keys, pseudo, ancestors) {
    const buckets = this.#byPseudo.get(pseudo);
    if (!buckets) return [];
    const lists = [buckets.universal];
    if (keys.id) lists.push(buckets.id.get(keys.id));
    for (const name of keys.classes) lists.push(buckets.class.get(name));
    for (const name of keys.attrs) lists.push(buckets.attr.get(name));
    if (keys.tag) lists.push(buckets.tag.get(keys.tag));
    // A rule in several buckets (from :is()) is taken once.
    const stamp = ++this.#stamp;
    const result = [];
    for (const list of lists) {
      if (!list) continue;
      for (const rule of list) {
        if (rule.seen === stamp) continue;
        rule.seen = stamp;
        if (rule.ancestorKeys.every((key) => ancestors.has(key))) result.push(rule);
      }
    }
    if (lists.length > 1) result.sort((left, right) => left.order - right.order);
    return result;
  }
}

/** The keys an element offers to selectors: id, classes, attribute names, type. */
function elementKeys(element) {
  const id = element.getAttribute?.("id") || null;
  const className = element.getAttribute?.("class");
  const classes = className ? [...new Set(className.split(/\s+/))].filter(Boolean) : [];
  const attrs = [];
  for (const attribute of element.attributes ?? []) attrs.push(String(attribute.name).toLowerCase());
  const tag = element.localName ?? element.tagName;
  return { id, classes, attrs, tag: tag ? String(tag).toLowerCase() : null };
}

/** Ancestor filter keys for an element: "tag", "#id", ".class", "[attr". */
function ancestorFilterKeys(keys) {
  const result = [];
  if (keys.tag) result.push(keys.tag);
  if (keys.id) result.push(`#${keys.id}`);
  for (const name of keys.classes) result.push(`.${name}`);
  for (const name of keys.attrs) result.push(`[${name}`);
  return result;
}

/**
 * Splits a complex selector into compounds and the combinators between them
 * (" ", ">", "+", "~"), ignoring anything inside (), [] and quotes. Returns
 * null for selectors this does not understand, which are then left unindexed.
 */
function selectorParts(selector) {
  const compounds = [];
  const combinators = [];
  let current = "";
  let pending = null;
  let depth = 0;
  for (let index = 0; index < selector.length; index++) {
    const character = selector[index];
    if (character === "\\") {
      current += character + (selector[++index] ?? "");
      continue;
    }
    if (character === "\"" || character === "'") {
      const close = selector.indexOf(character, index + 1);
      if (close < 0) return null;
      current += selector.slice(index, close + 1);
      index = close;
      continue;
    }
    if (character === "(" || character === "[") depth++;
    else if (character === ")" || character === "]") depth--;
    if (depth === 0 && (character === " " || character === ">" || character === "+" || character === "~"
      || character === "\t" || character === "\n" || character === "\r" || character === "\f")) {
      if (current) {
        compounds.push(current);
        current = "";
        pending = " ";
      }
      if (character === ">" || character === "+" || character === "~") {
        if (pending === null && compounds.length === 0) return null;
        pending = character;
      }
      continue;
    }
    if (pending !== null) {
      combinators.push(pending);
      pending = null;
    }
    current += character;
  }
  if (depth !== 0) return null;
  if (current) compounds.push(current);
  else if (pending !== null && compounds.length) return null;
  return compounds.length ? { compounds, combinators } : null;
}

const IDENTIFIER = /^(?:[\w-]|\\[^0-9a-fA-F\s]|[^\x00-\x7f])+/;

/** An identifier at the start of `text`, unescaped; null when absent or hex-escaped. */
function leadingIdentifier(text) {
  const match = IDENTIFIER.exec(text);
  if (!match || text[match[0].length] === "\\") return null;
  return match[0].replace(/\\(.)/g, "$1");
}

/** Keys of one compound selector, from its parts outside () (ids, classes, attribute names, type). */
function compoundKeys(compound) {
  const keys = { ids: [], classes: [], attrs: [], tag: null, pseudo: [] };
  if (compound.includes("|")) return keys;
  const tag = /^[a-zA-Z][\w-]*/.exec(compound)?.[0];
  if (tag) keys.tag = tag.toLowerCase();
  let depth = 0;
  for (let index = 0; index < compound.length; index++) {
    const character = compound[index];
    if (character === "\\") {
      index++;
      continue;
    }
    if (character === "(") {
      depth++;
      continue;
    }
    if (character === ")") {
      depth--;
      continue;
    }
    if (depth > 0) continue;
    if (character === "[") {
      const name = /^\s*([\w-]+)/.exec(compound.slice(index + 1))?.[1];
      if (name) keys.attrs.push(name.toLowerCase());
      // Skip to the closing bracket; quoted values may contain "]", "#" or ".".
      let quote = null;
      for (index++; index < compound.length; index++) {
        const inner = compound[index];
        if (inner === "\\") index++;
        else if (quote) {
          if (inner === quote) quote = null;
        } else if (inner === "\"" || inner === "'") quote = inner;
        else if (inner === "]") break;
      }
    } else if (character === "#" || character === ".") {
      const name = leadingIdentifier(compound.slice(index + 1));
      if (name && !(character === "." && /^\d/.test(name))) (character === "#" ? keys.ids : keys.classes).push(name);
    } else if (character === ":") {
      const name = /^:?([\w-]+)/.exec(compound.slice(index + 1))?.[1];
      if (name) keys.pseudo.push({ name: name.toLowerCase(), start: index });
    }
  }
  return keys;
}

/**
 * Bucket keys for the subject compound: one id, class, attribute or type key,
 * or one per alternative of an :is()/:where() whose alternatives all have one.
 */
function subjectKeys(compound) {
  const keys = compoundKeys(compound);
  if (keys.ids.length) return [{ kind: "id", name: keys.ids[0] }];
  if (keys.classes.length) return [{ kind: "class", name: keys.classes[0] }];
  if (keys.attrs.length) return [{ kind: "attr", name: keys.attrs[0] }];
  if (keys.tag) return [{ kind: "tag", name: keys.tag }];
  if (keys.pseudo.some(({ name }) => name === "root")) return [{ kind: "tag", name: "html" }];
  for (const { name, start } of keys.pseudo) {
    if (!["is", "where", "matches", "-webkit-any"].includes(name)) continue;
    const open = compound.indexOf("(", start);
    const close = open < 0 ? -1 : matchingParenthesis(compound, open);
    if (close < 0) return null;
    const alternatives = splitTopLevel(compound.slice(open + 1, close), ",").filter(Boolean);
    const result = [];
    for (const alternative of alternatives) {
      // Only simple alternatives: complex ones inside :is() are left to the
      // selector engine unindexed, so indexing never changes a result.
      const parts = selectorParts(alternative.trim());
      const inner = parts?.compounds.length === 1 ? subjectKeys(parts.compounds[0]) : null;
      if (!inner) return null;
      result.push(...inner);
    }
    return result.length ? result : null;
  }
  return null;
}

/** Keys that must be present on some ancestor for the selector to match. */
function ancestorKeys(parts) {
  const keys = new Set();
  for (let index = 0; index < parts.compounds.length - 1; index++) {
    // Only compounds whose right-hand combinator is descendant or child are
    // ancestors of the subject (a sibling's parent is the subject's parent).
    if (parts.combinators[index] !== " " && parts.combinators[index] !== ">") continue;
    const compound = compoundKeys(parts.compounds[index]);
    if (compound.tag) keys.add(compound.tag);
    for (const id of compound.ids) keys.add(`#${id}`);
    for (const name of compound.classes) keys.add(`.${name}`);
    for (const name of compound.attrs) keys.add(`[${name}`);
  }
  return [...keys];
}

function matchingParenthesis(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === "(") depth++;
    else if (text[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

function cascadeDeclarations(element, rules, pseudo = null, keys = elementKeys(element), ancestors = new Map()) {
  const result = new Map();
  result.hasCustomProperties = false;
  for (const rule of rules.candidates(keys, pseudo, ancestors)) {
    if (!matchesSelector(element, rule)) continue;
    if (rule.hasCustomProperties) result.hasCustomProperties = true;
    for (const declaration of rule.declarationList) {
      const candidate = { ...declaration, specificity: rule.specificity, order: rule.order, layer: rule.layer ?? Infinity };
      const current = result.get(candidate.name);
      if (!current || compareCascade(candidate, current) >= 0) result.set(candidate.name, candidate);
    }
  }
  return result;
}

function compareCascade(left, right) {
  if (left.important !== right.important) return left.important ? 1 : -1;
  // Cascade layers: later layers and unlayered styles win for normal
  // declarations; for !important the order is reversed.
  const leftLayer = left.layer ?? Infinity;
  const rightLayer = right.layer ?? Infinity;
  if (leftLayer !== rightLayer) return (leftLayer > rightLayer ? 1 : -1) * (left.important ? -1 : 1);
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

/**
 * Substitutes var() references (CSS Variables 1 §3). Fallbacks may contain
 * commas and nested functions, including other var()s; a reference to an
 * undefined property without a fallback leaves nothing (the declaration then
 * has no effect).
 */
function resolveVariables(value, customProperties, seen = new Set()) {
  const text = String(value);
  // Most values use no custom properties; skip the parsing.
  if (!text.includes("var(")) return text.trim();
  let result = "";
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("var(", index);
    if (start < 0) {
      result += text.slice(index);
      break;
    }
    // Part of a longer function name such as "somevar(".
    if (start > 0 && /[\w-]/.test(text[start - 1])) {
      result += text.slice(index, start + 4);
      index = start + 4;
      continue;
    }
    result += text.slice(index, start);
    let depth = 1;
    let end = start + 4;
    let comma = -1;
    for (; end < text.length && depth > 0; end++) {
      const character = text[end];
      if (character === "(") depth++;
      else if (character === ")") depth--;
      else if (character === "," && depth === 1 && comma < 0) comma = end;
    }
    if (depth > 0) {
      // Unbalanced: leave the rest as it is.
      result += text.slice(start);
      break;
    }
    const inner = text.slice(start + 4, end - 1);
    const name = (comma < 0 ? inner : text.slice(start + 4, comma)).trim();
    const fallback = comma < 0 ? null : text.slice(comma + 1, end - 1);
    const replacement = seen.has(name) ? null : customProperties.get(name);
    // A property in a reference cycle is invalid: its fallback applies.
    const substituted = replacement == null ? "" : resolveVariables(replacement, customProperties, new Set([...seen, name]));
    if (substituted) result += substituted;
    else if (fallback != null) result += resolveVariables(fallback, customProperties, seen);
    index = end;
  }
  return result.trim();
}

/** Copies a property's computed value from another style (inherit/initial/unset). */
function copyProperty(style, name, source) {
  const text = cssValue(source, name);
  if (typeof text === "string" && !CSS_WIDE_KEYWORDS.has(text)) {
    setProperty(style, name, text);
    return;
  }
  const side = /^(margin|padding)-(top|right|bottom|left)$/.exec(name);
  if (side) {
    const index = BOX_SIDES.indexOf(side[2]);
    style[side[1]] = style[side[1]].with(index, source[side[1]][index]);
    return;
  }
  // border, border-<side>, border-<width|style|color>, border-<side>-<...>;
  // not border-radius, border-spacing or border-collapse.
  const isBorder = /^border(?:-(?:top|right|bottom|left))?(?:-(?:width|style|color))?$/.test(name);
  const fields = isBorder
    ? BORDER_FIELDS
    : PROPERTY_FIELDS[name] ?? [name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
  for (const field of fields) {
    if (Object.hasOwn(INITIAL, field)) style[field] = source[field];
  }
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
    "pointer-events": style.pointerEvents,
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
  if (/^calc\(/i.test(text)) {
    const sum = calcLength(text, emSize);
    if (!sum || !(sum.percent === 0 || allowPercentage)) return NaN;
    return sum.percent === 0 ? sum.px : Object.freeze({ unit: "math", kind: "calc", px: sum.px, percent: sum.percent });
  }
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

/**
 * calc() (CSS Values 4 §10) as { px, percent }: sums and differences of
 * lengths and percentages, multiplied or divided by numbers, with nested
 * parentheses and calc(). Percentages resolve at layout time. Returns null
 * for anything else (such as min() of a percentage inside calc()).
 */
function calcLength(text, emSize) {
  const tokens = String(text).match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:%|[a-z]+)?|[a-z-]+\(|[()*/+-]/gi);
  if (!tokens || tokens.join("").replace(/\s+/g, "") !== String(text).replace(/\s+/g, "")) return null;
  let index = 0;
  // Values are { px, percent } (a length) or { number }.
  const isNumber = (value) => value && "number" in value;
  function primary() {
    const token = tokens[index++];
    if (token === undefined) return null;
    if (token === "(" || /^calc\($/i.test(token)) {
      const value = sum();
      return tokens[index++] === ")" ? value : null;
    }
    if (/^(?:min|max|clamp)\($/i.test(token)) {
      // Pixel-only min()/max()/clamp() inside calc(): hand the call back to computedLength.
      let depth = 1;
      const start = index;
      while (index < tokens.length && depth) {
        if (tokens[index].endsWith("(")) depth++;
        else if (tokens[index] === ")") depth--;
        index++;
      }
      const value = computedLength(`${token}${tokens.slice(start, index).join(" ")}`, emSize);
      return Number.isFinite(value) ? { px: value, percent: 0 } : null;
    }
    // A leading sign on a token is only a sign when it follows an operator.
    const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|[a-z]+)?$/i.exec(token);
    if (!match) return null;
    const number = Number(match[1]);
    if (!match[2]) return { number };
    if (match[2] === "%") return { px: 0, percent: number };
    const px = computedLength(token, emSize);
    return Number.isFinite(px) ? { px, percent: 0 } : null;
  }
  function product() {
    let value = primary();
    while (value && (tokens[index] === "*" || tokens[index] === "/")) {
      const operator = tokens[index++];
      const right = primary();
      if (!right) return null;
      if (operator === "/") {
        if (!isNumber(right) || right.number === 0) return null;
        value = isNumber(value) ? { number: value.number / right.number } : { px: value.px / right.number, percent: value.percent / right.number };
      } else if (isNumber(value) && isNumber(right)) {
        value = { number: value.number * right.number };
      } else if (isNumber(value) || isNumber(right)) {
        const [length, factor] = isNumber(value) ? [right, value.number] : [value, right.number];
        value = { px: length.px * factor, percent: length.percent * factor };
      } else {
        return null;
      }
    }
    return value;
  }
  function sum() {
    let value = product();
    // "a -b" tokenizes as a signed number: treat a signed token after a value as an operator.
    while (value && index < tokens.length && tokens[index] !== ")") {
      let operator = tokens[index];
      if (operator === "+" || operator === "-") {
        index++;
      } else if (/^[+-]/.test(operator)) {
        operator = operator[0];
        tokens[index] = tokens[index].slice(1);
      } else {
        return null;
      }
      const right = product();
      if (!right || isNumber(right) !== isNumber(value)) return null;
      const sign = operator === "-" ? -1 : 1;
      value = isNumber(value)
        ? { number: value.number + sign * right.number }
        : { px: value.px + sign * right.px, percent: value.percent + sign * right.percent };
    }
    return value;
  }
  const value = sum();
  if (!value || index !== tokens.length || isNumber(value)) return null;
  return value;
}

/**
 * Default field sizes: a textarea is `cols` characters wide and at least
 * `rows` lines tall (it grows with its value instead of scrolling); a text
 * input is `size` characters wide. Author widths and heights win.
 */
function applyControlSize(element, control, values) {
  const attribute = (name, fallback) => {
    const number = Number.parseInt(element.getAttribute(name) ?? "", 10);
    return number > 0 ? number : fallback;
  };
  const character = values.fontSize * (control === "textarea" ? 0.6 : 0.55);
  const lineHeight = values.lineHeight ?? values.fontSize * 1.2;
  const extraWidth = values.padding[1] + values.padding[3] + values.borderWidths[1] + values.borderWidths[3];
  const extraHeight = values.padding[0] + values.padding[2] + values.borderWidths[0] + values.borderWidths[2];
  const borderBox = values.boxSizing === "border-box";
  if (values.width === "auto") {
    const content = attribute(control === "textarea" ? "cols" : "size", control === "textarea" ? 20 : 20) * character;
    values.width = borderBox ? content + extraWidth : content;
  }
  if (control === "textarea" && values.minHeight === "auto") {
    const content = attribute("rows", 2) * lineHeight;
    values.minHeight = borderBox ? content + extraHeight : content;
  }
}

/** text-decoration-line: "none" or a list of underline, overline, line-through (blink ignored). */
function parseDecorationLines(value) {
  const tokens = String(value).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 1 && tokens[0] === "none") return "none";
  const lines = tokens.filter((token) => token !== "blink");
  if (!tokens.length || lines.some((token) => !DECORATION_LINES.has(token)) || new Set(lines).size !== lines.length) return null;
  return lines.length ? Object.freeze(lines) : "none";
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

function resolvedColor(value, scheme) {
  const match = /^light-dark\((.*)\)$/is.exec(value.trim());
  if (match) {
    const choices = splitTopLevel(match[1], ",");
    if (choices.length !== 2) return null;
    return resolvedColor(choices[scheme === "dark" ? 1 : 0], scheme);
  }
  const color = Bun.color(value, "rgba");
  return /^rgba\(/.test(color ?? "") ? color : null;
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

function boxLengths(value, allowNegative, emSize, allowAuto, allowPercentage = false) {
  const parts = value.trim().split(/\s+/).map((part) =>
    allowAuto && part === "auto" ? "auto" : computedLength(part, emSize, allowPercentage));
  if (parts.length < 1 || parts.length > 4 || parts.some((part) =>
    part !== "auto" && !isPercentage(part) && (!Number.isFinite(part) || (!allowNegative && part < 0)))) return null;
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
