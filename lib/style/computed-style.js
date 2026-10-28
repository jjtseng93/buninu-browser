/**
 * Initial style model informed by TermDOM's UA/cascade tests and UA element
 * categories (bikeshaving/termdom, MIT, pinned in Architecture.md). The data
 * model and parser here are project-owned and intentionally cover only the
 * properties the current pixel renderer consumes.
 */
import { compileSelector, matchesCompiled } from "../happy-dom/selector-matcher.js";
import { selectorKeys } from "./selector-keys.js";


const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "DD", "DETAILS", "DIV", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HR", "HTML", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "UL",
]);
const NONE_TAGS = new Set(["HEAD", "LINK", "META", "NOFRAMES", "SCRIPT", "STYLE", "TEMPLATE", "TITLE"]);
const INHERITED = new Set([
  "color", "color-scheme", "font-family", "font-size", "font-weight", "font-style", "font-stretch", "line-height", "list-style-type", "text-align", "white-space",
  "visibility", "overflow-wrap", "word-break", "border-spacing", "border-collapse", "pointer-events", "direction",
  "fill", "stroke", "stroke-width", "fill-opacity", "stroke-opacity", "fill-rule",
]);
// Inherited properties whose computed value is copied from the parent as is.
// line-height is not: a unitless factor resolves against each element's own
// font size, so it goes through its specified form (copyProperty).
const INHERITED_FIELDS = new Map([
  ["color", "color"], ["font-family", "fontFamily"], ["font-size", "fontSize"], ["font-weight", "fontWeight"],
  ["font-style", "fontStyle"],
  ["font-stretch", "fontStretch"],
  ["list-style-type", "listStyleType"], ["text-align", "textAlign"], ["white-space", "whiteSpace"],
  ["visibility", "visibility"], ["overflow-wrap", "overflowWrap"], ["word-break", "wordBreak"],
  ["border-spacing", "borderSpacing"], ["border-collapse", "borderCollapse"], ["pointer-events", "pointerEvents"],
  ["direction", "direction"],
  ["fill", "fill"], ["stroke", "stroke"], ["stroke-width", "strokeWidth"],
  ["fill-opacity", "fillOpacity"], ["stroke-opacity", "strokeOpacity"], ["fill-rule", "fillRule"],
]);
const LIST_STYLE_TYPES = new Set([
  "none", "disc", "circle", "square", "decimal", "decimal-leading-zero",
  "lower-alpha", "upper-alpha", "lower-latin", "upper-latin", "lower-roman", "upper-roman",
  "disclosure-open", "disclosure-closed",
]);
const DISPLAYS = new Set([
  "-webkit-box", "-webkit-inline-box",
  "none", "contents", "block", "flex", "grid", "inline", "inline-block", "inline-flex", "inline-grid", "list-item",
  "table", "inline-table", "table-row-group", "table-header-group", "table-footer-group", "table-row",
  "table-cell", "table-caption", "table-column", "table-column-group",
]);
/** CSS Fonts 4 §2.5 absolute-size keywords (medium = 16px). */
const FONT_SIZE_KEYWORDS = Object.freeze({
  "xx-small": 9, "x-small": 10, small: 13, medium: 16, large: 18, "x-large": 24, "xx-large": 32, "xxx-large": 48,
});
const FONT_STRETCH_KEYWORDS = Object.freeze({ "ultra-condensed": 50, "extra-condensed": 62.5, condensed: 75,
  "semi-condensed": 87.5, normal: 100, "semi-expanded": 112.5, expanded: 125, "extra-expanded": 150, "ultra-expanded": 200 });
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
// A background layer's image: a URL or a gradient.
const BACKGROUND_IMAGE = /^(?:url\(|(?:repeating-)?(?:linear|radial)-gradient\()/i;
const BACKGROUND_REPEATS = new Set(["repeat", "repeat-x", "repeat-y", "no-repeat", "space", "round"]);
const BACKGROUND_BOXES = new Set(["border-box", "padding-box", "content-box"]);
const BACKGROUND_ATTACHMENTS = new Set(["scroll", "fixed", "local"]);
const BOX_SIDES = Object.freeze(["top", "right", "bottom", "left"]);
const CORNER_FIELDS = Object.freeze(["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"]);
const ZERO_RADIUS = Object.freeze([0, 0]);
const WHITE_SPACES = new Set(["normal", "nowrap", "pre", "pre-wrap"]);
// CSS Cascade 4 §7.3 CSS-wide keywords; revert is treated as unset (no user/UA origin split).
const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
// Computed-style fields a shorthand (or a property not named after its field) covers.
const PROPERTY_FIELDS = Object.freeze({
  "-webkit-line-clamp": ["webkitLineClamp"],
  "-webkit-box-orient": ["webkitBoxOrient"],
  overflow: ["overflowX", "overflowY", "overflowScrollX", "overflowScrollY"],
  "overflow-x": ["overflowX", "overflowScrollX"],
  "overflow-y": ["overflowY", "overflowScrollY"],
  background: ["backgroundColor", "backgroundImage", "backgroundPosition", "backgroundSize", "backgroundRepeat"],
  font: ["fontSize", "fontFamily", "fontWeight", "fontStyle", "fontStretch", "lineHeight", "lineHeightFactor"],
  "font-width": ["fontStretch"],
  "font-parts": ["lineHeight", "lineHeightFactor"],
  flex: ["flexGrow", "flexShrink", "flexBasis"],
  "flex-flow": ["flexDirection", "flexWrap"],
  gap: ["rowGap", "columnGap", "gap", "rowGapNormal", "columnGapNormal"],
  "grid-gap": ["rowGap", "columnGap", "gap", "rowGapNormal", "columnGapNormal"],
  "row-gap": ["rowGap", "rowGapNormal"],
  "column-gap": ["columnGap", "columnGapNormal"],
  "grid-row-gap": ["rowGap", "rowGapNormal"],
  "grid-column-gap": ["columnGap", "columnGapNormal"],
  "grid-area": ["gridRowStart", "gridColumnStart", "gridRowEnd", "gridColumnEnd"],
  "grid-row": ["gridRowStart", "gridRowEnd"],
  "grid-column": ["gridColumnStart", "gridColumnEnd"],
  "grid-template": ["gridTemplateColumns", "gridTemplateRows", "gridTemplateAreas"],
  "place-content": ["alignContent", "justifyContent"],
  "place-items": ["alignItems", "justifyItems"],
  "place-self": ["alignSelf", "justifySelf"],
  "line-height": ["lineHeight", "lineHeightFactor"],
  "list-style": ["listStyleType"],
  "border-radius": ["borderRadius", ...CORNER_FIELDS],
  "text-decoration": ["textDecorationLine", "textDecorationColor"],
  "text-decoration-line": ["textDecorationLine"],
  "text-decoration-color": ["textDecorationColor"],
  top: ["inset"], right: ["inset"], bottom: ["inset"], left: ["inset"],
});
const BORDER_FIELDS = Object.freeze(["borderSpecifiedWidths", "borderStyles", "borderColors", "borderWidths"]);
// Inputs read from a parent even without an explicit `inherit` declaration.
// Display affects flex/grid item floats; text decorations propagate separately
// from the ordinary inherited properties. Root font changes also affect rem.
const CHILD_STYLE_INPUTS = [...new Set([
  ...[...INHERITED].flatMap(name => PROPERTY_FIELDS[name]
    ?? [INHERITED_FIELDS.get(name) ?? name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]),
  "display", "textDecorations",
])];

const INITIAL = Object.freeze({
  display: "inline",
  direction: "ltr",
  // text-decoration: this element's own lines ("none" or an array) and color
  // (null = currentColor); textDecorations adds what ancestors propagate.
  textDecorationLine: "none",
  textDecorationColor: null,
  textDecorations: null,
  color: "rgba(0, 0, 0, 1)",
  fill: "rgba(0, 0, 0, 1)",
  stroke: "none",
  strokeWidth: 1,
  fillOpacity: 1,
  strokeOpacity: 1,
  fillRule: "nonzero",
  colorScheme: "light",
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: null,
  // Comma-separated, one entry per background-image layer (repeated as needed); null is the initial value.
  backgroundPosition: null,
  backgroundSize: null,
  backgroundRepeat: null,
  backgroundClip: "border-box",
  boxShadow: null,
  fontFamily: Object.freeze(["sans-serif"]),
  fontSize: 16,
  fontWeight: 400,
  fontStyle: "normal",
  fontStretch: 100,
  // null means `line-height: normal`, which layout resolves from font metrics.
  lineHeight: null,
  lineHeightFactor: null,
  textAlign: "start",
  whiteSpace: "normal",
  webkitLineClamp: null,
  webkitBoxOrient: "horizontal",
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
  borderTopLeftRadius: ZERO_RADIUS,
  borderTopRightRadius: ZERO_RADIUS,
  borderBottomRightRadius: ZERO_RADIUS,
  borderBottomLeftRadius: ZERO_RADIUS,
  flexDirection: "row",
  flexWrap: "nowrap",
  justifyContent: "normal",
  alignContent: "normal",
  alignItems: "normal",
  alignSelf: "auto",
  gap: 0,
  rowGap: 0,
  columnGap: 0,
  // Layout uses zero for normal in flex/grid, but CSSOM must distinguish it
  // from an explicitly specified zero length.
  rowGapNormal: true,
  columnGapNormal: true,
  flexGrow: 0,
  flexShrink: 1,
  flexBasis: "auto",
  content: null,
  position: "static",
  // top/right/bottom/left: "auto", px, or a percentage of the containing block.
  inset: Object.freeze(["auto", "auto", "auto", "auto"]),
  zIndex: "auto",
  transform: null,
  translate: null,
  // Raw text (default "50% 50%"); paint resolves it against the border box.
  transformOrigin: null,
  justifyItems: "normal",
  justifySelf: "auto",
  gridTemplateColumns: null,
  gridTemplateRows: null,
  gridTemplateAreas: null,
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
  userSelect: "auto",
  // Breaking inside words (CSS Text 3 §5): only with these set.
  overflowWrap: "normal",
  wordBreak: "normal",
  opacity: 1,
  overflowX: "visible",
  overflowY: "visible",
  // Scroll containers (CSS Overflow 3 §3): "auto" for auto/scroll/overlay,
  // which the user scrolls; "hidden", which only scripts scroll; else null.
  overflowScrollX: null,
  overflowScrollY: null,
  textOverflow: "clip",
  clip: null,
  clipPath: null,
});

// `all` resets every supported CSS property except direction (and custom
// properties). Derived rendering fields are recomputed from their owners.
const RESET_EXCLUDED_FIELDS = new Set([
  "direction", "textDecorations", "lineHeightFactor", "borderWidths", "borderSpecifiedWidths",
  "borderStyles", "borderColors", "inset", "overflowScrollX", "overflowScrollY",
  "rowGapNormal", "columnGapNormal",
]);
const ALL_PROPERTIES = Object.freeze(Object.keys(INITIAL)
  .filter((field) => !RESET_EXCLUDED_FIELDS.has(field))
  .map((field) => field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`))
  .concat(["border-width", "border-style", "border-color", "top", "right", "bottom", "left"]));

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
  IFRAME: "border: 2px inset",
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
const FIELD = `${CONTROL_FONT}; color: black; border: 1px solid #767676; background-color: white`;
const BUTTON_LIKE = `${CONTROL_FONT}; color: black; border: 1px solid #767676; border-radius: 2px; padding: 1px 6px; background-color: #efefef; text-align: center`;
const UA_CONTROL_DECLARATIONS = Object.freeze({
  textarea: parseDeclarations(`${FIELD}; font-family: monospace; padding: 2px; white-space: pre-wrap; overflow-wrap: break-word; overflow: auto`),
  text: parseDeclarations(`${FIELD}; padding: 1px 2px; white-space: pre; overflow: hidden`),
  checkbox: parseDeclarations("width: 13px; height: 13px; margin: 3px 3px 3px 4px; border: 1px solid #767676; border-radius: 2px; background-color: white; box-sizing: border-box"),
  radio: parseDeclarations("width: 13px; height: 13px; margin: 3px 3px 0 5px; border: 1px solid #767676; border-radius: 50%; background-color: white; box-sizing: border-box"),
  button: parseDeclarations(`${BUTTON_LIKE}; white-space: pre`),
  select: parseDeclarations(`${FIELD}; border-radius: 2px; padding: 0 4px; white-space: pre`),
});
const BUTTON_INPUTS = new Set(["button", "submit", "reset", "image", "file", "color"]);
const SVG_PRESENTATION_PROPERTIES = ["fill", "stroke", "stroke-width", "fill-opacity", "stroke-opacity", "fill-rule", "color", "opacity", "display", "visibility"];

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
// <iframe frameborder="0"> (or "no"): no border in place of the default one.
const UA_FRAMELESS_DECLARATIONS = parseDeclarations("border: none");
const UA_LINK_DECLARATIONS = parseDeclarations("color: #0000EE; text-decoration: underline; cursor: pointer");
const DECORATION_LINES = new Set(["underline", "overline", "line-through"]);
const DECORATION_STYLES = new Set(["solid", "double", "dotted", "dashed", "wavy"]);

const DEFAULT_ENVIRONMENT = Object.freeze({ viewportWidth: 800, viewportHeight: 600, rootFontSize: 16 });
let environment = DEFAULT_ENVIRONMENT;

export class StyleEngine {
  #measureText;
  #usesFontMetrics = false;
  #styles = new WeakMap();
  #customProperties = new WeakMap();
  #pseudoStyles = new WeakMap();
  #parentDependencies = new WeakMap();
  #document = null;
  #sheetChanges = null;
  /** Elements computed by the last compute(), and whether it was incremental. */
  restyled = 0;
  incremental = false;
  // Parsed and indexed rules for the last style sheet list and viewport:
  // restyles after script changes reuse them instead of re-parsing.
  #ruleCache = { styleSheets: null, key: "", index: null };
  // Parsed rules by sheet text, for the viewport in #parsedSheetsKey.
  #parsedSheets = new Map();
  #parsedSheetsKey = "";

  constructor({ measureText = null } = {}) {
    this.#measureText = measureText && ((text, style) => {
      this.#usesFontMetrics = true;
      return measureText(text, style);
    });
  }

  // Font-relative computed lengths (currently ch) depend on loaded typefaces.
  // Keep this conservative across incremental passes, including var()/pseudo
  // values and a root font-size which can change descendants' rem lengths.
  get usesFontMetrics() { return this.#usesFontMetrics; }

  /**
   * Computes the document's styles. With `dirty` (elements whose subtree's
   * styles may have changed), only those subtrees are restyled and every
   * other element keeps the style it had: unchanged rules and viewport, the
   * same document, and a styled root are required, else it restyles fully.
   * `restyled` afterwards counts the elements this call computed.
   */
  compute(document, styleSheets = [], viewport = {}, dirty = null, selfOnly = null) {
    if (this.#document !== document) this.#usesFontMetrics = false;
    const previous = environment;
    environment = {
      viewportWidth: viewport.width ?? DEFAULT_ENVIRONMENT.viewportWidth,
      viewportHeight: viewport.height ?? DEFAULT_ENVIRONMENT.viewportHeight,
      rootFontSize: DEFAULT_ENVIRONMENT.rootFontSize,
      mobile: viewport.mobile === true,
      measureText: this.#measureText,
    };
    this.restyled = 0;
    try {
      const before = this.#ruleCache.index;
      const rules = this.#rulesFor(styleSheets);
      const root = document.documentElement;
      if (dirty !== null && rules !== before) {
        const affected = this.#elementsForSheetChanges(document);
        dirty = affected ? new Set([...dirty, ...affected]) : null;
      }
      const incremental = dirty !== null && this.#document === document
        && Boolean(root) && this.#styles.has(root) && !dirty.has(root);
      this.incremental = incremental;
      if (!incremental) {
        // Recompute every element into fresh maps so detached nodes lose their
        // styles. On the same document, the prior pass can supply equal immutable
        // identities for render/layout reuse. Keep this fallback local to the
        // traversal, including when a callback starts another compute().
        const previousMaps = this.#document === document ? {
          styles: this.#styles, customProperties: this.#customProperties, pseudoStyles: this.#pseudoStyles,
        } : null;
        this.#styles = new WeakMap();
        this.#customProperties = new WeakMap();
        this.#pseudoStyles = new WeakMap();
        this.#parentDependencies = new WeakMap();
        this.#document = document;
        if (root) this.#visit(root, null, null, rules, undefined, previousMaps);
        return this;
      }
      // rem units resolve against the root's font size, which is unchanged.
      environment = { ...environment, rootFontSize: this.#styles.get(root).fontSize };
      // Restyle from the nearest ancestor that has a style (new subtrees have
      // none); many roots inside one new subtree share that start.
      const starts = new Set();
      for (const element of topmostConnected(dirty, root)) {
        let start = element;
        while (start !== root && !this.#styles.has(start.parentElement)) start = start.parentElement;
        starts.add(start);
      }
      if (starts.has(root)) {
        this.#visit(root, null, null, rules);
        return this;
      }
      if (selfOnly?.has(root)) {
        // A root-only selector/attribute change may leave its computed values
        // unchanged. Check it like other self-only elements before cascading
        // through the document; other dirty subtrees still need their pass.
        // The root's own font-size rem units use the initial font size, not
        // the previous generation's root size. #styleOne then sets the basis
        // used by descendants, including a necessary full subtree restyle.
        environment = { ...environment, rootFontSize: DEFAULT_ENVIRONMENT.rootFontSize };
        if (this.#restyleSelf(root, rules)) return this;
      }
      const topmost = topmostConnected(starts, root);
      for (const start of topmost) {
        const parent = start.parentElement;
        const ancestors = this.#ancestorsOf(start);
        this.#visit(start, this.#styles.get(parent), this.#customProperties.get(parent) ?? EMPTY_MAP, rules, ancestors);
      }
      // Elements whose own matches may have changed (:empty, :first-child,
      // ...) and that no restyled subtree covered.
      const covered = new Set(topmost);
      for (const element of selfOnly ?? []) {
        if (!element || element.nodeType !== 1 || !root.contains(element) || !this.#styles.has(element.parentElement)) continue;
        let inside = false;
        for (let node = element; node && !inside; node = node.parentElement) inside = covered.has(node);
        if (!inside) this.#restyleSelf(element, rules);
      }
    } finally {
      environment = previous;
    }
    return this;
  }

  #rulesFor(styleSheets) {
    const key = `${environment.viewportWidth}x${environment.viewportHeight}${environment.mobile ? ":mobile" : ""}`;
    const cache = this.#ruleCache;
    this.#sheetChanges = null;
    if (cache.styleSheets !== styleSheets || cache.key !== key || cache.length !== styleSheets.length) {
      const perSheet = this.#parseSheets(styleSheets, key);
      const rules = perSheet.flat();
      // Sheets added or removed since the last list (same viewport): only the
      // elements their rules match can change style, every other element
      // keeps the same rules in the same relative order.
      if (cache.index && cache.key === key) this.#sheetChanges = diffSheets(cache, styleSheets, perSheet);
      this.#ruleCache = { styleSheets, key, length: styleSheets.length, index: new RuleIndex(rules), perSheet };
    }
    return this.#ruleCache.index;
  }

  /**
   * Each sheet's rules, in cascade order. A sheet is parsed once per text
   * (and viewport) with layers of its own; putting a list together only
   * renumbers the rules and merges the sheets' layer trees in order, so a
   * script adding one <style> does not re-parse every other sheet. Of
   * identical sheets only the last copy's rules are kept, as each beats the
   * same rule of an earlier copy (the earlier copy still declares its layers
   * first); a sheet with anonymous layers is kept in every copy, since under
   * !important an earlier anonymous layer wins.
   */
  #parseSheets(styleSheets, key) {
    if (this.#parsedSheetsKey !== key) {
      this.#parsedSheets = new Map();
      this.#parsedSheetsKey = key;
    }
    const parsed = this.#parsedSheets;
    const entries = styleSheets.map((source) => {
      let entry = parsed.get(source);
      if (entry) parsed.delete(source);
      else {
        const counter = { order: 0 };
        const rules = parseStyleSheet(source, environment, counter);
        entry = { rules, layers: counter.layers.children.size ? counter.layers : null };
        entry.anonymousLayers = entry.layers !== null && hasAnonymousLayer(entry.layers);
      }
      parsed.set(source, entry); // most recently used last
      return entry;
    });
    for (const source of parsed.keys()) {
      if (parsed.size <= MAX_PARSED_SHEETS + styleSheets.length) break;
      parsed.delete(source);
    }
    const last = new Map();
    entries.forEach((entry, index) => last.set(entry, index));
    const root = newLayer(null);
    const layerOf = new Map();
    let order = 0;
    const perSheet = entries.map((entry, index) => {
      if (entry.layers) mergeLayers(entry.layers, root, layerOf);
      const lastCopy = last.get(entry) === index;
      if (!lastCopy && !entry.anonymousLayers) return [];
      // Each kept copy but the last gets rule objects of its own.
      const rules = lastCopy ? entry.rules : entry.rules.map((rule) => rule.copy());
      for (const rule of rules) {
        rule.order = order++;
        rule.layer = rule.layerNode ? layerOf.get(rule.layerNode) : Infinity;
      }
      return rules;
    });
    if (root.children.size) {
      rankLayerTree(root);
      for (const rules of perSheet) for (const rule of rules) if (rule.layerNode) rule.layer = rule.layer.rank;
    }
    return perSheet;
  }

  /** Elements matched by the rules of added or removed sheets, or null when that is unknown. */
  #elementsForSheetChanges(document) {
    const changes = this.#sheetChanges;
    // Each selector is a document-wide search: past a few hundred, a full
    // restyle is cheaper (a large stylesheet arriving late, for example).
    if (!changes || changes.rules.length > MAX_SHEET_CHANGE_RULES) return null;
    const elements = new Set();
    const selectors = new Set(changes.rules.map((rule) => rule.selector));
    for (const selector of selectors) {
      let matched;
      try { matched = document.querySelectorAll(selector); } catch { continue; } // invalid: matches nothing
      for (const element of matched) elements.add(element);
    }
    return elements;
  }

  get(element) {
    return this.#styles.get(element) ?? INITIAL;
  }

  /** An element's custom properties (--*), name to value text, inherited ones included. */
  customPropertiesOf(element) {
    return this.#customProperties.get(element) ?? EMPTY_MAP;
  }

  /** The computed style of an element's ::before/::after box, or null when it generates none. */
  getPseudo(element, pseudo) {
    return this.#pseudoStyles.get(element)?.[pseudo] ?? null;
  }

  /** Computes and stores one element's style and ::before/::after styles. */
  #styleOne(element, parentStyle, parentCustomProperties, rules, keys, ancestors, previousMaps = null) {
    const previousStyle = this.#styles.get(element) ?? previousMaps?.styles.get(element);
    const previousCustom = this.#customProperties.get(element) ?? previousMaps?.customProperties.get(element);
    const previousPseudo = this.#pseudoStyles.get(element) ?? previousMaps?.pseudoStyles.get(element);
    // Inline style takes part in the cascade before custom properties are
    // resolved: style="--x: ..." must win over stylesheet values of --x.
    const declarations = withInlineStyle(element, cascadeDeclarations(element, rules, null, keys, ancestors));
    let customProperties = withCustomProperties(parentCustomProperties ?? EMPTY_MAP, declarations);
    const dependencies = { inheritsParent: false };
    let style = computeElementStyle(element, parentStyle, declarations, customProperties, dependencies);
    // A descendant may be visited because an ancestor's selector state
    // changed even though its final computed values did not. Preserve the
    // immutable identities so retained render and layout subtrees survive.
    if (sameValue(previousStyle, style)) style = previousStyle;
    if (sameCustom(previousCustom, customProperties)) customProperties = previousCustom;
    // rem units resolve against the root element's computed font size.
    if (!parentStyle) environment = { ...environment, rootFontSize: style.fontSize };
    this.#styles.set(element, style);
    this.#customProperties.set(element, customProperties);
    let pseudoStyles = {};
    for (const pseudo of ["before", "after"]) {
      const pseudoDeclarations = cascadeDeclarations(element, rules, pseudo, keys, ancestors);
      if (!pseudoDeclarations.has("content")) continue;
      const pseudoCustom = withCustomProperties(customProperties, pseudoDeclarations);
      const pseudoStyle = computeElementStyle(pseudoElement(pseudo), style, pseudoDeclarations, pseudoCustom, dependencies);
      // `content: none | normal` generates no box (CSS Pseudo 4 §2.3).
      if (pseudoStyle.content != null && pseudoStyle.display !== "none") pseudoStyles[pseudo] = pseudoStyle;
    }
    if (sameValue(previousPseudo ?? null, (pseudoStyles.before || pseudoStyles.after) ? pseudoStyles : null)) {
      pseudoStyles = previousPseudo ?? {};
    }
    if (pseudoStyles.before || pseudoStyles.after) this.#pseudoStyles.set(element, pseudoStyles);
    else this.#pseudoStyles.delete(element);
    // Dependencies can change without changing computed values, for example
    // width:100px -> width:inherit while the parent is already 100px wide.
    this.#parentDependencies.set(element, dependencies.inheritsParent);
    this.restyled++;
    return { style, customProperties };
  }

  #visit(element, parentStyle, parentCustomProperties, rules, ancestors = new AncestorFilter(), previousMaps = null) {
    const keys = elementKeys(element);
    const { style, customProperties } = this.#styleOne(element, parentStyle, parentCustomProperties, rules, keys, ancestors, previousMaps);
    this.#visitChildren(element, keys, style, customProperties, rules, ancestors, previousMaps);
  }

  #visitChildren(element, keys, style, customProperties, rules, ancestors, previousMaps = null) {
    // The element is an ancestor of everything below it.
    const own = ancestors.push(keys);
    for (const child of element.children) this.#visit(child, style, customProperties, rules, ancestors, previousMaps);
    ancestors.pop(own);
  }

  /** Ancestor filter counts for the elements above `element`. */
  #ancestorsOf(element) {
    const ancestors = new AncestorFilter();
    for (let node = element.parentElement; node; node = node.parentElement) ancestors.push(elementKeys(node));
    return ancestors;
  }

  /**
   * Restyles one element and propagates changed parent inputs. Returns true
   * only when every descendant was visited, so a root-only update cannot
   * swallow independently dirty subtrees after a partial propagation.
   */
  #restyleSelf(element, rules, ancestors = this.#ancestorsOf(element)) {
    const parent = element.parentElement;
    const before = { style: this.#styles.get(element), pseudo: this.#pseudoStyles.get(element), custom: this.#customProperties.get(element) };
    const keys = elementKeys(element);
    const { style, customProperties } = this.#styleOne(element, this.#styles.get(parent), this.#customProperties.get(parent) ?? EMPTY_MAP, rules, keys, ancestors);
    const pseudo = this.#pseudoStyles.get(element);
    if (sameValue(before.style, style) && sameValue(before.pseudo ?? null, pseudo ?? null) && sameCustom(before.custom, customProperties)) {
      // Unchanged: keep the previous objects so later comparisons stay cheap.
      this.#styles.set(element, before.style);
      return false;
    }
    if (!sameChildStyleInputs(before.style, style) || !sameCustom(before.custom, customProperties)) {
      this.#visitChildren(element, keys, style, customProperties, rules, ancestors);
      return true;
    }
    // The parent's ordinary inherited inputs did not change. Only immediate
    // children with explicit inheritance can observe its other properties;
    // an unchanged child also shields its descendants from those changes.
    const own = ancestors.push(keys);
    try {
      for (const child of element.children) {
        if (!this.#styles.has(child) || !this.#parentDependencies.has(child)) {
          this.#visit(child, style, customProperties, rules, ancestors);
        } else if (before.style !== style && this.#parentDependencies.get(child)) {
          this.#restyleSelf(child, rules, ancestors);
        }
      }
    } finally { ancestors.pop(own); }
    return false;
  }
}

function sameChildStyleInputs(before, after) {
  return Boolean(before && after) && CHILD_STYLE_INPUTS.every(field => sameValue(before[field], after[field]));
}

/** Structural equality of computed style values (frozen objects and arrays). */
function sameValue(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => sameValue(left[key], right[key]));
}

function sameCustom(left, right) {
  if (left === right) return true;
  if (!left || !right || left.size !== right.size) return false;
  for (const [name, value] of left) if (right.get(name) !== value) return false;
  return true;
}

const EMPTY_MAP = new Map();
const MAX_SHEET_CHANGE_RULES = 300;
// Parsed sheets kept for reuse beyond those in use (sheets that come and go).
const MAX_PARSED_SHEETS = 64;

/**
 * Rules from sheets present in only one of two sheet lists (by text), or null
 * when such a change can reorder other rules: @layer declarations rank
 * layers by first appearance and @property changes inheritance.
 */
function diffSheets(previous, styleSheets, perSheet) {
  const remaining = new Map();
  previous.styleSheets.forEach((source, index) => {
    const list = remaining.get(source);
    if (list) list.push(previous.perSheet[index]); else remaining.set(source, [previous.perSheet[index]]);
  });
  const rules = [];
  const risky = (source) => /@layer\b|@property\b/i.test(source);
  for (let index = 0; index < styleSheets.length; index++) {
    const source = styleSheets[index];
    const list = remaining.get(source);
    if (list?.length) { list.pop(); continue; }
    if (risky(source)) return null;
    rules.push(...perSheet[index]);
  }
  for (const [source, lists] of remaining) {
    if (!lists.length) continue;
    if (risky(source)) return null;
    for (const list of lists) rules.push(...list);
  }
  return { rules };
}

/** The connected elements of `elements` that are not inside another of them. */
export function topmostConnected(elements, root) {
  const result = [];
  for (const element of elements) {
    if (!element || element.nodeType !== 1 || !root.contains(element)) continue;
    let covered = false;
    for (let node = element.parentElement; node && !covered; node = node.parentElement) covered = elements.has(node);
    if (!covered) result.push(element);
  }
  return result;
}

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

export function computeElementStyle(element, parentStyle = null, authorDeclarations = null, customProperties = new Map(), dependencies = null) {
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
  if (["I", "EM", "CITE", "DFN", "VAR", "ADDRESS"].includes(element.tagName)) values.fontStyle = "italic";
  if (element.tagName === "PRE") values.whiteSpace = "pre";
  if (element.tagName === "SUMMARY") {
    const details = element.parentElement;
    const principal = details?.tagName === "DETAILS"
      && [...details.children].find((child) => child.tagName === "SUMMARY") === element;
    values.display = principal ? "list-item" : "block";
    if (principal) values.listStyleType = details.hasAttribute("open") ? "disclosure-open" : "disclosure-closed";
  }
  const direction = element.getAttribute("dir")?.toLowerCase();
  if (direction === "ltr" || direction === "rtl") values.direction = direction;

  const declarations = new Map(authorDeclarations ?? []);
  // HTML dimension attributes are presentational hints, below author CSS.
  // Percentages are supported by the legacy dimension parsing rules, even
  // though the modern authoring syntax normally uses non-negative integers.
  if (["IMG", "VIDEO", "IFRAME"].includes(element.tagName)) {
    for (const name of ["width", "height"]) {
      const match = /^[\t\n\f\r ]*(\d+(?:\.\d+)?)(%?)/.exec(element.getAttribute(name) ?? "");
      if (match && !declarations.has(name)) declarations.set(name, {
        name, value: `${match[1]}${match[2] || "px"}`, specificity: 0, order: -1, layer: -Infinity,
      });
    }
  }
  // SVG presentation attributes precede stylesheet rules at author origin.
  if (element.namespaceURI === "http://www.w3.org/2000/svg") {
    for (const name of SVG_PRESENTATION_PROPERTIES) {
      const value = element.getAttribute(name);
      if (value != null && !declarations.has(name)) declarations.set(name, { name, value, specificity: 0, order: -1, layer: -Infinity });
    }
  }
  const isLink = (element.tagName === "A" || element.tagName === "AREA") && element.hasAttribute("href");
  const control = controlKind(element);
  if (control === "hidden") values.display = "none";
  const frameless = element.tagName === "IFRAME" && ["0", "no"].includes(element.getAttribute("frameborder")?.trim().toLowerCase());
  const uaDeclarations = frameless ? UA_FRAMELESS_DECLARATIONS : UA_DECLARATIONS.get(element.tagName);
  for (const declaration of [...(uaDeclarations?.values() ?? []),
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
  const reset = declarations.get("all");
  const resetValue = reset && resolveVariables(reset.value, customProperties);
  if (reset && CSS_WIDE_KEYWORDS.has(resetValue)) {
    if (dependencies && resetValue === "inherit") dependencies.inheritsParent = true;
    // Expand before resolving font prerequisites. Competing declarations
    // keep their normal importance, specificity and source-order priority.
    for (const name of ALL_PROPERTIES) {
      const current = declarations.get(name);
      if (!current || compareDeclarations(reset, current) >= 0) declarations.set(name, { ...reset, name });
    }
  }
  // The font size comes first (em lengths use it), from whichever of
  // font-size and the font shorthand wins the cascade.
  const fontSize = declarations.get("font-size");
  const font = declarations.get("font");
  if (font && (!fontSize || compareDeclarations(font, fontSize) > 0)) {
    const fontValue = resolveVariables(font.value, customProperties);
    if (dependencies && fontValue === "inherit") dependencies.inheritsParent = true;
    const parsed = parseFontShorthand(fontValue);
    if (CSS_WIDE_KEYWORDS.has(fontValue)) setProperty(values, "font-size", fontValue, parentStyle);
    else if (parsed) setProperty(values, "font-size", parsed.size, parentStyle);
  } else if (fontSize) {
    applyDeclaration(values, fontSize, customProperties, parentStyle, dependencies);
  }
  // light-dark() depends on the used scheme regardless of declaration order.
  const colorScheme = declarations.get("color-scheme");
  if (colorScheme) applyDeclaration(values, colorScheme, customProperties, parentStyle, dependencies);
  const directionDeclaration = declarations.get("direction");
  if (directionDeclaration) applyDeclaration(values, directionDeclaration, customProperties, parentStyle, dependencies);
  // Apply in cascade order so a later shorthand overrides earlier longhands and vice versa.
  const ordered = [...declarations.values()].sort(compareDeclarations);
  // Font-relative lengths such as ch use this element's final font, even
  // when width/padding appear before font-family or the font shorthand.
  for (const declaration of ordered) {
    if (declaration.name === "font") {
      const fontValue = resolveVariables(declaration.value, customProperties);
      if (dependencies && fontValue === "inherit") dependencies.inheritsParent = true;
      const parsed = parseFontShorthand(fontValue);
      if (CSS_WIDE_KEYWORDS.has(fontValue)) {
        setProperty(values, "font-family", fontValue, parentStyle);
        setProperty(values, "font-weight", fontValue, parentStyle);
        setProperty(values, "font-style", fontValue, parentStyle);
        setProperty(values, "font-stretch", fontValue, parentStyle);
      }
      if (parsed) {
        setProperty(values, "font-family", parsed.family, parentStyle);
        setProperty(values, "font-weight", parsed.weight ?? "normal", parentStyle);
        setProperty(values, "font-style", parsed.style ?? "normal", parentStyle);
        setProperty(values, "font-stretch", parsed.stretch ?? "normal", parentStyle);
      }
    } else if (["font-family", "font-weight", "font-style", "font-stretch", "font-width"].includes(declaration.name)) {
      applyDeclaration(values, declaration, customProperties, parentStyle, dependencies);
    }
  }
  for (const declaration of ordered) {
    if (declaration.name.startsWith("--") || ["font-size", "font-family", "font-weight", "font-style", "font-stretch", "font-width", "color-scheme", "direction"].includes(declaration.name)) continue;
    // The shorthand's size was settled above; its other parts apply in order.
    applyDeclaration(values, declaration.name === "font" ? { ...declaration, name: "font-parts" } : declaration, customProperties, parentStyle, dependencies);
  }
  // Floats (approximation): laid out as atomic inlines in the line, left floats
  // in order and right floats at the line's end. Absolutely positioned boxes
  // and flex/grid items do not float (CSS 2 §9.7, Flexbox §4, Grid §6).
  const parentDisplay = parentStyle?.display ?? "block";
  const flexOrGridItem = ["flex", "inline-flex", "grid", "inline-grid"].includes(parentDisplay);
  if (values.float !== "none" && (["absolute", "fixed"].includes(values.position) || flexOrGridItem)) values.float = "none";
  if (values.float !== "none" && !["none", "contents"].includes(values.display)) {
    values.display = { flex: "inline-flex", grid: "inline-grid", "inline-flex": "inline-flex", "inline-grid": "inline-grid" }[values.display]
      ?? "inline-block";
  }
  // A border side is only drawn with a visible style; currentColor follows `color`.
  values.borderWidths = Object.freeze(values.borderSpecifiedWidths.map((width, index) =>
    ["none", "hidden"].includes(values.borderStyles[index]) ? 0 : width));
  values.borderColors = Object.freeze(values.borderColors.map((color) => color ?? values.color));
  // Initial/inherited arrays are already immutable. Setters use copy-on-write;
  // retain those arrays, but still isolate any mutable caller-owned values.
  values.borderStyles = Object.isFrozen(values.borderStyles) ? values.borderStyles : Object.freeze([...values.borderStyles]);
  values.borderSpecifiedWidths = Object.isFrozen(values.borderSpecifiedWidths) ? values.borderSpecifiedWidths : Object.freeze([...values.borderSpecifiedWidths]);
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
  values.inset = Object.isFrozen(values.inset) ? values.inset : Object.freeze([...values.inset]);
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

  /** The same rule as a separate object (its own order and layer). */
  copy() {
    const rule = new StyleRule(this.selector, this.#selectorText, this.pseudo, this.#block, this.order);
    rule.layerNode = this.layerNode;
    return rule;
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
          const inner = condition ? declareLayer(parent, condition) : declareLayer(parent, `${ANONYMOUS_LAYER}${counter.order}`);
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

/** Font resource descriptors, separate from selector rules (CSS Fonts §4). */
export function extractFontFaces(source, baseURL, viewport = environment) {
  const css = String(source).replace(/\/\*[\s\S]*?\*\//g, "");
  const faces = [];
  function visit(start, end) {
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
      const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase();
      if (name === "font-face") {
        const descriptors = parseDeclarations(css.slice(open + 1, close));
        const value = (name) => descriptors.get(name)?.important ? undefined : descriptors.get(name)?.value;
        const family = fontFaceFamily(value("font-family"));
        const sources = fontFaceSources(value("src"), baseURL);
        if (family && sources.length) {
          const weights = (value("font-weight") ?? "normal").split(/\s+/).map((part) =>
            part === "normal" ? 400 : part === "bold" ? 700 : Number(part));
          const weight = weights.length <= 2 && weights.every((part) => part >= 1 && part <= 1000)
            ? [Math.min(...weights), Math.max(...weights)] : [400, 400];
          const style = /^(normal|italic|oblique)(?:\s|$)/.exec(value("font-style") ?? "normal")?.[1] ?? "normal";
          const stretches = (value("font-width") ?? value("font-stretch") ?? "normal").split(/\s+/).map(fontStretch);
          const stretch = stretches.length <= 2 && stretches.every(Number.isFinite)
            ? [Math.min(...stretches), Math.max(...stretches)] : [100, 100];
          const display = value("font-display");
          faces.push({ family, sources, weight, style, stretch,
            unicodeRanges: fontFaceUnicodeRanges(value("unicode-range")),
            display: ["auto", "block", "swap", "fallback", "optional"].includes(display) ? display : "auto" });
        }
      } else if (name === "layer" || name === "supports"
        || name === "media" && mediaQueryMatches(prelude.slice(6).trim(), viewport)) {
        visit(open + 1, close);
      }
      index = close + 1;
    }
  }
  visit(0, css.length);
  return faces;
}

function decodeCssString(value) {
  const text = String(value ?? "").trim();
  const quoted = /^(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)')$/.exec(text);
  return (quoted ? quoted[1] ?? quoted[2] : text).replace(/\\(?:([\da-f]{1,6})\s?|([\s\S]))/gi,
    (_, hex, literal) => hex ? String.fromCodePoint(Math.min(0x10ffff, parseInt(hex, 16)) || 0xfffd)
      : /[\r\n\f]/.test(literal) ? "" : literal);
}

function fontFaceFamily(value) {
  if (!value) return null;
  const text = value.trim();
  if (/^["']/.test(text)) {
    return /^(?:"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')$/.test(text) ? decodeCssString(text) : null;
  }
  if (!/^(?:-?(?:[a-z_\u0080-\uFFFF]|--)[\w\u0080-\uFFFF-]*)(?:\s+-?(?:[a-z_\u0080-\uFFFF]|--)[\w\u0080-\uFFFF-]*)*$/i.test(text)) return null;
  if (CSS_WIDE_KEYWORDS.has(text.toLowerCase()) || ["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"].includes(text.toLowerCase())) return null;
  return text.replace(/\s+/g, " ");
}

function fontFaceSources(value, baseURL) {
  if (!value) return [];
  const result = [];
  for (const source of splitTopLevel(value, ",")) {
    const match = /^(url|local)\(\s*((?:"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|[^)]*?))\s*\)\s*(.*)$/i.exec(source);
    if (!match) continue;
    const target = decodeCssString(match[2]);
    if (!target) continue;
    if (match[1].toLowerCase() === "local") {
      if (!match[3]) result.push({ local: target });
      continue;
    }
    let url;
    try { url = new URL(target, baseURL).href; } catch { continue; }
    const format = /^format\(\s*([^)]*)\s*\)/i.exec(match[3]);
    const rest = format ? match[3].slice(format[0].length).trim() : match[3];
    if (rest && !/^tech\([^)]*\)$/i.test(rest)) continue;
    result.push({ url, ...(format ? { format: decodeCssString(format[1]).toLowerCase() } : {}),
      ...(rest ? { tech: rest.slice(5, -1).split(",").map((part) => part.trim().toLowerCase()) } : {}) });
  }
  return result;
}

function fontFaceUnicodeRanges(value) {
  const fallback = [[0, 0x10ffff]];
  if (!value) return fallback;
  const ranges = [];
  for (const token of value.split(",")) {
    const match = /^\s*U\+([\da-f]{1,6})(?:-([\da-f]{1,6}))?\s*$|^\s*U\+([\da-f]{0,5}\?{1,6})\s*$/i.exec(token);
    if (!match || match[3]?.length > 6) return fallback;
    const from = parseInt(match[3]?.replaceAll("?", "0") ?? match[1], 16);
    const to = Math.min(0x10ffff, parseInt(match[3]?.replaceAll("?", "F") ?? match[2] ?? match[1], 16));
    if (from > to || from > 0x10ffff) return fallback;
    ranges.push([from, to]);
  }
  return ranges.length ? ranges : fallback;
}

function newLayer(parent) {
  return { parent, children: new Map(), rank: Infinity };
}

const ANONYMOUS_LAYER = "\0anonymous";

function hasAnonymousLayer(node) {
  for (const [name, child] of node.children) if (name.startsWith(ANONYMOUS_LAYER) || hasAnonymousLayer(child)) return true;
  return false;
}

/**
 * Adds one sheet's layer tree to the layers of a sheet list, in first-seen
 * order; `layerOf` maps each of the sheet's layers to the list's. Every
 * anonymous layer is a layer of its own.
 */
function mergeLayers(node, target, layerOf) {
  for (const [name, child] of node.children) {
    const anonymous = name.startsWith(ANONYMOUS_LAYER);
    let merged = anonymous ? null : target.children.get(name);
    if (!merged) target.children.set(anonymous ? `${name}\0${target.children.size}` : name, merged = newLayer(target));
    layerOf.set(child, merged);
    mergeLayers(child, merged, layerOf);
  }
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
  rankLayerTree(root);
  for (const rule of rules) rule.layer = rule.layerNode ? rule.layerNode.rank : Infinity;
}

function rankLayerTree(root) {
  let next = 0;
  (function visit(node) {
    for (const child of node.children.values()) visit(child);
    if (node !== root) node.rank = next++;
  })(root);
}

/** Splits a `font` shorthand value into size, line height, weight and family. */
export function parseFontShorthand(value) {
  const tokens = splitTopLevel(value, " ").filter(Boolean);
  let weight = null;
  let style = "normal";
  let stretch = "normal";
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const lower = token.toLowerCase();
    if (lower === "italic" || lower === "oblique") { style = lower; continue; }
    if (lower !== "normal" && Object.hasOwn(FONT_STRETCH_KEYWORDS, lower)) { stretch = lower; continue; }
    if (["normal", "small-caps"].includes(lower)) continue;
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
    return { size, lineHeight: lineHeight || null, weight, style, stretch, family };
  }
  return null;
}

// Character codes for the scanners below, which run over whole style sheets.
const QUOTE = 0x22, APOSTROPHE = 0x27, BACKSLASH = 0x5c, OPEN_PAREN = 0x28, CLOSE_PAREN = 0x29, OPEN_BRACE = 0x7b, CLOSE_BRACE = 0x7d;

function findTopLevel(source, character, start, end) {
  const target = character.charCodeAt(0);
  let quote = 0;
  let depth = 0;
  for (let index = start; index < end; index++) {
    const current = source.charCodeAt(index);
    if (quote) {
      if (current === BACKSLASH) index++;
      else if (current === quote) quote = 0;
    } else if (current === BACKSLASH) index++;
    else if (current === QUOTE || current === APOSTROPHE) quote = current;
    else if (current === OPEN_PAREN) depth++;
    else if (current === CLOSE_PAREN) depth = Math.max(0, depth - 1);
    else if (current === target && depth === 0) return index;
    else if (current === OPEN_BRACE || current === CLOSE_BRACE) return target === current ? index : -1;
  }
  return -1;
}

function matchingBrace(source, open, end) {
  let depth = 0;
  let quote = 0;
  for (let index = open; index < end; index++) {
    const current = source.charCodeAt(index);
    if (quote) {
      if (current === BACKSLASH) index++;
      else if (current === quote) quote = 0;
    } else if (current === BACKSLASH) index++;
    else if (current === QUOTE || current === APOSTROPHE) quote = current;
    else if (current === OPEN_BRACE) depth++;
    else if (current === CLOSE_BRACE && --depth === 0) return index;
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
  let declarationIndex = 0;
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
    declarations.set(name, { name, value, important, declarationIndex: declarationIndex++ });
  }
  return declarations;
}

const reportedDeclarationErrors = new Set();

/**
 * Applies one cascaded declaration. A declaration the engine cannot handle is
 * dropped, as an invalid declaration would be, instead of failing the page.
 */
function applyDeclaration(style, declaration, customProperties, parentStyle, dependencies = null) {
  try {
    const value = resolveVariables(declaration.value, customProperties);
    if (dependencies && value === "inherit") dependencies.inheritsParent = true;
    setProperty(style, declaration.name, value, parentStyle);
  } catch (error) {
    const key = `${declaration.name}: ${declaration.value}`;
    if (reportedDeclarationErrors.size < 100 && !reportedDeclarationErrors.has(key)) {
      reportedDeclarationErrors.add(key);
      console.error(`buninu-browser: style: dropped "${key}": ${error?.message ?? error}`);
    }
  }
}

const LOGICAL_SIZES = Object.freeze({
  "inline-size": "width", "block-size": "height",
  "min-inline-size": "min-width", "max-inline-size": "max-width",
  "min-block-size": "min-height", "max-block-size": "max-height",
});

function setProperty(style, name, value, parentStyle = null) {
  if (name === "font-width") return setProperty(style, "font-stretch", value, parentStyle);
  const logicalCorner = /^border-(start|end)-(start|end)-radius$/.exec(name);
  if (logicalCorner) {
    const block = logicalCorner[1] === "start" ? "top" : "bottom";
    const inline = (logicalCorner[2] === "start") !== (style.direction === "rtl") ? "left" : "right";
    return setProperty(style, `border-${block}-${inline}-radius`, value, parentStyle);
  }
  // The layout engine uses horizontal writing. Resolve logical declarations
  // into their physical slots in cascade order, after direction is computed.
  if (Object.hasOwn(LOGICAL_SIZES, name)) return setProperty(style, LOGICAL_SIZES[name], value, parentStyle);
  if (name.includes("-inline") || name.includes("-block")) {
    const logical = /^(margin|padding|inset)-(inline|block)(?:-(start|end))?$/.exec(name);
    if (logical) {
      const [, property, axis, edge] = logical;
      const sides = axis === "block" ? ["top", "bottom"]
        : style.direction === "rtl" ? ["right", "left"] : ["left", "right"];
      const physical = (side) => property === "inset" ? side : `${property}-${side}`;
      if (edge) return setProperty(style, physical(sides[edge === "start" ? 0 : 1]), value, parentStyle);
      if (CSS_WIDE_KEYWORDS.has(value)) {
        for (const side of sides) setProperty(style, physical(side), value, parentStyle);
        return;
      }
      const parts = splitTopLevel(value, " ").filter(Boolean);
      if (!parts.length || parts.length > 2) return;
      const lengths = parts.map((part) => property !== "padding" && part === "auto" ? "auto"
        : computedLength(part, style, property !== "margin"));
      if (lengths.some((length) => length !== "auto" && !Number.isFinite(length) && !length?.unit
        || property === "padding" && (typeof length === "number" ? length < 0 : length?.unit === "%" && length.value < 0))) return;
      setProperty(style, physical(sides[0]), parts[0], parentStyle);
      setProperty(style, physical(sides[1]), parts[1] ?? parts[0], parentStyle);
      return;
    }
  }
  if (CSS_WIDE_KEYWORDS.has(value)) {
    const inherits = value === "inherit" || (value !== "initial" && INHERITED.has(name));
    copyProperty(style, name, inherits && parentStyle ? parentStyle : INITIAL);
    return;
  }
  if (typeof value !== "string") return;
  switch (name) {
    case "direction":
      if (value === "ltr" || value === "rtl") style.direction = value;
      break;
    case "color-scheme": {
      const schemes = value.toLowerCase().split(/\s+/).filter((part) => part !== "only");
      if (schemes.every((part) => ["normal", "light", "dark"].includes(part))) {
        style.colorScheme = schemes.includes("light") || !schemes.includes("dark") ? "light" : "dark";
      }
      break;
    }
    case "display": if (DISPLAYS.has(value)) style.display = value; break;
    case "-webkit-line-clamp":
      if (value === "none") style.webkitLineClamp = null;
      else if (/^[1-9]\d*$/.test(value)) style.webkitLineClamp = Number(value);
      break;
    case "-webkit-box-orient":
      if (["vertical", "horizontal"].includes(value)) style.webkitBoxOrient = value;
      break;
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
          || Number.isFinite(computedLength(token, style, true)) || /%$/.test(token)) {
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
    case "user-select":
    case "-webkit-user-select":
      if (["auto", "none", "text", "all"].includes(value)) style.userSelect = value;
      break;
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
      // Every non-visible value clips; all but clip also make a scroll container.
      const parts = value.split(/\s+/);
      const clips = (part) => (["hidden", "clip", "auto", "scroll", "overlay"].includes(part) ? "clip" : part === "visible" ? "visible" : null);
      const scrolls = (part) => (["auto", "scroll", "overlay"].includes(part) ? "auto" : part === "hidden" ? "hidden" : null);
      const xPart = parts[0];
      const yPart = name === "overflow" ? parts[1] ?? parts[0] : parts[0];
      const x = clips(xPart);
      const y = clips(yPart);
      if (name !== "overflow-y" && x) {
        style.overflowX = x;
        style.overflowScrollX = scrolls(xPart);
      }
      if (name !== "overflow-x" && y) {
        style.overflowY = y;
        style.overflowScrollY = scrolls(yPart);
      }
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
        const edges = rect[1].split(/\s*,\s*|\s+/).map((part) => (part === "auto" ? "auto" : computedLength(part, style)));
        if (edges.length === 4 && edges.every((edge) => edge === "auto" || Number.isFinite(edge))) style.clip = Object.freeze(edges);
      }
      break;
    }
    case "clip-path": {
      // Only rectangles: inset(top right bottom left) and rect(0 0 0 0)-style empty clips.
      if (value === "none") style.clipPath = null;
      const inset = /^inset\(\s*([^)]*?)\s*(?:round\s[^)]*)?\)$/i.exec(value);
      if (inset) {
        const box = boxLengths(inset[1], false, style, false, true);
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
    case "fill":
    case "stroke": {
      const paint = ["none", "currentcolor"].includes(value.toLowerCase()) ? value.toLowerCase()
        : /^url\(/i.test(value) ? value : resolvedColor(value, style.colorScheme);
      if (paint) style[name] = paint;
      break;
    }
    case "stroke-width": {
      const width = /^[\d.]+$/.test(value) ? Number(value) : computedLength(value, style);
      if (Number.isFinite(width) && width >= 0) style.strokeWidth = width;
      break;
    }
    case "fill-opacity":
    case "stroke-opacity": {
      const opacity = value.endsWith("%") ? Number(value.slice(0, -1)) / 100 : Number(value);
      if (Number.isFinite(opacity)) style[name === "fill-opacity" ? "fillOpacity" : "strokeOpacity"] = Math.max(0, Math.min(1, opacity));
      break;
    }
    case "fill-rule": if (["nonzero", "evenodd"].includes(value)) style.fillRule = value; break;
    case "background-color": {
      const color = resolvedColor(value, style.colorScheme);
      if (color) style.backgroundColor = color;
      break;
    }
    case "background": {
      // The shorthand resets the longhands; only the final layer may carry a color.
      const layers = splitTopLevel(value, ",").map(parseBackgroundLayer);
      if (layers.some((layer) => !layer)) break;
      style.backgroundColor = layers.at(-1).color
        ? resolvedColor(layers.at(-1).color, style.colorScheme) ?? INITIAL.backgroundColor
        : INITIAL.backgroundColor;
      const hasImage = layers.some((layer) => layer.image !== "none");
      style.backgroundImage = hasImage ? layers.map((layer) => layer.image).join(", ") : null;
      const list = (field, initial) => layers.some((layer) => layer[field] !== initial)
        ? layers.map((layer) => layer[field]).join(", ")
        : null;
      style.backgroundPosition = hasImage ? list("position", "0% 0%") : null;
      style.backgroundSize = hasImage ? list("size", "auto") : null;
      style.backgroundRepeat = hasImage ? list("repeat", "repeat") : null;
      break;
    }
    case "background-image": {
      if (value === "none") style.backgroundImage = null;
      else {
        const images = splitTopLevel(value, ",").map((layer) => BACKGROUND_IMAGE.test(layer) || layer === "none" ? layer : null);
        if (images.every(Boolean) && images.some((layer) => layer !== "none")) style.backgroundImage = images.join(", ");
      }
      break;
    }
    case "background-position":
    case "background-size":
    case "background-repeat": {
      const field = { "background-position": "backgroundPosition", "background-size": "backgroundSize", "background-repeat": "backgroundRepeat" }[name];
      style[field] = value.toLowerCase().replace(/\s+/g, " ");
      break;
    }
    case "box-shadow": {
      const shadows = value === "none" ? null : parseBoxShadows(value, style);
      if (value === "none" || shadows) style.boxShadow = shadows;
      break;
    }
    case "background-clip":
    case "-webkit-background-clip":
      if (["border-box", "padding-box", "content-box", "text"].includes(value)) style.backgroundClip = value;
      break;
    case "font-size": {
      const parentSize = parentStyle?.fontSize ?? INITIAL.fontSize;
      const specified = computedLength(value, parentStyle ?? INITIAL, true);
      const relativeSize = specified?.unit === "%" ? parentSize * specified.value / 100
        : specified?.unit === "math" && specified.kind === "calc" ? specified.px + parentSize * specified.percent / 100 : specified;
      const length = FONT_SIZE_KEYWORDS[value] ?? (value === "larger" ? parentSize * 1.2 : value === "smaller" ? parentSize / 1.2
        : relativeSize);
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
      if (name === "font") {
        setProperty(style, "font-weight", parsed.weight ?? "normal", parentStyle);
        setProperty(style, "font-style", parsed.style ?? "normal", parentStyle);
        setProperty(style, "font-stretch", parsed.stretch ?? "normal", parentStyle);
        setProperty(style, "font-family", parsed.family, parentStyle);
      }
      break;
    }
    case "position":
      if (["static", "relative", "absolute", "fixed", "sticky"].includes(value)) style.position = value;
      break;
    case "top":
    case "right":
    case "bottom":
    case "left": {
      const length = value === "auto" ? "auto" : computedLength(value, style, true);
      if (length === "auto" || Number.isFinite(length) || length?.unit) style.inset = style.inset.with(BOX_SIDES.indexOf(name), length);
      break;
    }
    case "inset": {
      const parts = splitTopLevel(value, " ").filter(Boolean)
        .map((part) => part === "auto" ? "auto" : computedLength(part, style, true));
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
      const transform = value === "none" ? null : parseTransform(value, style);
      if (transform !== undefined) style.transform = transform;
      break;
    }
    case "translate": {
      if (value === "none") { style.translate = null; break; }
      const parts = splitTopLevel(value, " ").filter(Boolean);
      if (parts.length < 1 || parts.length > 2) break;
      const lengths = parts.map(part => computedLength(part, style, true));
      if (lengths.some(part => !Number.isFinite(part) && !part?.unit)) break;
      style.translate = Object.freeze({x:lengths[0],y:lengths[1] ?? 0});
      break;
    }
    case "transform-origin":
      style.transformOrigin = value.toLowerCase().replace(/\s+/g, " ");
      break;
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
    case "font-style": if (["normal", "italic", "oblique"].includes(value)) style.fontStyle = value; break;
    case "font-stretch":
    case "font-width": {
      const stretch = fontStretch(value);
      if (Number.isFinite(stretch)) style.fontStretch = stretch;
      break;
    }
    case "white-space": if (WHITE_SPACES.has(value)) style.whiteSpace = value; break;
    case "border-spacing": {
      const parts = value.split(/\s+/).map((part) => computedLength(part, style));
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
      } else if (value !== "" && Number.isFinite(numeric) && numeric >= 0) {
        style.lineHeight = numeric * style.fontSize;
        style.lineHeightFactor = numeric;
      } else {
        // Non-negative, so 0 is valid (icon buttons set line-height: 0); a
        // percentage computes to a length against this element's font size.
        const percentage = /^(\d+\.?\d*|\.\d+)%$/.exec(value);
        const length = percentage ? Number(percentage[1]) / 100 * style.fontSize : computedLength(value, style);
        if (length >= 0) {
          style.lineHeight = length;
          style.lineHeightFactor = null;
        }
      }
      break;
    }
    case "margin": {
      const box = boxLengths(value, true, style, true);
      if (box) style.margin = box;
      break;
    }
    case "padding": {
      const box = boxLengths(value, false, style, false, true);
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
      const length = isMargin && value === "auto" ? "auto" : computedLength(value, style, !isMargin);
      if (length === "auto" || (!isMargin && isLength(length) && typeof length === "object"
        && (!isPercentage(length) || length.value >= 0)) || (Number.isFinite(length) && (isMargin || length >= 0))) {
        style[box] = style[box].with(BOX_SIDES.indexOf(side), length);
      }
      break;
    }
    case "width":
    case "height": {
      const length = value === "auto" ? "auto" : computedLength(value, style, true);
      if (length === "auto" || isLength(length)) style[name] = length;
      break;
    }
    case "min-width":
    case "max-width":
    case "min-height":
    case "max-height": {
      const none = name.startsWith("max-") && value === "none";
      const length = none ? "none" : computedLength(value, style, true);
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
      const parsed = parseBorderShorthand(value, style);
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
        ? borderWidth(part, style)
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
        const width = borderWidth(value, style);
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
      const axes = splitTopLevel(value, "/");
      if (axes.length > 2) break;
      const horizontal = radiusLengths(axes[0], style, 4);
      const vertical = axes.length === 2 ? radiusLengths(axes[1], style, 4) : horizontal;
      if (!horizontal || !vertical) break;
      const expand = values => [values[0], values[1] ?? values[0], values[2] ?? values[0], values[3] ?? values[1] ?? values[0]];
      const x = expand(horizontal), y = expand(vertical);
      for (let i = 0; i < 4; i++) style[CORNER_FIELDS[i]] = Object.freeze([x[i], y[i]]);
      style.borderRadius = x[0];
      break;
    }
    case "border-top-left-radius": case "border-top-right-radius":
    case "border-bottom-right-radius": case "border-bottom-left-radius": {
      const lengths = radiusLengths(value, style, 2);
      if (lengths) style[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]
        = Object.freeze([lengths[0], lengths[1] ?? lengths[0]]);
      break;
    }
    case "box-sizing": if (["content-box", "border-box"].includes(value)) style.boxSizing = value; break;
    case "flex-flow": {
      const parts = value.split(/\s+/);
      let direction = null;
      let wrap = null;
      for (const part of parts) {
        if (["row", "column"].includes(part) && direction == null) direction = part;
        else if (["nowrap", "wrap"].includes(part) && wrap == null) wrap = part;
        else return;
      }
      if (parts.length) {
        style.flexDirection = direction ?? "row";
        style.flexWrap = wrap ?? "nowrap";
      }
      break;
    }
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
      const parts = splitTopLevel(value, " ").filter(Boolean);
      if (parts.length < 1 || parts.length > 2) break;
      const [row, column = row] = parts
        .map((part) => part === "normal" ? 0 : computedLength(part, style));
      if (row >= 0 && column >= 0) {
        style.gap = row;
        style.rowGap = row;
        style.columnGap = column;
        style.rowGapNormal = parts[0] === "normal";
        style.columnGapNormal = (parts[1] ?? parts[0]) === "normal";
      }
      break;
    }
    case "grid-gap": return setProperty(style, "gap", value, parentStyle);
    case "grid-row-gap": return setProperty(style, "row-gap", value, parentStyle);
    case "grid-column-gap": return setProperty(style, "column-gap", value, parentStyle);
    case "grid-template-columns":
    case "grid-template-rows": {
      const tracks = value === "none" ? null : parseTrackList(value, style);
      if (value === "none" || tracks) style[name === "grid-template-columns" ? "gridTemplateColumns" : "gridTemplateRows"] = tracks;
      break;
    }
    case "grid-template-areas": {
      const areas = value === "none" ? null : parseGridAreas(value);
      if (value === "none" || areas) style.gridTemplateAreas = areas;
      break;
    }
    case "grid-template": {
      if (value === "none") {
        style.gridTemplateRows = style.gridTemplateColumns = style.gridTemplateAreas = null;
        break;
      }
      const parts = splitTopLevel(value, "/");
      if (parts.length > 2) break;
      const columns = parts[1] == null || parts[1] === "none" ? null : parseTrackList(parts[1], style);
      if (parts[1] != null && parts[1] !== "none" && !columns) break;
      // A string token needs no surrounding whitespace in minified CSS.
      const rowText = parts[0].replace(/\[[^\]]*\]/g, "").replace(/"[^"\\]*"|'[^'\\]*'/g, " $& ");
      const tokens = splitTopLevel(rowText, " ").filter(Boolean);
      if (tokens.some((token) => /^["']/.test(token))) {
        const rows = [], strings = [];
        let valid = true;
        for (let index = 0; index < tokens.length; index++) {
          const token = tokens[index];
          if (!/^(?:"[^"\\]*"|'[^'\\]*')$/.test(token)) { valid = false; break; }
          strings.push(token);
          const size = tokens[index + 1] && !/^["']/.test(tokens[index + 1]) ? tokens[++index] : "auto";
          const track = parseTrackSize(size, style);
          if (!track) { valid = false; break; }
          rows.push(track);
        }
        const areas = valid && parseGridAreas(strings.join(" "));
        if (areas) Object.assign(style, { gridTemplateRows: Object.freeze(rows), gridTemplateColumns: columns, gridTemplateAreas: areas });
      } else if (parts.length === 2) {
        const rows = parts[0] === "none" ? null : parseTrackList(parts[0], style);
        if (parts[0] === "none" || rows) Object.assign(style, { gridTemplateRows: rows, gridTemplateColumns: columns, gridTemplateAreas: null });
      }
      break;
    }
    case "grid-auto-columns":
    case "grid-auto-rows": {
      const tracks = parseTrackList(value, style);
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
      // A lone area name denotes both edges; a lone integer spans one track.
      style[`grid${axis}End`] = end ?? (start.name ? start : "auto");
      break;
    }
    case "grid-area": {
      const [rowStart, columnStart = rowStart.name ? rowStart : "auto",
        rowEnd = rowStart.name ? rowStart : "auto", columnEnd = columnStart.name ? columnStart : "auto"] = value.split("/")
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
      const length = value === "normal" ? 0 : computedLength(value, style);
      if (length >= 0) {
        const field = name === "row-gap" ? "rowGap" : "columnGap";
        style[field] = length;
        style[`${field}Normal`] = value === "normal";
      }
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
      const basis = flexBasis(value, style);
      if (basis != null) style.flexBasis = basis;
      break;
    }
    case "flex": {
      const flex = flexShorthand(value, style);
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
      // Kept on the rule: a parsed sheet's rules are indexed again whenever the sheet list changes.
      if (rule.subjectKeys === undefined) {
        const { subject, ancestors } = selectorKeys(rule.selector);
        rule.ancestorIds = Int32Array.from(ancestors, filterKeyId);
        rule.subjectKeys = subject;
      }
      rule.seen = 0;
      const keys = rule.subjectKeys;
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
   * @param {AncestorFilter} ancestors keys present on its ancestors
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
        if (ancestors.hasAll(rule.ancestorIds)) result.push(rule);
      }
    }
    if (lists.length > 1) result.sort((left, right) => left.order - right.order);
    return result;
  }
}

/**
 * The elements that match each selector among `root`'s descendants and, for
 * an element, `root` itself (querySelectorAll() plus matches()), in one walk: selectors are bucketed by their subject's keys like
 * rules, so each element is only tested against selectors it may match.
 * Invalid selectors are left out of the result.
 * @param {Element | Document} root
 * @param {Iterable<string>} selectors
 * @param {Map<string, object | null>} [compiledSelectors] compiled selectors to reuse and add to
 * @returns {Map<string, Set<Element>>}
 */
export function matchSelectors(root, selectors, compiledSelectors = new Map()) {
  const result = new Map();
  const buckets = { id: new Map(), class: new Map(), attr: new Map(), tag: new Map(), universal: [] };
  const sample = root.nodeType === 9 ? root.documentElement : root;
  for (const selector of selectors) {
    if (result.has(selector)) continue;
    // :scope means the root to querySelectorAll() but the element to matches().
    let compiled;
    if (sample && !selector.includes(":scope")) {
      compiled = compiledSelectors.get(selector);
      if (compiled === undefined) {
        compiled = compileSelector(sample, selector);
        if (compiled !== undefined) compiledSelectors.set(selector, compiled);
      }
    }
    if (compiled === null) continue;
    if (compiled === undefined) {
      try { result.set(selector, new Set(root.querySelectorAll(selector))); } catch { /* invalid */ }
      continue;
    }
    const entry = { compiled, matched: new Set(), seen: 0 };
    result.set(selector, entry.matched);
    const keys = selectorKeys(selector).subject;
    if (!keys) {
      buckets.universal.push(entry);
      continue;
    }
    for (const key of keys) {
      const list = buckets[key.kind].get(key.name);
      if (list) list.push(entry); else buckets[key.kind].set(key.name, [entry]);
    }
  }
  let stamp = 0;
  const test = (element, list) => {
    if (!list) return;
    for (const entry of list) {
      if (entry.seen === stamp) continue;
      entry.seen = stamp;
      if (matchesCompiled(element, entry.compiled)) entry.matched.add(element);
    }
  };
  const visit = (element) => {
    stamp++;
    const keys = elementKeys(element);
    test(element, buckets.universal);
    if (keys.id) test(element, buckets.id.get(keys.id));
    for (const name of keys.classes) test(element, buckets.class.get(name));
    for (const name of keys.attrs) test(element, buckets.attr.get(name));
    if (keys.tag) test(element, buckets.tag.get(keys.tag));
    for (const child of element.children) visit(child);
  };
  if (root.nodeType === 1) visit(root);
  else for (const child of root.children ?? []) visit(child);
  return result;
}

/** The keys an element offers to selectors: id, classes, attribute names, type. */
function elementKeys(element) {
  const id = element.getAttribute?.("id") || null;
  const className = element.getAttribute?.("class");
  // Candidate stamps deduplicate rules/selectors, and ancestor counts balance
  // repeated keys. Deduplicate long lists to bound repeated bucket walks while
  // avoiding a Set allocation for the usual short class attribute.
  let classes = className ? className.split(/\s+/).filter(Boolean) : [];
  if (classes.length > 16) classes = [...new Set(classes)];
  const attrs = [];
  for (const attribute of element.attributes ?? []) attrs.push(String(attribute.name).toLowerCase());
  const tag = element.localName ?? element.tagName;
  return { id, classes, attrs, tag: tag ? String(tag).toLowerCase() : null };
}

// Ancestor filter keys that some rule requires, numbered for AncestorFilter.
const FILTER_KEY_IDS = new Map();

function filterKeyId(key) {
  let id = FILTER_KEY_IDS.get(key);
  if (id === undefined) FILTER_KEY_IDS.set(key, id = FILTER_KEY_IDS.size);
  return id;
}

/**
 * Counts of the filter keys on the elements above the one being styled (a
 * counting filter, like Blink's ancestor Bloom filter but exact). Keys no
 * rule requires are not counted. Created after the rules are indexed.
 */
class AncestorFilter {
  #counts = new Int32Array(Math.max(1, FILTER_KEY_IDS.size));

  /** Adds an element's keys; returns what pop() takes to remove them. */
  push(keys) {
    const ids = [];
    for (const key of ancestorFilterKeys(keys)) {
      const id = FILTER_KEY_IDS.get(key);
      if (id === undefined || id >= this.#counts.length) continue;
      this.#counts[id]++;
      ids.push(id);
    }
    return ids;
  }

  pop(ids) {
    for (const id of ids) this.#counts[id]--;
  }

  hasAll(ids) {
    for (let index = 0; index < ids.length; index++) if (!(this.#counts[ids[index]] > 0)) return false;
    return true;
  }
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

function cascadeDeclarations(element, rules, pseudo = null, keys = elementKeys(element), ancestors = new AncestorFilter()) {
  const result = new Map();
  result.hasCustomProperties = false;
  for (const rule of rules.candidates(keys, pseudo, ancestors)) {
    if (!matchesSelector(element, rule)) continue;
    if (rule.hasCustomProperties) result.hasCustomProperties = true;
    const { specificity, order } = rule;
    const layer = rule.layer ?? Infinity;
    for (const declaration of rule.declarationList) {
      const current = result.get(declaration.name);
      if (current && compareCascadeParts(declaration.important, layer, specificity, order, current) < 0) continue;
      result.set(declaration.name, { ...declaration, specificity, order, layer });
    }
  }
  return result;
}

function compareCascade(left, right) {
  return compareCascadeParts(left.important, left.layer ?? Infinity, left.specificity, left.order, right);
}

/** compareCascade() for a left side given as its parts (no object for it). */
function compareCascadeParts(important, layer, specificity, order, right) {
  if (important !== right.important) return important ? 1 : -1;
  // Cascade layers: later layers and unlayered styles win for normal
  // declarations; for !important the order is reversed.
  const rightLayer = right.layer ?? Infinity;
  if (layer !== rightLayer) return (layer > rightLayer ? 1 : -1) * (important ? -1 : 1);
  if (specificity !== right.specificity) return specificity - right.specificity;
  return order - right.order;
}

/**
 * compareCascade() for declarations that may lack cascade fields (user-agent
 * and inline ones): absent means normal importance, specificity and order 0.
 */
function compareDeclarations(left, right) {
  const leftImportant = Boolean(left.important);
  const rightImportant = Boolean(right.important);
  if (leftImportant !== rightImportant) return leftImportant ? 1 : -1;
  const leftLayer = left.layer ?? Infinity;
  const rightLayer = right.layer ?? Infinity;
  if (leftLayer !== rightLayer) return (leftLayer > rightLayer ? 1 : -1) * (leftImportant ? -1 : 1);
  const leftSpecificity = "specificity" in left ? left.specificity : 0;
  const rightSpecificity = "specificity" in right ? right.specificity : 0;
  if (leftSpecificity !== rightSpecificity) return leftSpecificity - rightSpecificity;
  const leftOrder = left.order ?? 0;
  const rightOrder = right.order ?? 0;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return (left.declarationIndex ?? 0) - (right.declarationIndex ?? 0);
}

const PSEUDO_ELEMENT = /(?:::?(before|after)|::([\w-]+))$/i;

/**
 * Splits a trailing pseudo-element off a selector. Returns pseudo null for
 * element selectors, "before"/"after" for generated content, and undefined for
 * pseudo-elements that are not rendered (::placeholder, ::selection, ...).
 */
function splitPseudoElement(selectorText) {
  // A trailing pseudo-element starts at the last colon (or the one before
  // it): only the tail needs the regular expression.
  const colon = selectorText.lastIndexOf(":");
  if (colon < 0) return { selector: selectorText, pseudo: null };
  const offset = Math.max(0, colon - 1);
  const match = PSEUDO_ELEMENT.exec(offset ? selectorText.slice(offset) : selectorText);
  if (!match) return { selector: selectorText, pseudo: null };
  const selector = selectorText.slice(0, offset + match.index).trim() || "*";
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
    // Compiled once per rule; objects other than Happy DOM elements use matches().
    let compiled = rule.compiled;
    if (compiled === undefined) {
      compiled = compileSelector(element, rule.selector);
      if (compiled === undefined) return element.matches(rule.selector);
      rule.compiled = compiled;
    }
    if (compiled === null) {
      rule.invalid = true;
      return false;
    }
    return matchesCompiled(element, compiled);
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
 * The translation (layout moves the box) and scale (paint scales it about
 * transform-origin) of a transform list. Compose in list order: a translation
 * after a scale uses that scaled coordinate system. Percentages remain lengths
 * until layout knows the element's own border box. Other functions are ignored.
 */
function parseTransform(value, fontSize) {
  let x = 0;
  let y = 0;
  let scaleX = 1;
  let scaleY = 1;
  let found = false;
  const functions = /\b([a-z][a-z0-9]*)\(/gi;
  let match;
  while ((match = functions.exec(value))) {
    let end = functions.lastIndex;
    let depth = 1;
    while (end < value.length && depth) {
      if (value[end] === "(") depth++;
      else if (value[end] === ")") depth--;
      end++;
    }
    if (depth) return undefined;
    const kind = match[1].toLowerCase();
    const parts = splitTopLevel(value.slice(functions.lastIndex, end - 1), ",");
    functions.lastIndex = end;
    if (["translate", "translatex", "translatey", "translate3d"].includes(kind)) {
      const args = parts.map(part => computedLength(part, fontSize, true));
      const max = kind === "translate3d" ? 3 : kind === "translate" ? 2 : 1;
      if (!args.length || args.length > max || args.some(part => !Number.isFinite(part) && !part?.unit)) return undefined;
      if (kind === "translatey") y = addTransformLength(y, scaleTransformLength(args[0], scaleY));
      else {
        x = addTransformLength(x, scaleTransformLength(args[0], scaleX));
        if (kind !== "translatex") y = addTransformLength(y, scaleTransformLength(args[1] ?? 0, scaleY));
      }
    } else if (["scale", "scalex", "scaley", "scale3d"].includes(kind)) {
      const args = parts.map(part => part.endsWith("%") ? Number(part.slice(0, -1)) / 100 : Number(part));
      const max = kind === "scale3d" ? 3 : kind === "scale" ? 2 : 1;
      if (!args.length || args.length > max || args.some(part => !Number.isFinite(part))) return undefined;
      if (kind === "scalex") scaleX *= args[0];
      else if (kind === "scaley") scaleY *= args[0];
      else { scaleX *= args[0]; scaleY *= args[1] ?? args[0]; }
    } else {
      continue;
    }
    found = true;
  }
  if (!found) return null;
  return Object.freeze(scaleX === 1 && scaleY === 1 ? { x, y } : { x, y, scaleX, scaleY });
}

function scaleTransformLength(value, factor) {
  if (factor === 1) return value;
  if (typeof value === "number") return value * factor;
  if (value.unit === "%") return Object.freeze({ unit: "%", value: value.value * factor });
  if (value.kind === "calc") return Object.freeze({ ...value, px: value.px * factor, percent: value.percent * factor });
  return Object.freeze({ unit: "math", kind: "scale", value, factor });
}

function addTransformLength(a, b) {
  if (a === 0) return b;
  if (b === 0) return a;
  const linear = value => typeof value === "number" ? { px: value, percent: 0 }
    : value.unit === "%" ? { px: 0, percent: value.value } : value.kind === "calc" ? value : null;
  const left = linear(a), right = linear(b);
  if (!left || !right) return Object.freeze({ unit: "math", kind: "sum", values: Object.freeze([a, b]) });
  const px = left.px + right.px, percent = left.percent + right.percent;
  return percent === 0 ? px : px === 0 ? Object.freeze({ unit: "%", value: percent })
    : Object.freeze({ unit: "math", kind: "calc", px, percent });
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
export function resolveVariables(value, customProperties, seen = new Set()) {
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
  const insetSide = BOX_SIDES.indexOf(name);
  if (insetSide >= 0) {
    style.inset = style.inset.with(insetSide, source.inset[insetSide]);
    return;
  }
  // border, border-<side>, border-<width|style|color>, border-<side>-<...>;
  // not border-radius, border-spacing or border-collapse.
  const border = /^border(?:-(top|right|bottom|left))?(?:-(width|style|color))?$/.exec(name);
  if (border) {
    const fields = border[2] === "width" ? ["borderSpecifiedWidths"]
      : border[2] === "style" ? ["borderStyles"] : border[2] === "color" ? ["borderColors"] : BORDER_FIELDS;
    const side = border[1] == null ? -1 : BOX_SIDES.indexOf(border[1]);
    for (const field of fields) style[field] = side < 0 ? source[field] : style[field].with(side, source[field][side]);
    return;
  }
  const fields = PROPERTY_FIELDS[name] ?? [name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
  for (const field of fields) {
    if (Object.hasOwn(INITIAL, field)) style[field] = source[field];
  }
}

// Most inheritance asks for one value (often line-height). Do not serialize
// unrelated font families and numeric properties for every element.
function cssValue(style, name) {
  let value;
  switch (name) {
    case "background-color": value = style.backgroundColor; break;
    case "font-family": value = style.fontFamily.map((family) => JSON.stringify(family)).join(", "); break;
    case "font-size": value = `${style.fontSize}px`; break;
    case "font-weight": value = String(style.fontWeight); break;
    case "font-style": value = style.fontStyle; break;
    case "font-stretch":
    case "font-width": value = `${style.fontStretch}%`; break;
    case "line-height": value = style.lineHeightFactor != null ? String(style.lineHeightFactor)
      : style.lineHeight == null ? "normal" : `${style.lineHeight}px`; break;
    case "list-style-type": value = style.listStyleType; break;
    case "pointer-events": value = style.pointerEvents; break;
    case "user-select": value = style.userSelect; break;
    case "text-align": value = style.textAlign; break;
    case "white-space": value = style.whiteSpace; break;
  }
  return value ?? style[name];
}

function pixelLength(value) {
  if (value === "0") return 0;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))px$/i.exec(String(value));
  return match ? Number(match[1]) : NaN;
}

function radiusLengths(value, style, maximum) {
  const parts = splitTopLevel(value, " ").filter(Boolean);
  if (!parts.length || parts.length > maximum) return null;
  const lengths = parts.map(part => computedLength(part, style, true));
  return lengths.every((length, index) => Number.isFinite(length)
    ? length >= 0 || /^(?:calc|min|max|clamp)\(/i.test(parts[index])
    : length?.unit === "%" ? length.value >= 0 : length?.unit === "math") ? lengths : null;
}

function fontStretch(value) {
  if (Object.hasOwn(FONT_STRETCH_KEYWORDS, value)) return FONT_STRETCH_KEYWORDS[value];
  const percent = /^(?:\d+\.?\d*|\.\d+)%$/.test(value) ? Number.parseFloat(value) : NaN;
  return percent >= 0 ? percent : NaN;
}

function computedLength(value, font, allowPercentage = false) {
  const text = String(value).trim();
  if (allowPercentage) {
    const percentage = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(text);
    if (percentage) return Object.freeze({ unit: "%", value: Number(percentage[1]) });
  }
  const absolute = pixelLength(text);
  if (Number.isFinite(absolute)) return absolute;
  if (/^calc\(/i.test(text)) {
    const sum = calcLength(text, font);
    if (!sum || !(sum.percent === 0 || allowPercentage)) return NaN;
    return sum.percent === 0 ? sum.px : Object.freeze({ unit: "math", kind: "calc", px: sum.px, percent: sum.percent });
  }
  const math = /^(clamp|min|max)\((.*)\)$/i.exec(text);
  if (math) {
    const kind = math[1].toLowerCase();
    const values = splitTopLevel(math[2], ",").map((part) => computedLength(part, font, allowPercentage));
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
  const relative = /^([+-]?(?:\d+\.?\d*|\.\d+))(rem|em|ch|[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max)|pt)$/i.exec(text);
  if (!relative) return NaN;
  const unit = relative[2].toLowerCase();
  if (/^(?:[sld]?v|cq)/.test(unit)) {
    // A headless viewport has no retractable browser UI: small, large and
    // dynamic viewport sizes coincide. Inline/block follow horizontal writing.
    // Without an eligible query container, cq* uses the small viewport
    // (CSS Containment 3 §6). Container-type sizing is not implemented yet.
    const axis = unit.replace(/^(?:[sld]?v|cq)/, "");
    const {viewportWidth:width,viewportHeight:height} = environment;
    const size = axis === "w" || axis === "i" ? width : axis === "h" || axis === "b" ? height
      : axis === "min" ? Math.min(width,height) : Math.max(width,height);
    return Number(relative[1]) * size / 100;
  }
  const emSize = typeof font === "object" ? font.fontSize : font;
  // CSS Values 4 §6.1.1: ch is the advance of U+0030 in the used font.
  // The spec's 0.5em fallback applies when no font measurement is available.
  let characterWidth = emSize / 2;
  if (unit === "ch" && environment.measureText) {
    // The style is still being built; do not give a mutable style identity
    // to the renderer's immutable-style font-key cache.
    const measured = environment.measureText("0", {
      fontSize: emSize, fontFamily: font?.fontFamily ?? INITIAL.fontFamily,
      fontWeight: font?.fontWeight ?? INITIAL.fontWeight,
      fontStyle: font?.fontStyle ?? INITIAL.fontStyle,
      fontStretch: font?.fontStretch ?? INITIAL.fontStretch,
    });
    if (Number.isFinite(measured) && measured >= 0) characterWidth = measured;
  }
  const scale = unit === "rem" ? environment.rootFontSize
    : unit === "em" ? emSize
      : unit === "ch" ? characterWidth : 4 / 3;
  return Number(relative[1]) * scale;
}

/**
 * calc() (CSS Values 4 §10) as { px, percent }: sums and differences of
 * lengths and percentages, multiplied or divided by numbers, with nested
 * parentheses and calc(). Percentages resolve at layout time. Returns null
 * for anything else (such as min() of a percentage inside calc()).
 */
function calcLength(text, emSize) {
  const tokens = String(text).match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:%|[a-z]+)?|[a-z-]+\(|[(),*/+-]/gi);
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
  if (/^-?(?:[a-zA-Z_\u0080-\uFFFF]|--)[\w\u0080-\uFFFF-]*$/.test(token) && token !== "span") {
    return Object.freeze({ name: token });
  }
  return "auto";
}

/** CSS Grid §7.3: equal-width strings whose named cells form rectangles. */
function parseGridAreas(value) {
  const rows = [];
  const strings = /\s*(["'])(.*?)\1\s*/gy;
  while (strings.lastIndex < value.length) {
    const match = strings.exec(value);
    if (!match) return null;
    const cells = match[2].match(/[\w\u0080-\uFFFF-]+|\.+|[^\s]/g) ?? [];
    if (!cells.length || cells.some((cell) => !/^(?:[\w\u0080-\uFFFF-]+|\.+)$/.test(cell))) return null;
    if (rows.length && cells.length !== rows[0].length) return null;
    rows.push(cells.map((cell) => cell[0] === "." ? null : cell));
  }
  if (!rows.length) return null;
  const areas = Object.create(null);
  for (let row = 0; row < rows.length; row++) {
    for (let column = 0; column < rows[row].length; column++) {
      const name = rows[row][column];
      if (name == null) continue;
      const area = areas[name] ??= { row, column, rowEnd: row + 1, columnEnd: column + 1 };
      area.rowEnd = row + 1;
      area.column = Math.min(area.column, column);
      area.columnEnd = Math.max(area.columnEnd, column + 1);
    }
  }
  for (const [name, area] of Object.entries(areas)) {
    for (let row = area.row; row < area.rowEnd; row++) {
      for (let column = area.column; column < area.columnEnd; column++) {
        if (rows[row][column] !== name) return null;
      }
    }
    Object.freeze(area);
  }
  return Object.freeze({ rows: rows.length, columns: rows[0].length, areas: Object.freeze(areas) });
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
  const parts = splitTopLevel(value.trim(), " ").filter(Boolean);
  const numbers = [];
  let basis = null;
  for (const part of parts) {
    const number = Number(part);
    if (part !== "" && Number.isFinite(number) && number >= 0 && numbers.length < 2 && basis == null) numbers.push(number);
    else if (basis == null && (basis = flexBasis(part, fontSize)) != null) continue;
    else return null;
  }
  if (!numbers.length && basis == null) return null;
  // A unitless zero after the factors is a basis, per the grammar.
  return {
    flexGrow: numbers[0] ?? 1,
    flexShrink: numbers[1] ?? 1,
    // The omitted basis is a percentage, not a definite zero length. In an
    // auto-height column, 0% is indefinite and uses the item's content size.
    flexBasis: basis ?? (numbers.length ? Object.freeze({unit:"%",value:0}) : "auto"),
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

/**
 * One layer of the background shorthand, its parts as text: the image, the
 * position (before a slash) and size (after it), the repeat style and a color.
 * Null when a token fits none of them.
 */
function parseBackgroundLayer(layer) {
  const tokens = [];
  let depth = 0;
  let token = "";
  for (const character of layer) {
    if (depth === 0 && (/\s/.test(character) || character === "/")) {
      if (token) tokens.push(token);
      if (character === "/") tokens.push("/");
      token = "";
      continue;
    }
    if (character === "(") depth++;
    else if (character === ")") depth--;
    token += character;
  }
  if (token) tokens.push(token);
  const result = { image: "none", position: "0% 0%", size: "auto", repeat: "repeat", color: null };
  const position = [];
  const size = [];
  const repeat = [];
  let afterSlash = false;
  for (const raw of tokens) {
    const lower = raw.toLowerCase();
    if (raw === "/") afterSlash = true;
    else if (BACKGROUND_IMAGE.test(raw)) result.image = raw;
    else if (lower === "none") result.image = "none";
    else if (BACKGROUND_REPEATS.has(lower)) repeat.push(lower);
    else if (BACKGROUND_BOXES.has(lower) || BACKGROUND_ATTACHMENTS.has(lower)) continue;
    else if (afterSlash && (lower === "cover" || lower === "contain" || lower === "auto" || /^-?[\d.]/.test(lower) || lower.startsWith("calc("))) size.push(lower);
    else if (["left", "right", "top", "bottom", "center"].includes(lower) || /^-?[\d.]/.test(lower) || lower.startsWith("calc(")) {
      afterSlash = false;
      position.push(lower);
    } else if (resolvedColor(raw, "light")) result.color = raw;
    else return null;
  }
  if (position.length) result.position = position.join(" ");
  if (size.length) result.size = size.join(" ");
  if (repeat.length) result.repeat = repeat.join(" ");
  return result;
}

/** A style sheet with each relative url() made absolute against the sheet's own URL. */
export function absolutizeStyleSheetUrls(text, base) {
  return text.replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (whole, quote, url) => {
    if (!url || /^(?:[a-z][a-z\d+.-]*:|#)/i.test(url)) return whole;
    try {
      return `url(${quote}${new URL(url, base).href}${quote})`;
    } catch {
      return whole;
    }
  });
}

function splitTopLevel(source, separator) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index++;
      else if (character === quote) quote = "";
    } else if (character === "\\") index++;
    else if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth++;
    else if (character === ")") depth--;
    else if ((character === separator || separator === " " && /\s/.test(character)) && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts;
}

function boxLengths(value, allowNegative, emSize, allowAuto, allowPercentage = false) {
  const parts = splitTopLevel(value.trim(), " ").filter(Boolean).map((part) =>
    allowAuto && part === "auto" ? "auto" : computedLength(part, emSize, allowPercentage));
  if (parts.length < 1 || parts.length > 4 || parts.some((part) =>
    part !== "auto" && !(allowPercentage && isLength(part) && typeof part === "object"
      && (allowNegative || !isPercentage(part) || part.value >= 0)) && (!Number.isFinite(part) || (!allowNegative && part < 0)))) return null;
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
