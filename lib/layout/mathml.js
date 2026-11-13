/**
 * MathML Core layout (https://w3c.github.io/mathml-core/): <math> is one box whose
 * descendants are laid out by the algorithms below, each placing its children around a
 * shared baseline. Layout returns {width, ascent, descent} and a paint closure; painting
 * emits ordinary text fragments, box records (so CSS backgrounds, borders and padding of
 * MathML elements work as on any element) and SVG runs for rules, radicals and stretched
 * delimiters.
 *
 * The row, fraction, radical, scripts, under/over, space and padded algorithms, the
 * fallback constants used when a font has no OpenType MATH table, the embellished
 * operator rules and the operator dictionary are ported from Chromium
 * (third_party/blink/renderer/core/layout/mathml/*.cc,
 * core/mathml/mathml_operator_element.cc and
 * platform/text/mathml_operator_dictionary.cc; Copyright 2019-2020 The Chromium
 * Authors, BSD-3-Clause, see THIRD_PARTY_NOTICES.md).
 *
 * The fonts this browser ships have no MATH table, so there are no glyph variants to
 * stretch with. Where Chromium would assemble a stretched delimiter, radical or large
 * operator from glyph parts, this draws vector paths instead, and a display-style large
 * operator is set at a larger font size; these are this project's own fallbacks.
 */

const MATH_UNIT = 1 / 18; // em per math unit (MathML Core kMathUnitFraction)
const SCRIPT_SCALE = 0.71; // scriptPercentScaleDown fallback per math-depth step
const X_HEIGHT = 0.5; // em, used where the font's x-height is not measured
const RULE = 0.05; // em, the default rule thickness (Roboto's underline thickness)
const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

const TOKENS = new Set(["mi", "mn", "mo", "ms", "mtext"]);
const GROUPING = new Set(["mrow", "mstyle", "merror", "mphantom", "semantics", "maction", "menclose", "math"]);
const SCRIPTS = new Set(["msub", "msup", "msubsup", "munder", "mover", "munderover", "mmultiscripts"]);

// ---------------------------------------------------------------------------
// Entry points used by text-layout.js

/** Lays out a math root box's content at (x, y); returns {bottom, baseline}. */
export function layoutMath(api, box, x, width, y) {
  assignOperatorForms(box.node.children);
  const env = rootEnv(box);
  const result = layoutRow(api, box.node, box.node.children, env, null);
  // Display math is centred in the available inline size (MathRowLayoutAlgorithm).
  const offset = box.node.type === "math-block" ? Math.max(0, (width - result.width) / 2) : 0;
  const baseline = y + result.ascent;
  result.paint(api, x + offset, baseline);
  return { bottom: y + result.ascent + result.descent, baseline };
}

/** The content width of a math root box: min-content and max-content are the same. */
export function mathContentWidth(api, box) {
  assignOperatorForms(box.node.children);
  return layoutRow(api, box.node, box.node.children, rootEnv(box), null).width;
}

function rootEnv(box) {
  const attrs = box.node.math ?? {};
  const display = box.node.type === "math-block" || String(attrs.displaystyle).toLowerCase() === "true";
  return { display, level: 0, cramped: false, scale: 1, phantom: false };
}

// ---------------------------------------------------------------------------
// Styles and lengths

const derived = new WeakMap();
// The node's computed style at its math-depth: computed font sizes are inherited
// unchanged by the cascade, so the script-level scale multiplies them here.
function styleOf(node, env, extra = null) {
  const base = node.style ?? {};
  const fontSize = (base.fontSize ?? 16) * env.scale;
  const key = `${fontSize}|${extra ? JSON.stringify(extra) : ""}`;
  let byKey = derived.get(base);
  if (!byKey) derived.set(base, byKey = new Map());
  let style = byKey.get(key);
  if (!style) {
    style = Object.freeze({ ...base, fontSize, ...(extra ?? {}), lineHeight: null });
    byKey.set(key, style);
  }
  return style;
}

// MathML Core lengths: a CSS length, or a percentage of `base`. Unitless and named
// spaces are not part of Core and are ignored (null).
export function mathLength(value, fontSize, base = null) {
  const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px|em|ex|pt|pc|in|cm|mm|q|%)?\s*$/i.exec(String(value ?? ""));
  if (!match) return null;
  const number = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase();
  switch (unit) {
    case "px": return number;
    case "em": return number * fontSize;
    case "ex": return number * fontSize * X_HEIGHT;
    case "pt": return number * 4 / 3;
    case "pc": return number * 16;
    case "in": return number * 96;
    case "cm": return number * 96 / 2.54;
    case "mm": return number * 96 / 25.4;
    case "q": return number * 96 / 101.6;
    case "%": return base == null ? null : number / 100 * base;
    default: return number === 0 ? 0 : null;
  }
}

const bool = (value) => value == null ? null : String(value).trim().toLowerCase() === "true" ? true
  : String(value).trim().toLowerCase() === "false" ? false : null;

// The math-depth and math-style a child starts from; MathML Core's UA stylesheet rules.
function childEnv(env, { level = 0, display = env.display, cramped = env.cramped } = {}) {
  return { ...env, level: env.level + level, scale: env.scale * SCRIPT_SCALE ** level, display, cramped };
}

// displaystyle and scriptlevel attributes (MathML Core §2.1.3), on any element.
function ownEnv(node, env) {
  const attrs = node.math ?? {};
  let next = env;
  const display = bool(attrs.displaystyle);
  if (display != null) next = { ...next, display };
  const level = /^\s*([+-]?)(\d+)\s*$/.exec(attrs.scriptlevel ?? "");
  if (level) {
    const target = level[1] ? next.level + (level[1] === "-" ? -1 : 1) * Number(level[2]) : Number(level[2]);
    next = { ...next, level: target, scale: next.scale * SCRIPT_SCALE ** (target - next.level) };
  }
  if (node.tagName === "mphantom") next = { ...next, phantom: true };
  return next;
}

// ---------------------------------------------------------------------------
// Results

function result(width, ascent, descent, paint, extra = {}) {
  return { width, ascent, descent, paint, ...extra };
}

const EMPTY = Object.freeze(result(0, 0, 0, () => {}));

// CSS padding and border on a MathML element surround its math content; its box record
// is what paints them (and its background), and what hit testing and geometry APIs read.
function boxed(api, node, env, inner) {
  const style = node.style;
  const padding = (style?.padding ?? [0, 0, 0, 0]).map((value) => Math.max(0, api.resolveLength(value, 0) || 0));
  const border = style?.borderWidths ?? [0, 0, 0, 0];
  const top = padding[0] + border[0], right = padding[1] + border[1];
  const bottom = padding[2] + border[2], left = padding[3] + border[3];
  return result(inner.width + left + right, inner.ascent + top, inner.descent + bottom, (api_, x, baseline) => {
    if (!env.phantom && node.id != null) {
      api_.boxes.push({
        nodeId: node.id,
        x,
        y: baseline - inner.ascent - top,
        width: inner.width + left + right,
        height: inner.ascent + inner.descent + top + bottom,
        style: style ? { ...style, padding, margin: [0, 0, 0, 0] } : style,
      });
    }
    inner.paint(api_, x + left, baseline);
  }, { op: inner.op, italic: inner.italic });
}

// ---------------------------------------------------------------------------
// Dispatch

// One layout pass measures a row's children before placing them, and limits measure
// their siblings; results are reused within the pass, so nesting stays linear.
function layoutNode(api, node, env, stretch) {
  const key = `${env.level}|${env.scale}|${env.display}|${env.cramped}|${env.phantom}|${stretch?.block ? `${stretch.block.ascent},${stretch.block.descent}` : ""}|${stretch?.inline ?? ""}`;
  let byNode = api.cache.get(node);
  if (!byNode) api.cache.set(node, byNode = new Map());
  let laid = byNode.get(key);
  if (!laid) byNode.set(key, laid = layoutUncached(api, node, env, stretch));
  return laid;
}

function layoutUncached(api, node, env, stretch) {
  const own = ownEnv(node, env);
  const tag = node.tagName;
  let inner;
  if (TOKENS.has(tag)) inner = tag === "mo" ? layoutOperator(api, node, own, stretch) : layoutToken(api, node, own);
  else if (tag === "mfrac") inner = node.children.length === 2 ? layoutFraction(api, node, own) : layoutRow(api, node, node.children, own, stretch);
  else if (tag === "msqrt") inner = layoutRadical(api, node, own, null);
  else if (tag === "mroot") inner = node.children.length === 2 ? layoutRadical(api, node, own, node.children[1]) : layoutRow(api, node, node.children, own, stretch);
  else if (SCRIPTS.has(tag) && validScripts(node)) inner = layoutScripts(api, node, own, stretch);
  else if (tag === "mspace") inner = layoutSpace(node, own);
  else if (tag === "mpadded") inner = layoutPadded(api, node, own, stretch);
  else if (tag === "mtable") inner = layoutTable(api, node, own);
  else inner = layoutRow(api, node, node.children, own, stretch);
  return boxed(api, node, own, inner);
}

function validScripts(node) {
  const count = node.children.length;
  switch (node.tagName) {
    case "msub": case "msup": case "munder": case "mover": return count === 2;
    case "msubsup": case "munderover": return count === 3;
    case "mmultiscripts": return count >= 1 && count % 2 === 1;
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Tokens

// mi with one character is italic unless mathvariant says otherwise (text-transform:
// math-auto in MathML Core; the italic face stands in for the Unicode math italic letters).
function tokenStyle(node, env) {
  const variant = String(node.math?.mathvariant ?? "").toLowerCase();
  if (node.tagName === "mi" && !variant && [...node.text].length === 1) return styleOf(node, env, { fontStyle: "italic" });
  if (variant === "italic") return styleOf(node, env, { fontStyle: "italic" });
  if (variant === "bold") return styleOf(node, env, { fontWeight: 700 });
  if (variant === "bold-italic") return styleOf(node, env, { fontWeight: 700, fontStyle: "italic" });
  if (variant === "normal") return styleOf(node, env, { fontStyle: "normal" });
  return styleOf(node, env);
}

// A text-only token is as tall as its glyphs' ink (MathTokenLayoutAlgorithm), not its
// line box; without ink extents from the renderer, the font's line metrics stand in.
function textBox(api, node, env, text, style) {
  const width = api.measure(text, style);
  const metrics = api.metrics(style, text);
  const ink = api.ink(text, style);
  const ascent = ink ? ink.ascent : metrics.ascent;
  const descent = ink ? ink.descent : metrics.height - metrics.ascent;
  return result(width, ascent, descent, (api_, x, baseline) => {
    if (env.phantom || !text) return;
    api_.text(node.id, style, text, x, baseline, width, metrics);
  });
}

function layoutToken(api, node, env) {
  if (!node.text) return EMPTY;
  return textBox(api, node, env, node.text, tokenStyle(node, env));
}

// ---------------------------------------------------------------------------
// Operators

const FORM_INFIX = 0, FORM_PREFIX = 1, FORM_POSTFIX = 2;
// Leading and trailing space in math units, and flags, per dictionary category
// (mathml_operator_element.cc MathMLOperatorDictionaryCategories).
const STRETCHY = 1, SYMMETRIC = 2, LARGEOP = 4, MOVABLELIMITS = 8;
const CATEGORIES = {
  none: [5, 5, 0], forceDefault: [5, 5, 0], A: [5, 5, STRETCHY], B: [4, 4, 0], C: [3, 3, 0], DorEorK: [0, 0, 0],
  ForG: [0, 0, STRETCHY | SYMMETRIC], H: [3, 3, SYMMETRIC | LARGEOP], I: [0, 0, STRETCHY],
  J: [3, 3, SYMMETRIC | LARGEOP | MOVABLELIMITS], L: [3, 0, 0], M: [0, 3, 0],
};

// mathml_operator_dictionary.cc kOperators2AsciiChars and kCompactDictionary.
const TWO_ASCII = ["!!", "!=", "&&", "**", "*=", "++", "+=", "--", "-=", "->", "//", "/=", ":=", "<=", "<>", "==", ">=", "||"];
const COMPACT = [
  [0x8025, 0], [0x802A, 0], [0x402B, 0], [0x402D, 0], [0x802E, 0], [0x402F, 0], [0x803F, 1], [0xC05C, 0], [0x805E, 0], [0xC05F, 0],
  [0x40B1, 0], [0x80B7, 0], [0x80D7, 0], [0x40F7, 0], [0x4322, 0], [0x8323, 0], [0x832E, 0], [0x8422, 0], [0x8443, 0], [0x4444, 0],
  [0xC461, 3], [0x0590, 5], [0x059A, 15], [0x05AA, 4], [0x05B0, 5], [0x05B9, 0], [0x05BC, 15], [0x05CC, 9], [0x05DA, 15], [0x05EA, 6],
  [0x05F3, 12], [0xC606, 0], [0x4612, 4], [0x8617, 2], [0x4627, 3], [0x4636, 0], [0x4638, 0], [0x8640, 0], [0x468C, 2], [0x4693, 3],
  [0x8697, 0], [0x4698, 0], [0x8699, 2], [0x469D, 2], [0x86A0, 1], [0x86BA, 0], [0x46BB, 2], [0x86C4, 3], [0x86C9, 3], [0x46CE, 1],
  [0x46D2, 1], [0x8705, 1], [0x0B94, 0], [0x4B95, 2], [0x0B99, 0], [0x0B9B, 6], [0x0BA5, 1], [0x0BA8, 7], [0x0BB1, 0], [0x0BB3, 0],
  [0x0BB5, 0], [0x0BB8, 0], [0x0BBA, 4], [0x8BCB, 0], [0x8BCD, 0], [0x0BF0, 1], [0x0BF4, 11], [0x0D00, 15], [0x0D10, 15], [0x0D20, 0],
  [0x0D34, 3], [0x0D42, 15], [0x0D52, 15], [0x0D62, 15], [0x0D72, 3], [0x0D7C, 3], [0x4DB8, 0], [0x4DBC, 0], [0x4DC4, 1], [0x8DC6, 2],
  [0x8DD4, 3], [0x8DE2, 0], [0x4DF5, 6], [0x8E1D, 1], [0x4E1F, 15], [0x8E2F, 8], [0x4E38, 2], [0x8E3B, 2], [0x4E3E, 0], [0x8E3F, 0],
  [0x4E40, 15], [0x8E50, 0], [0x4E51, 15], [0x4E61, 2], [0x8E64, 1], [0x4EDB, 0], [0x8EDC, 1], [0x4EF6, 0], [0x4EFB, 0], [0x4EFD, 0],
  [0x8EFE, 0], [0x0F04, 3], [0x0F0C, 5], [0x0F30, 14], [0x0F40, 12], [0x0F60, 5], [0x0F6A, 3], [0x0F70, 3], [0x0F7A, 3], [0x0F80, 7],
  [0x0F95, 0], [0x0FA0, 15], [0x0FB8, 0], [0x1021, 0], [0x5028, 0], [0x102B, 0], [0x102D, 0], [0x505B, 0], [0x507B, 1], [0x10AC, 0],
  [0x10B1, 0], [0x1331, 0], [0x5416, 0], [0x1418, 0], [0x141C, 0], [0x1600, 1], [0x1603, 1], [0x1607, 0], [0xD60F, 2], [0x1612, 1],
  [0x161F, 3], [0x962B, 8], [0x1634, 1], [0x163C, 0], [0x16BE, 1], [0xD6C0, 3], [0x5708, 0], [0x570A, 0], [0x1710, 0], [0x1719, 0],
  [0x5729, 0], [0x5B72, 0], [0x1B95, 1], [0x1BC0, 0], [0x5BE6, 0], [0x5BE8, 0], [0x5BEA, 0], [0x5BEC, 0], [0x5BEE, 0], [0x5D80, 0],
  [0x5D83, 0], [0x5D85, 0], [0x5D87, 0], [0x5D89, 0], [0x5D8B, 0], [0x5D8D, 0], [0x5D8F, 0], [0x5D91, 0], [0x5D93, 0], [0x5D95, 0],
  [0x5D97, 0], [0x5D99, 0], [0x1D9B, 15], [0x1DAB, 4], [0x5DD8, 0], [0x5DDA, 0], [0x5DFC, 0], [0xDE00, 10], [0x9E0B, 15], [0x9E1B, 1],
  [0xDE1D, 1], [0x1EEC, 1], [0xDEFC, 0], [0xDEFF, 0], [0x2021, 1], [0x2025, 2], [0x6029, 0], [0x605D, 0], [0xA05E, 1], [0x2060, 0],
  [0x607C, 1], [0xA07E, 0], [0x20A8, 0], [0xA0AF, 0], [0x20B0, 0], [0x20B2, 2], [0x20B8, 1], [0xA2C6, 1], [0xA2C9, 0], [0x22CA, 1],
  [0xA2CD, 0], [0x22D8, 2], [0xA2DC, 0], [0x22DD, 0], [0xA2F7, 0], [0xA302, 0], [0x2311, 0], [0x2320, 0], [0x2325, 0], [0x2327, 0],
  [0x2331, 0], [0x6416, 0], [0x2419, 2], [0x241D, 2], [0x2432, 5], [0xA43E, 0], [0x2457, 0], [0x24DB, 1], [0x6709, 0], [0x670B, 0],
  [0xA722, 1], [0x672A, 0], [0xA7B4, 1], [0x27CD, 0], [0xA7DC, 5], [0x6B73, 0], [0x6BE7, 0], [0x6BE9, 0], [0x6BEB, 0], [0x6BED, 0],
  [0x6BEF, 0], [0x6D80, 0], [0x6D84, 0], [0x6D86, 0], [0x6D88, 0], [0x6D8A, 0], [0x6D8C, 0], [0x6D8E, 0], [0x6D90, 0], [0x6D92, 0],
  [0x6D94, 0], [0x6D96, 0], [0x6D98, 1], [0x6DD9, 0], [0x6DDB, 0], [0x6DFD, 0],
];
const COMPACT_CATEGORY = { 0x0: "A", 0x4: "B", 0x8: "C", 0x1: "DorEorK", 0x2: "DorEorK", 0xC: "DorEorK", 0x5: "ForG", 0x6: "ForG", 0x9: "H", 0xA: "I", 0xD: "J" };

/** FindCategory from mathml_operator_dictionary.cc: the dictionary category of an operator. */
export function operatorCategory(content, form) {
  let key = 0;
  if (content.length === 1) {
    const character = content.charCodeAt(0);
    if (character < 0x0320 || character > 0x03FF) key = character;
  } else if (content.length === 2) {
    const codePoint = content.codePointAt(0);
    if (codePoint === 0x1EEF0 || codePoint === 0x1EEF1) return form === FORM_POSTFIX ? "I" : "none";
    const second = content.charCodeAt(1);
    if (second === 0x0338 || second === 0x20D2) key = content.charCodeAt(0);
    else {
      const index = TWO_ASCII.indexOf(content);
      if (index >= 0) key = 0x0320 + index;
    }
  }
  if (!key) return "none";
  if (form === FORM_INFIX && (key === 0x7C || key === 0x223C)) return "forceDefault";
  if (form === FORM_PREFIX && ((0x2145 <= key && key <= 0x2146) || key === 0x2202 || (0x221A <= key && key <= 0x221C))) return "L";
  if (form === FORM_INFIX && (key === 0x2C || key === 0x3A || key === 0x3B)) return "M";
  if (0x2000 <= key && key <= 0x2BFF) key -= 0x1C00;
  else if (key > 0x03FF) return "none";
  if (form === FORM_PREFIX) key |= 0x1000;
  else if (form === FORM_POSTFIX) key |= 0x2000;
  // upper_bound on the entry keys, then the entry before it.
  let low = 0, high = COMPACT.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (key < (COMPACT[middle][0] & 0x3FFF)) high = middle;
    else low = middle + 1;
  }
  if (low === 0) return "none";
  const [entry, delta] = COMPACT[low - 1];
  if (key > (entry & 0x3FFF) + delta) return "none";
  return COMPACT_CATEGORY[entry >> 12] ?? "none";
}

// The operator's own properties: its dictionary category for its form, overridden by
// its attributes (MathML Core §3.2.4.2, ComputeDictionaryCategory).
const operatorCache = new WeakMap();
function operatorProperties(node) {
  let properties = operatorCache.get(node);
  if (properties) return properties;
  const attrs = node.math ?? {};
  const text = node.text;
  const explicit = { prefix: FORM_PREFIX, infix: FORM_INFIX, postfix: FORM_POSTFIX }[String(attrs.form ?? "").toLowerCase()];
  let category = "none";
  if (text) {
    const form = explicit ?? forms.get(node) ?? FORM_INFIX;
    category = operatorCategory(text, form);
    if (category === "none" && explicit == null) {
      for (const fallback of [FORM_INFIX, FORM_POSTFIX, FORM_PREFIX]) {
        if (fallback === form) continue;
        category = operatorCategory(text, fallback);
        if (category !== "none") break;
      }
    }
  }
  const [lead, trail, flags] = CATEGORIES[category];
  const flag = (name, bit) => bool(attrs[name]) ?? Boolean(flags & bit);
  properties = {
    lspace: lead * MATH_UNIT, rspace: trail * MATH_UNIT,
    stretchy: flag("stretchy", STRETCHY), symmetric: flag("symmetric", SYMMETRIC),
    largeop: flag("largeop", LARGEOP), movablelimits: flag("movablelimits", MOVABLELIMITS),
    vertical: !HORIZONTAL.has(text),
  };
  operatorCache.set(node, properties);
  return properties;
}

// Operators that stretch along the inline axis (arrows, bars, horizontal braces and
// accents); every other operator stretches along the block axis.
const HORIZONTAL = new Set([..."_¯ˉ‾―─⎴⎵⏜⏝⏞⏟⏠⏡^~ˆ˜←→↔↚↛↮⇐⇒⇔↤↦↼↽⇀⇁⟵⟶⟷⟸⟹⟺⟻⟼⟽⟾⇄⇆⇋⇌↩↪↞↠"].concat(["̂", "̃", "̲", "−"]));

// Without a form attribute, an operator's form follows its position among its siblings
// (ComputeDictionaryCategory): first is prefix, last is postfix, otherwise infix.
const forms = new WeakMap();
function assignOperatorForms(children) {
  children.forEach((child, index) => {
    if (child.tagName === "mo" && !forms.has(child)) forms.set(child, children.length > 1 && index === 0 ? FORM_PREFIX
      : children.length > 1 && index === children.length - 1 ? FORM_POSTFIX : FORM_INFIX);
    if (child.children?.length) assignOperatorForms(child.children);
  });
}

// An embellished operator (MathML Core §3.2.4.1, GetCoreOperator) and space-like elements.
function spaceLike(node) {
  if (node.tagName === "mtext" || node.tagName === "mspace") return true;
  if (GROUPING.has(node.tagName) || node.tagName === "mpadded") return node.children.every(spaceLike);
  return false;
}
export function coreOperator(node) {
  if (!node) return null;
  if (node.tagName === "mo") return node;
  if (SCRIPTS.has(node.tagName) || node.tagName === "mfrac") return coreOperator(node.children[0]);
  if (GROUPING.has(node.tagName) || node.tagName === "mpadded") {
    let core = null;
    for (const child of node.children) {
      if (spaceLike(child)) continue;
      if (core) return null;
      core = coreOperator(child);
      if (!core) return null;
    }
    return core;
  }
  return null;
}

// lspace and rspace of an embellished operator, in px at its core operator's size.
function operatorSpacing(node, coreSize) {
  const core = coreOperator(node);
  if (!core) return null;
  const properties = operatorProperties(core);
  const attrs = core.math ?? {};
  const lspace = mathLength(attrs.lspace, coreSize, properties.lspace * coreSize) ?? properties.lspace * coreSize;
  const rspace = mathLength(attrs.rspace, coreSize, properties.rspace * coreSize) ?? properties.rspace * coreSize;
  return { ...properties, lspace: Math.max(0, lspace), rspace: Math.max(0, rspace) };
}

function layoutOperator(api, node, env, stretch) {
  if (!node.text) return EMPTY;
  const properties = operatorProperties(node);
  const fontSize = (node.style?.fontSize ?? 16) * env.scale;
  const style = tokenStyle(node, env);
  const axis = fontSize * X_HEIGHT / 2;
  const op = { size: fontSize, ...properties };
  // Display-style large operators (sums, integrals) are drawn larger and centred on the
  // math axis, as their MATH table display variants would be.
  if (properties.largeop && env.display) {
    const integral = /^[∫∬∭∮∯∰∱∲∳⨌⨍⨎⨏⨐⨑⨒⨓⨔⨕⨖⨗⨘⨙⨚⨛⨜]$/u.test(node.text);
    const big = styleOf(node, env, { fontSize: fontSize * (integral ? 1.8 : 1.4), fontStyle: "normal" });
    const glyph = textBox(api, node, env, node.text, big);
    const shift = (glyph.ascent - glyph.descent) / 2 - axis;
    return result(glyph.width, glyph.ascent - shift, glyph.descent + shift,
      (api_, x, baseline) => glyph.paint(api_, x, baseline + shift), { op });
  }
  const glyph = textBox(api, node, env, node.text, style);
  if (properties.stretchy && properties.vertical && stretch?.block) {
    let ascent = stretch.block.ascent, descent = stretch.block.descent;
    // Content no taller than the glyph keeps the glyph: centring on the axis alone
    // would otherwise make a fence around one line of text taller than the text.
    const contentHeight = ascent + descent;
    if (properties.symmetric) {
      const half = Math.max(ascent - axis, descent + axis);
      ascent = axis + half;
      descent = half - axis;
    }
    const attrs = node.math ?? {};
    const natural = glyph.ascent + glyph.descent;
    let target = ascent + descent;
    const min = mathLength(attrs.minsize, fontSize, natural);
    const max = mathLength(attrs.maxsize, fontSize, natural);
    if (min != null && target < min) target = min;
    if (max != null && target > max) target = max;
    const shape = DELIMITERS[node.text];
    if (shape && contentHeight > natural * 1.05 && target > natural * 1.05) {
      // Scale both sides of the axis to the clamped size.
      const ratio = target / Math.max(ascent + descent, 1e-6);
      ascent *= ratio;
      descent *= ratio;
      const width = Math.max(glyph.width, Math.min(fontSize * 0.75, fontSize * 0.28 + target * 0.08));
      return result(width, ascent, descent, (api_, x, baseline) => {
        if (env.phantom) return;
        api_.shape(node.id, style, x, baseline - ascent, width, ascent + descent, shape(width, ascent + descent, ruleWidth(fontSize) * 1.3));
      }, { op });
    }
    // A glyph that cannot be stretched keeps its size, centred on the stretch target's axis.
    return result(glyph.width, glyph.ascent, glyph.descent, glyph.paint, { op });
  }
  if (properties.stretchy && !properties.vertical && stretch?.inline != null) {
    const shape = HORIZONTAL_SHAPES[node.text];
    if (shape && stretch.inline > glyph.width * 1.05) {
      const width = stretch.inline;
      const height = shape.height * fontSize;
      return result(width, height + shape.raise * fontSize, -shape.raise * fontSize, (api_, x, baseline) => {
        if (env.phantom) return;
        const top = baseline - height - shape.raise * fontSize;
        api_.shape(node.id, style, x, top, width, height, shape.path(width, height, ruleWidth(fontSize) * 1.2));
      }, { op });
    }
  }
  return result(glyph.width, glyph.ascent, glyph.descent, glyph.paint, { op });
}

const ruleWidth = (fontSize) => Math.max(1, fontSize * RULE);

// Stretched delimiters as stroked paths in a w x h box, t being the stroke width.
const mirror = (draw) => (w, h, t) => ({ ...draw(w, h, t), mirror: true });
const stroke = (d, t, join = "round", cap = "round") => ({ d, stroke: true, width: t, join, cap });
const paren = (w, h, t) => {
  const r = w - t, l = t * 0.9 + w * 0.12;
  return stroke(`M${r} ${t / 2}C${l} ${h * 0.22} ${l} ${h * 0.78} ${r} ${h - t / 2}`, t);
};
const bracket = (w, h, t) => {
  const r = w - t / 2, l = t / 2 + w * 0.2;
  return stroke(`M${r} ${t / 2}H${l}V${h - t / 2}H${r}`, t, "miter", "butt");
};
const brace = (w, h, t) => {
  const r = w - t / 2, c = w / 2, l = t / 2, m = h / 2, k = Math.min(w * 0.6, h * 0.12);
  return stroke(`M${r} ${t / 2}C${c} ${t / 2} ${c} ${t / 2} ${c} ${k}L${c} ${m - k}C${c} ${m} ${c} ${m} ${l} ${m}C${c} ${m} ${c} ${m} ${c} ${m + k}L${c} ${h - k}C${c} ${h - t / 2} ${c} ${h - t / 2} ${r} ${h - t / 2}`, t);
};
const bar = (w, h, t) => stroke(`M${w / 2} 0V${h}`, t, "miter", "butt");
const doubleBar = (w, h, t) => stroke(`M${w * 0.32} 0V${h}M${w * 0.68} 0V${h}`, t, "miter", "butt");
const angle = (w, h, t) => stroke(`M${w - t} ${t / 2}L${t + w * 0.1} ${h / 2}L${w - t} ${h - t / 2}`, t, "miter");
const floor = (w, h, t) => stroke(`M${t / 2 + w * 0.2} 0V${h - t / 2}H${w - t / 2}`, t, "miter", "butt");
const ceil = (w, h, t) => stroke(`M${w - t / 2} ${t / 2}H${t / 2 + w * 0.2}V${h}`, t, "miter", "butt");
const slash = (w, h, t) => stroke(`M${w - t} 0L${t} ${h}`, t, "miter", "butt");
const DELIMITERS = {
  "(": paren, ")": mirror(paren), "[": bracket, "]": mirror(bracket), "{": brace, "}": mirror(brace),
  "|": bar, "∣": bar, "‖": doubleBar, "∥": doubleBar, "⟨": angle, "〈": angle, "⟩": mirror(angle), "〉": mirror(angle),
  "⌊": floor, "⌋": mirror(floor), "⌈": ceil, "⌉": mirror(ceil), "/": slash, "\\": mirror(slash),
};
const hBrace = (flip) => (w, h, t) => {
  const y0 = flip ? h - t / 2 : t / 2, y1 = flip ? t / 2 : h - t / 2, c = w / 2, k = Math.min(h, w / 4);
  return stroke(`M${t / 2} ${y0}C${t / 2} ${y1} ${t / 2} ${y1} ${k} ${y1}L${c - k} ${y1}C${c} ${y1} ${c} ${y1} ${c} ${y0}C${c} ${y1} ${c} ${y1} ${c + k} ${y1}L${w - k} ${y1}C${w - t / 2} ${y1} ${w - t / 2} ${y1} ${w - t / 2} ${y0}`, t);
};
const hArrow = (left, right) => (w, h, t) => {
  const m = h / 2, head = Math.min(w / 3, h * 1.2);
  let d = `M${t / 2} ${m}H${w - t / 2}`;
  if (right) d += `M${w - head} ${t / 2}L${w - t / 2} ${m}L${w - head} ${h - t / 2}`;
  if (left) d += `M${head} ${t / 2}L${t / 2} ${m}L${head} ${h - t / 2}`;
  return stroke(d, t);
};
const hBar = (w, h, t) => stroke(`M0 ${h / 2}H${w}`, t, "miter", "butt");
const HORIZONTAL_SHAPES = {
  "⏞": { path: hBrace(false), height: 0.45, raise: 0.25 }, "⏟": { path: hBrace(true), height: 0.45, raise: -0.1 },
  "→": { path: hArrow(false, true), height: 0.45, raise: 0.05 }, "⟶": { path: hArrow(false, true), height: 0.45, raise: 0.05 },
  "←": { path: hArrow(true, false), height: 0.45, raise: 0.05 }, "⟵": { path: hArrow(true, false), height: 0.45, raise: 0.05 },
  "↔": { path: hArrow(true, true), height: 0.45, raise: 0.05 }, "⟷": { path: hArrow(true, true), height: 0.45, raise: 0.05 },
  "‾": { path: hBar, height: 0.15, raise: 0.3 }, "¯": { path: hBar, height: 0.15, raise: 0.3 }, "―": { path: hBar, height: 0.15, raise: 0.3 },
  "_": { path: hBar, height: 0.15, raise: -0.1 },
};

// ---------------------------------------------------------------------------
// Rows (MathRowLayoutAlgorithm)

function layoutRow(api, node, children, env, stretch) {
  if (!children.length) return EMPTY;
  const isRoot = node.type === "math" || node.type === "math-block";
  const addSpace = isRoot || !coreOperator(node);
  const stretchyInBlock = (child) => {
    const core = coreOperator(child);
    if (!core) return false;
    const properties = operatorProperties(core);
    return properties.stretchy && properties.vertical;
  };
  // Block stretch target: the extent of the row's non-stretchy children, unless one is
  // inherited from an enclosing row (this row is then an embellished operator).
  let target = stretch?.block ?? null;
  if (!target) {
    let ascent = 0, descent = 0, found = false;
    for (const child of children) {
      if (stretchyInBlock(child)) continue;
      const measured = layoutNode(api, child, env, null);
      ascent = Math.max(ascent, measured.ascent);
      descent = Math.max(descent, measured.descent);
      found = true;
    }
    target = found ? { ascent, descent } : { ascent: 0, descent: 0 };
  }
  const placed = [];
  let inline = 0, ascent = 0, descent = 0;
  for (const child of children) {
    const childStretch = stretchyInBlock(child) ? { block: target } : stretch?.inline != null ? { inline: stretch.inline } : null;
    const laid = layoutNode(api, child, env, childStretch);
    let lspace = 0, rspace = 0;
    if (addSpace && laid.op) {
      const spacing = operatorSpacing(child, laid.op.size);
      if (spacing) ({ lspace, rspace } = spacing);
    }
    inline += lspace;
    placed.push({ laid, x: inline });
    inline += laid.width + rspace;
    ascent = Math.max(ascent, laid.ascent);
    descent = Math.max(descent, laid.descent);
  }
  const op = coreOperator(node) ? placed.find((item) => item.laid.op)?.laid.op : undefined;
  return result(Math.max(0, inline), ascent, descent, (api_, x, baseline) => {
    for (const item of placed) item.laid.paint(api_, x + item.x, baseline);
  }, { op });
}

// ---------------------------------------------------------------------------
// Fractions (MathFractionLayoutAlgorithm)

function layoutFraction(api, node, env) {
  const fontSize = (node.style?.fontSize ?? 16) * env.scale;
  const display = env.display;
  // mfrac > * { math-depth: auto-add; math-style: compact } and the denominator is cramped.
  const inner = childEnv(env, { level: display ? 0 : 1, display: false });
  const numerator = layoutNode(api, node.children[0], inner, null);
  const denominator = layoutNode(api, node.children[1], { ...inner, cramped: true }, null);
  const rule = ruleWidth(fontSize);
  const defaultThickness = rule;
  const thickness = Math.max(0, mathLength(node.math?.linethickness, fontSize, defaultThickness) ?? defaultThickness);
  const axis = fontSize * X_HEIGHT / 2;
  let numeratorShift, denominatorShift;
  if (thickness) {
    const gapNumerator = (display ? 3 : 1) * rule;
    const gapDenominator = gapNumerator;
    numeratorShift = axis + thickness / 2 + gapNumerator + numerator.descent;
    denominatorShift = thickness / 2 + gapDenominator + denominator.ascent - axis;
  } else {
    const gapMin = (display ? 7 : 3) * rule;
    numeratorShift = 0;
    denominatorShift = 0;
    const gap = denominatorShift - denominator.ascent + numeratorShift - numerator.descent;
    if (gap < gapMin) {
      const diff = gapMin - gap;
      const delta = diff / 2;
      numeratorShift += delta;
      denominatorShift += diff - delta;
    }
  }
  const ascent = Math.max(0, Math.max(numeratorShift + numerator.ascent, -denominatorShift + denominator.ascent));
  const descent = Math.max(0, Math.max(-numeratorShift + numerator.descent, denominatorShift + denominator.descent));
  const width = Math.max(numerator.width, denominator.width);
  return result(width, ascent, descent, (api_, x, baseline) => {
    numerator.paint(api_, x + (width - numerator.width) / 2, baseline - numeratorShift);
    denominator.paint(api_, x + (width - denominator.width) / 2, baseline + denominatorShift);
    if (thickness && !env.phantom) api_.rule(node.id, node.style, x, baseline - axis - thickness / 2, width, thickness);
  }, { op: numerator.op });
}

// ---------------------------------------------------------------------------
// Radicals (MathRadicalLayoutAlgorithm)

function layoutRadical(api, node, env, indexNode) {
  const fontSize = (node.style?.fontSize ?? 16) * env.scale;
  const display = env.display;
  const rule = ruleWidth(fontSize);
  const xHeight = fontSize * X_HEIGHT;
  const thickness = rule;
  const gap = display ? rule + xHeight / 4 : 5 * rule / 4;
  const extraAscender = thickness;
  // msqrt, mroot { math-shift: compact }; msqrt's children are an inferred mrow.
  const baseEnv = { ...env, cramped: true };
  const base = indexNode ? layoutNode(api, node.children[0], baseEnv, null)
    : layoutRow(api, node, node.children, baseEnv, null);
  let index = null, kernBefore = 0, kernAfter = 0;
  if (indexNode) {
    index = layoutNode(api, indexNode, childEnv(env, { level: 2, display: false }), null);
    kernBefore = Math.max(0, 5 * fontSize * MATH_UNIT);
    kernAfter = Math.max(-10 * fontSize * MATH_UNIT, -index.width);
  }
  // The surd spans the base, the gap and the rule; its width grows slowly with height.
  const surdHeight = base.ascent + base.descent + gap + thickness;
  const surdWidth = fontSize * 0.55 + Math.min(fontSize * 0.35, surdHeight * 0.06);
  const radicalAscent = base.ascent + gap + thickness + extraAscender;
  let ascent = radicalAscent;
  let descent = Math.max(base.descent, surdHeight + extraAscender - ascent);
  const indexWidth = index ? index.width : 0;
  const raise = 0.6 * surdHeight;
  if (index) {
    ascent = Math.max(ascent, -descent + raise + index.descent + index.ascent);
    descent = Math.max(descent, descent - raise + index.descent + index.ascent);
  }
  const surdX = indexWidth + kernBefore + kernAfter;
  const width = surdX + surdWidth + base.width;
  return result(width, ascent, descent, (api_, x, baseline) => {
    base.paint(api_, x + surdX + surdWidth, baseline);
    if (index) index.paint(api_, x + kernBefore, baseline + descent - raise - index.descent);
    if (env.phantom) return;
    const top = baseline - (radicalAscent - extraAscender);
    api_.shape(node.id, node.style, x + surdX, top, surdWidth, surdHeight, surd(surdWidth, surdHeight, thickness));
    api_.rule(node.id, node.style, x + surdX + surdWidth - thickness / 2, top, base.width + thickness / 2, thickness);
  });
}

// A radical sign drawn to the top of the overbar at the right edge.
function surd(w, h, t) {
  return {
    d: `M0 ${h * 0.58}L${w * 0.22} ${h * 0.48}L${w * 0.52} ${h - t / 2}L${w - t / 2} ${t / 2}`,
    stroke: true, width: t * 1.15, join: "miter", cap: "butt",
  };
}

// ---------------------------------------------------------------------------
// Scripts (MathScriptsLayoutAlgorithm) and limits (MathUnderOverLayoutAlgorithm)

function layoutScripts(api, node, env, stretch) {
  const tag = node.tagName;
  const underOver = tag === "munder" || tag === "mover" || tag === "munderover";
  if (underOver) {
    const base = node.children[0];
    const core = coreOperator(base);
    const asScripts = !env.display && core && operatorProperties(core).movablelimits;
    if (!asScripts) return layoutUnderOver(api, node, env, stretch);
  }
  const fontSize = (node.style?.fontSize ?? 16) * env.scale;
  const xHeight = fontSize * X_HEIGHT;
  const parameters = {
    subShift: xHeight / 3, supShift: xHeight, supShiftCramped: xHeight, subDrop: xHeight / 2, supDrop: xHeight / 2,
    gapMin: fontSize / 5, supBottomMin: xHeight / 4, subTopMax: 4 * xHeight / 5, supBottomMaxWithSub: 4 * xHeight / 5,
  };
  const type = { msub: "sub", munder: "sub", msup: "sup", mover: "sup", msubsup: "subsup", munderover: "subsup", mmultiscripts: "multi" }[tag];
  const scriptEnv = childEnv(env, { level: 1, display: false });
  const base = layoutNode(api, node.children[0], env, stretch);
  // The pairs: msub/munder have a sub, msup/mover a sup; munderover's under is the sub.
  const pairs = [];
  if (type === "sub") pairs.push({ sub: layoutNode(api, node.children[1], { ...scriptEnv, cramped: true }, null), sup: null });
  else if (type === "sup") pairs.push({ sub: null, sup: layoutNode(api, node.children[1], scriptEnv, null) });
  else if (type === "subsup") pairs.push({
    sub: layoutNode(api, node.children[1], { ...scriptEnv, cramped: true }, null),
    sup: layoutNode(api, node.children[2], scriptEnv, null),
  });
  else {
    for (let index = 1; index + 1 < node.children.length; index += 2) pairs.push({
      sub: layoutNode(api, node.children[index], { ...scriptEnv, cramped: true }, null),
      sup: layoutNode(api, node.children[index + 1], scriptEnv, null),
    });
  }
  let subShift = 0, supShift = 0, ascent = 0, descent = 0;
  const shiftUp = env.cramped ? parameters.supShiftCramped : parameters.supShift;
  if (type === "sub") {
    descent = pairs[0].sub.descent;
    subShift = Math.max(parameters.subShift, base.descent + parameters.subDrop, pairs[0].sub.ascent - parameters.subTopMax);
  } else if (type === "sup") {
    ascent = pairs[0].sup.ascent;
    supShift = Math.max(shiftUp, base.ascent - parameters.supDrop, parameters.supBottomMin + pairs[0].sup.descent);
  } else {
    for (const pair of pairs) {
      const sub = pair.sub ?? EMPTY, sup = pair.sup ?? EMPTY;
      ascent = Math.max(ascent, sup.ascent);
      descent = Math.max(descent, sub.descent);
      let subScriptShift = Math.max(parameters.subShift, base.descent + parameters.subDrop, sub.ascent - parameters.subTopMax);
      let supScriptShift = Math.max(shiftUp, base.ascent - parameters.supDrop, parameters.supBottomMin + sup.descent);
      let gap = (subScriptShift - sub.ascent) + (supScriptShift - sup.descent);
      if (gap < parameters.gapMin) {
        // First push the superscript up, then the subscript down.
        let delta = parameters.supBottomMaxWithSub - (supScriptShift - sup.descent);
        if (delta > 0) {
          delta = Math.min(delta, parameters.gapMin - gap);
          supScriptShift += delta;
          gap += delta;
        }
        if (gap < parameters.gapMin) subScriptShift += parameters.gapMin - gap;
      }
      subShift = Math.max(subShift, subScriptShift);
      supShift = Math.max(supShift, supScriptShift);
    }
  }
  const totalAscent = Math.max(0, Math.max(base.ascent, ascent + supShift));
  const totalDescent = Math.max(0, Math.max(base.descent, descent + subShift));
  const space = fontSize / 5;
  let width = base.width;
  const placed = [];
  for (const pair of pairs) {
    const pairWidth = Math.max(pair.sub?.width ?? 0, pair.sup?.width ?? 0);
    placed.push({ pair, x: width });
    width += pairWidth + space;
  }
  return result(width, totalAscent, totalDescent, (api_, x, baseline) => {
    base.paint(api_, x, baseline);
    for (const { pair, x: offset } of placed) {
      if (pair.sub) pair.sub.paint(api_, x + offset, baseline + subShift);
      if (pair.sup) pair.sup.paint(api_, x + offset, baseline - supShift);
    }
  }, { op: base.op });
}

function layoutUnderOver(api, node, env, stretch) {
  const tag = node.tagName;
  const fontSize = (node.style?.fontSize ?? 16) * env.scale;
  const rule = ruleWidth(fontSize);
  const attrs = node.math ?? {};
  const accent = tag !== "munder" && bool(attrs.accent) === true;
  const accentUnder = tag !== "mover" && bool(attrs.accentunder) === true;
  const baseNode = node.children[0];
  const underNode = tag === "mover" ? null : node.children[1];
  const overNode = tag === "munder" ? null : tag === "mover" ? node.children[1] : node.children[2];
  const baseCore = coreOperator(baseNode);
  const baseProperties = baseCore ? operatorProperties(baseCore) : null;
  const largeOp = Boolean(baseProperties?.largeop);
  const baseStretchyInline = Boolean(baseProperties?.stretchy && !baseProperties.vertical);
  const barFallback = !largeOp && !baseStretchyInline;
  const parameters = barFallback
    ? { underGap: 3 * rule, overGap: 3 * rule, underShift: 0, overShift: 0, underExtra: rule, overExtra: rule, accentBase: fontSize * X_HEIGHT / 2 }
    // No MATH table: Chromium's limit and stretch-stack constants fall back to zero;
    // a small gap keeps limits off the operator.
    : { underGap: rule * 2, overGap: rule * 2, underShift: 0, overShift: 0, underExtra: 0, overExtra: 0, accentBase: 0 };
  // munder > :not(:first-child) { math-depth: add(1) } unless it is an accent.
  const scriptEnv = (isAccent) => isAccent ? { ...env, display: false } : childEnv(env, { level: 1, display: false });
  const horizontalStretchy = (child) => {
    const core = coreOperator(child);
    return core && operatorProperties(core).stretchy && !operatorProperties(core).vertical;
  };
  // The inline stretch target is the widest child that does not stretch inline.
  const children = [baseNode, underNode, overNode].filter(Boolean);
  let inlineTarget = 0;
  for (const child of children) {
    if (horizontalStretchy(child)) continue;
    const childEnv_ = child === baseNode ? { ...env, cramped: env.cramped || accent } : scriptEnv(child === overNode ? accent : accentUnder);
    inlineTarget = Math.max(inlineTarget, layoutNode(api, child, childEnv_, null).width);
  }
  const lay = (child, childEnv_) => layoutNode(api, child, childEnv_,
    horizontalStretchy(child) ? { inline: inlineTarget } : child === baseNode ? stretch : null);
  // mover[accent=true] > :first-child { math-shift: compact }
  const base = lay(baseNode, { ...env, cramped: env.cramped || accent });
  const under = underNode ? lay(underNode, scriptEnv(accentUnder)) : null;
  const over = overNode ? lay(overNode, scriptEnv(accent)) : null;
  const width = Math.max(base.width, under?.width ?? 0, over?.width ?? 0);
  let ascent = 0;
  let overTop = 0;
  if (over) {
    ascent += parameters.overExtra;
    overTop = ascent;
    if (barFallback) {
      ascent += over.ascent + over.descent;
      if (accent) {
        if (base.ascent < parameters.accentBase) ascent += parameters.accentBase - base.ascent;
      } else ascent += parameters.overGap;
    } else ascent += Math.max(over.ascent + over.descent + parameters.overGap, over.ascent + parameters.overShift);
  }
  const baseTop = ascent;
  ascent = Math.max(0, ascent + base.ascent);
  let descent = base.descent;
  let underTop = 0;
  if (under) {
    if (barFallback) {
      if (!accentUnder) descent += parameters.underGap;
    } else descent += Math.max(parameters.underGap, parameters.underShift - under.ascent);
    underTop = ascent + descent;
    descent += under.ascent + under.descent + parameters.underExtra;
  }
  descent = Math.max(0, descent);
  return result(width, ascent, descent, (api_, x, baseline) => {
    const top = baseline - ascent;
    if (over) over.paint(api_, x + (width - over.width) / 2, top + overTop + over.ascent);
    base.paint(api_, x + (width - base.width) / 2, top + baseTop + base.ascent);
    if (under) under.paint(api_, x + (width - under.width) / 2, top + underTop + under.ascent);
  }, { op: base.op });
}

// ---------------------------------------------------------------------------
// mspace (MathSpaceLayoutAlgorithm) and mpadded (MathPaddedLayoutAlgorithm)

function layoutSpace(node, env) {
  const fontSize = (node.style?.fontSize ?? 16) * env.scale;
  const attrs = node.math ?? {};
  const width = mathLength(attrs.width, fontSize) ?? 0;
  const height = Math.max(0, mathLength(attrs.height, fontSize) ?? 0);
  const depth = Math.max(0, mathLength(attrs.depth, fontSize) ?? 0);
  return result(width, height, depth, () => {});
}

function layoutPadded(api, node, env, stretch) {
  const fontSize = (node.style?.fontSize ?? 16) * env.scale;
  const content = layoutRow(api, node, node.children, env, stretch);
  const attrs = node.math ?? {};
  const width = Math.max(0, mathLength(attrs.width, fontSize, content.width) ?? content.width);
  const ascent = Math.max(0, mathLength(attrs.height, fontSize, content.ascent) ?? content.ascent);
  const descent = Math.max(0, mathLength(attrs.depth, fontSize, content.descent) ?? content.descent);
  const lspace = mathLength(attrs.lspace, fontSize, content.width) ?? 0;
  const voffset = mathLength(attrs.voffset, fontSize, 0) ?? 0;
  return result(width, ascent, descent, (api_, x, baseline) => content.paint(api_, x + lspace, baseline - voffset), { op: content.op });
}

// ---------------------------------------------------------------------------
// mtable: a table centred on the math axis (MathML Core §3.5.1; MathTableBaseline).

function layoutTable(api, node, env) {
  const fontSize = (node.style?.fontSize ?? 16) * env.scale;
  // mtable { math-style: compact }
  const cellEnv = { ...env, display: false };
  const rows = node.children.map((row) => row.tagName === "mtr" ? row.children.map((cell) => ({ cell, row })) : [{ cell: row, row: null }]);
  const laid = rows.map((cells) => cells.map(({ cell }) => {
    const content = cell.tagName === "mtd" ? layoutRow(api, cell, cell.children, cellEnv, null) : layoutNode(api, cell, cellEnv, null);
    // The cell's own box (padding, border, background) wraps its content.
    return { node: cell, box: cell.tagName === "mtd" ? boxed(api, cell, cellEnv, content) : content, align: cellAlign(cell) };
  }));
  const columns = Math.max(0, ...laid.map((cells) => cells.length));
  const columnWidths = Array.from({ length: columns }, (_, column) =>
    Math.max(0, ...laid.map((cells) => cells[column]?.box.width ?? 0)));
  const rowMetrics = laid.map((cells) => ({
    ascent: Math.max(0, ...cells.map((item) => item.box.ascent)),
    descent: Math.max(0, ...cells.map((item) => item.box.descent)),
  }));
  const height = rowMetrics.reduce((sum, row) => sum + row.ascent + row.descent, 0);
  const width = columnWidths.reduce((sum, value) => sum + value, 0);
  const axis = fontSize * X_HEIGHT / 2;
  const ascent = height / 2 + axis;
  const descent = height - ascent;
  return result(width, ascent, descent, (api_, x, baseline) => {
    let y = baseline - ascent;
    laid.forEach((cells, rowIndex) => {
      const row = rowMetrics[rowIndex];
      const rowBaseline = y + row.ascent;
      let cellX = x;
      cells.forEach((item, column) => {
        const columnWidth = columnWidths[column];
        const free = columnWidth - item.box.width;
        const offset = item.align === "left" ? 0 : item.align === "right" ? free : free / 2;
        item.box.paint(api_, cellX + offset, rowBaseline);
        cellX += columnWidth;
      });
      y += row.ascent + row.descent;
    });
  });
}

function cellAlign(cell) {
  const align = cell.style?.textAlign;
  if (align === "left" || align === "start") return "left";
  if (align === "right" || align === "end") return "right";
  return "center";
}

// ---------------------------------------------------------------------------
// Paint helpers handed to the algorithms above

/** The paint API over a layout context: text runs, rules and shapes. */
export function mathPaintApi(ctx, lineFragment, resolveLength) {
  const api = {
    cache: new Map(),
    measure: ctx.measure,
    metrics: ctx.metrics,
    ink: ctx.ink,
    resolveLength,
    get boxes() { return ctx.boxes; },
    text(nodeId, style, text, x, baseline, width, metrics) {
      const top = baseline - metrics.ascent;
      ctx.fragments.push(lineFragment(style, text, [nodeId], [{
        nodeId, text, start: 0, end: text.length, sourceStart: 0, style, x, y: top, width, height: null,
      }], x, top, width, metrics.height, baseline));
    },
    rule(nodeId, style, x, y, width, height) {
      if (!(width > 0 && height > 0)) return;
      const color = style?.color ?? "rgba(0, 0, 0, 1)";
      api.svg(nodeId, style, x, y, width, height, [svgShape(`M0 0H${width}V${height}H0Z`, color, null, 0)]);
    },
    shape(nodeId, style, x, y, width, height, shape) {
      const color = style?.color ?? "rgba(0, 0, 0, 1)";
      // Strokes reach half their width past the path; widen the box so the clip keeps them.
      const pad = shape.width ?? 0;
      let d = shape.d;
      if (shape.mirror) d = mirrorPath(d, width);
      const moved = translatePath(d, pad, pad);
      api.svg(nodeId, style, x - pad, y - pad, width + pad * 2, height + pad * 2, [
        svgShape(moved, shape.stroke ? null : color, shape.stroke ? color : null, shape.width ?? 0, shape.join, shape.cap),
      ]);
    },
    svg(nodeId, style, x, y, width, height, shapes) {
      const svg = Object.freeze({
        viewBox: Object.freeze([0, 0, width, height]), preserveAspectRatio: "none",
        width, height, shapes: Object.freeze(shapes),
      });
      ctx.fragments.push(lineFragment(style, "", [nodeId], [{
        nodeId, type: "image", text: "", start: 0, end: 0, style, x, y, width, height, resource: null, svg,
      }], x, y, width, height));
    },
  };
  return api;
}

function svgShape(d, fill, stroke_, strokeWidth, join = "miter", cap = "butt") {
  return Object.freeze({
    d, fill, stroke: stroke_, strokeWidth, fillRule: "nonzero", fillOpacity: 1, strokeOpacity: 1,
    matrix: IDENTITY, clips: Object.freeze([]), layers: Object.freeze([]), lineCap: cap, lineJoin: join,
    miterLimit: 4, dash: null, dashOffset: 0,
  });
}

// Paths here use only absolute M, L, H, V, C and Z commands with number pairs.
function mapPath(d, mapX, mapY) {
  const out = [];
  const re = /([MLHVCZ])([^MLHVCZ]*)/g;
  let match;
  while ((match = re.exec(d))) {
    const [, command, args] = match;
    const numbers = args.trim() ? args.trim().split(/[\s,]+/).map(Number) : [];
    if (command === "H") out.push(`H${numbers.map(mapX).join(" ")}`);
    else if (command === "V") out.push(`V${numbers.map(mapY).join(" ")}`);
    else if (command === "Z") out.push("Z");
    else out.push(command + numbers.map((value, index) => index % 2 ? mapY(value) : mapX(value)).join(" "));
  }
  return out.join("");
}
const mirrorPath = (d, width) => mapPath(d, (x) => width - x, (y) => y);
const translatePath = (d, dx, dy) => mapPath(d, (x) => x + dx, (y) => y + dy);
