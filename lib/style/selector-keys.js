/**
 * The keys a stylesheet selector is indexed by (see RuleIndex in
 * computed-style.js): the subject compound's bucket keys, and the keys its
 * ancestors must carry for the ancestor filter.
 *
 * Selectors are scanned by character code and position: names are cut out
 * of the selector only for the keys returned, without regular expressions or
 * intermediate substrings, as tens of thousands of selectors are indexed for
 * every new document.
 */

const BACKSLASH = 0x5c, QUOTE = 0x22, APOSTROPHE = 0x27, OPEN_PAREN = 0x28, CLOSE_PAREN = 0x29;
const OPEN_BRACKET = 0x5b, CLOSE_BRACKET = 0x5d, SPACE = 0x20, TAB = 0x09, LINE_FEED = 0x0a, CARRIAGE_RETURN = 0x0d;
const FORM_FEED = 0x0c, GREATER = 0x3e, PLUS = 0x2b, TILDE = 0x7e, HASH = 0x23, PERIOD = 0x2e, COLON = 0x3a;
const COMMA = 0x2c, PIPE = 0x7c, HYPHEN = 0x2d, UNDERSCORE = 0x5f;

// The selector being analyzed; the functions below take positions in it.
let text = "";

// Scratch results, reused instead of allocated per selector and compound:
// one per level of :is() nesting, as an outer result stays in use while the
// alternatives inside it are analyzed.
const partsPool = [];
const keysPool = [];

function scratchParts(level) {
  const parts = partsPool[level] ??= { starts: [], ends: [], combinators: [] };
  parts.starts.length = parts.ends.length = parts.combinators.length = 0;
  return parts;
}

function scratchKeys(level) {
  const keys = keysPool[level] ??= { ids: [], classes: [], attrs: [], tag: [], pseudo: [] };
  keys.ids.length = keys.classes.length = keys.attrs.length = keys.tag.length = keys.pseudo.length = 0;
  return keys;
}

/**
 * A selector's index keys. `subject` is null when the selector is not
 * understood or its subject has no key (the rule then goes to the universal
 * bucket); `ancestors` lists filter keys: "tag", "#id", ".class", "[attr".
 * @returns {{ subject: { kind: "id" | "class" | "attr" | "tag", name: string }[] | null, ancestors: string[] }}
 */
export function selectorKeys(selector) {
  text = selector;
  const parts = selectorParts(0, selector.length, 0);
  if (!parts) return { subject: null, ancestors: [] };
  const last = parts.starts.length - 1;
  const subject = subjectKeys(parts.starts[last], parts.ends[last], 1);
  const ancestors = new Set();
  for (let index = 0; index < last; index++) {
    // Only compounds whose right-hand combinator is descendant or child are
    // ancestors of the subject (a sibling's parent is the subject's parent).
    const combinator = parts.combinators[index];
    if (combinator !== SPACE && combinator !== GREATER) continue;
    const keys = compoundKeys(parts.starts[index], parts.ends[index], 0);
    if (keys.tag.length) ancestors.add(name(keys.tag, true));
    for (let at = 0; at < keys.ids.length; at += 3) ancestors.add(`#${name(keys.ids, false, at)}`);
    for (let at = 0; at < keys.classes.length; at += 3) ancestors.add(`.${name(keys.classes, false, at)}`);
    for (let at = 0; at < keys.attrs.length; at += 3) ancestors.add(`[${name(keys.attrs, true, at)}`);
  }
  return { subject, ancestors: [...ancestors] };
}

/**
 * Splits [start, end) into compounds and the combinators between them (" ",
 * ">", "+", "~"), ignoring anything inside (), [] and quotes. Returns null
 * for selectors this does not understand. As before this module existed, an
 * escape or a quoted string does not take a pending combinator, so
 * `combinators` may be shorter than `starts` minus one.
 */
function selectorParts(start, end, level) {
  const parts = scratchParts(level);
  const { starts, ends, combinators } = parts;
  let current = -1;
  let pending = 0;
  let depth = 0;
  for (let index = start; index < end; index++) {
    const code = text.charCodeAt(index);
    if (code === BACKSLASH) {
      if (current < 0) current = index;
      index++;
      continue;
    }
    if (code === QUOTE || code === APOSTROPHE) {
      const close = text.indexOf(text[index], index + 1);
      if (close < 0 || close >= end) return null;
      if (current < 0) current = index;
      index = close;
      continue;
    }
    if (code === OPEN_PAREN || code === OPEN_BRACKET) depth++;
    else if (code === CLOSE_PAREN || code === CLOSE_BRACKET) depth--;
    if (depth === 0 && (code === SPACE || code === GREATER || code === PLUS || code === TILDE
      || code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN || code === FORM_FEED)) {
      if (current >= 0) {
        starts.push(current);
        ends.push(index);
        current = -1;
        pending = SPACE;
      }
      if (code === GREATER || code === PLUS || code === TILDE) {
        if (pending === 0 && starts.length === 0) return null;
        pending = code;
      }
      continue;
    }
    if (pending !== 0) {
      combinators.push(pending);
      pending = 0;
    }
    if (current < 0) current = index;
  }
  if (depth !== 0) return null;
  if (current >= 0) {
    starts.push(current);
    ends.push(end);
  } else if (pending !== 0 && starts.length) return null;
  return starts.length ? parts : null;
}

/**
 * Keys of the compound [start, end), from its parts outside (): ids,
 * classes and attribute names as flat [start, end, escaped] triples, the
 * type as one (empty when none), and pseudo-classes as [name start, name
 * end, colon] triples.
 */
function compoundKeys(start, end, level) {
  const keys = scratchKeys(level);
  const pipe = text.indexOf("|", start);
  if (pipe !== -1 && pipe < end) return keys;
  if (start < end && isAlpha(text.charCodeAt(start))) {
    let tagEnd = start + 1;
    while (tagEnd < end && isNameCode(text.charCodeAt(tagEnd))) tagEnd++;
    keys.tag.push(start, tagEnd, 0);
  }
  let depth = 0;
  for (let index = start; index < end; index++) {
    const code = text.charCodeAt(index);
    if (code === BACKSLASH) {
      index++;
      continue;
    }
    if (code === OPEN_PAREN) {
      depth++;
      continue;
    }
    if (code === CLOSE_PAREN) {
      depth--;
      continue;
    }
    if (depth > 0) continue;
    if (code === OPEN_BRACKET) {
      let nameStart = index + 1;
      while (nameStart < end && isSpace(text.charCodeAt(nameStart))) nameStart++;
      let nameEnd = nameStart;
      while (nameEnd < end && isNameCode(text.charCodeAt(nameEnd))) nameEnd++;
      if (nameEnd > nameStart) keys.attrs.push(nameStart, nameEnd, 0);
      // Skip to the closing bracket; quoted values may contain "]", "#" or ".".
      let quote = 0;
      for (index++; index < end; index++) {
        const inner = text.charCodeAt(index);
        if (inner === BACKSLASH) index++;
        else if (quote) {
          if (inner === quote) quote = 0;
        } else if (inner === QUOTE || inner === APOSTROPHE) quote = inner;
        else if (inner === CLOSE_BRACKET) break;
      }
    } else if (code === HASH || code === PERIOD) {
      const identifier = leadingIdentifier(index + 1, end);
      const first = text.charCodeAt(index + 1);
      // A class name cannot start with a digit; an id may.
      if (identifier && !(code === PERIOD && first >= 0x30 && first <= 0x39)) {
        (code === HASH ? keys.ids : keys.classes).push(index + 1, identifier.end, identifier.escaped);
      }
    } else if (code === COLON) {
      let nameStart = index + 1;
      if (nameStart < end && text.charCodeAt(nameStart) === COLON) nameStart++;
      let nameEnd = nameStart;
      while (nameEnd < end && isNameCode(text.charCodeAt(nameEnd))) nameEnd++;
      if (nameEnd > nameStart) keys.pseudo.push(nameStart, nameEnd, index);
    }
  }
  return keys;
}

/**
 * The identifier at `start` (word characters, "-", non-ASCII, and escapes
 * other than hex ones), or null when absent or followed by a hex escape.
 */
function leadingIdentifier(start, end) {
  let index = start;
  let escaped = 0;
  while (index < end) {
    const code = text.charCodeAt(index);
    if (isNameCode(code) || code >= 0x80) index++;
    else if (code === BACKSLASH && index + 1 < end && !isHexDigit(text.charCodeAt(index + 1)) && !isSpace(text.charCodeAt(index + 1))) {
      index += 2;
      escaped = 1;
    } else break;
  }
  if (index === start || (index < end && text.charCodeAt(index) === BACKSLASH)) return null;
  return { end: index, escaped };
}

/**
 * Bucket keys for the subject compound: one id, class, attribute or type key,
 * or one per alternative of an :is()/:where() whose alternatives all have one.
 */
function subjectKeys(start, end, level) {
  const keys = compoundKeys(start, end, level);
  if (keys.ids.length) return [{ kind: "id", name: name(keys.ids, false) }];
  if (keys.classes.length) return [{ kind: "class", name: name(keys.classes, false) }];
  if (keys.attrs.length) return [{ kind: "attr", name: name(keys.attrs, true) }];
  if (keys.tag.length) return [{ kind: "tag", name: name(keys.tag, true) }];
  const pseudo = keys.pseudo;
  for (let at = 0; at < pseudo.length; at += 3) {
    if (equalsLowerCase(pseudo[at], pseudo[at + 1], "root")) return [{ kind: "tag", name: "html" }];
  }
  for (let at = 0; at < pseudo.length; at += 3) {
    const nameStart = pseudo[at];
    const nameEnd = pseudo[at + 1];
    if (!equalsLowerCase(nameStart, nameEnd, "is") && !equalsLowerCase(nameStart, nameEnd, "where")
      && !equalsLowerCase(nameStart, nameEnd, "matches") && !equalsLowerCase(nameStart, nameEnd, "-webkit-any")) continue;
    const open = text.indexOf("(", pseudo[at + 2]);
    const close = open < 0 || open >= end ? -1 : matchingParenthesis(open, end);
    if (close < 0) return null;
    const result = [];
    let depth = 0;
    let from = open + 1;
    for (let index = open + 1; index <= close; index++) {
      // The closing parenthesis ends the last alternative.
      const code = index < close ? text.charCodeAt(index) : COMMA;
      if (index < close && code === OPEN_PAREN) depth++;
      else if (index < close && code === CLOSE_PAREN) depth--;
      else if (code === COMMA && (depth === 0 || index === close)) {
        let alternativeStart = from;
        let alternativeEnd = index;
        from = index + 1;
        while (alternativeStart < alternativeEnd && isSpace(text.charCodeAt(alternativeStart))) alternativeStart++;
        while (alternativeEnd > alternativeStart && isSpace(text.charCodeAt(alternativeEnd - 1))) alternativeEnd--;
        if (alternativeStart === alternativeEnd) continue;
        // Only simple alternatives: complex ones inside :is() are left to the
        // selector engine unindexed, so indexing never changes a result.
        const parts = selectorParts(alternativeStart, alternativeEnd, level);
        const inner = parts?.starts.length === 1 ? subjectKeys(parts.starts[0], parts.ends[0], level + 1) : null;
        if (!inner) return null;
        result.push(...inner);
      }
    }
    return result.length ? result : null;
  }
  return null;
}

function matchingParenthesis(open, end) {
  let depth = 0;
  for (let index = open; index < end; index++) {
    const code = text.charCodeAt(index);
    if (code === BACKSLASH) index++;
    else if (code === OPEN_PAREN) depth++;
    else if (code === CLOSE_PAREN && --depth === 0) return index;
  }
  return -1;
}

/** The name of a [start, end, escaped] triple at `at`: unescaped, lowercased for types and attributes. */
function name(triple, lowerCase, at = 0) {
  let value = text.slice(triple[at], triple[at + 1]);
  if (triple[at + 2]) value = value.replace(/\\(.)/g, "$1");
  return lowerCase ? value.toLowerCase() : value;
}

function equalsLowerCase(start, end, expected) {
  if (end - start !== expected.length) return false;
  for (let index = 0; index < expected.length; index++) {
    let code = text.charCodeAt(start + index);
    if (code >= 0x41 && code <= 0x5a) code += 0x20;
    if (code !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function isAlpha(code) {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
}

/** [\w-]: ASCII letters, digits, "_" and "-". */
function isNameCode(code) {
  return isAlpha(code) || (code >= 0x30 && code <= 0x39) || code === UNDERSCORE || code === HYPHEN;
}

function isHexDigit(code) {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66) || (code >= 0x41 && code <= 0x46);
}

/** JavaScript white space: what /\s/ matches and trim() removes. */
function isSpace(code) {
  return code === SPACE || (code >= TAB && code <= CARRIAGE_RETURN) || code === 0xa0 || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f
    || code === 0x205f || code === 0x3000 || code === 0xfeff;
}
