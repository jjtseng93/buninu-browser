/**
 * What a style sheet's selectors make sensitive to DOM changes, for the
 * renderer's style invalidation (see selectorTraitsFor in page-renderer.js).
 */
import {selectorKeys} from './selector-keys.js';

/** One sheet's selector traits (sibling combinators, :has(), structural pseudo-classes, invalidation features). */
export function sheetTraits(sheet) {
  const text = String(sheet).replace(/\/\*[\s\S]*?\*\//g, "");
  const plain = text.replace(/\[[^\]]*\]/g, "[]").replace(/\{[^{}]*\}/g, "{}");
  const sibling = /[^\s~|^$*=\[]\s*[+~]\s*[^\s=]/.test(plain);
  const hasCompounds = new Set();
  let hasSiblings = false;
  // Strip leaf declaration blocks without swallowing a nested group's first
  // selector. State invalidation must see selectors inside @media/@layer.
  const selectorsOnly = text.replace(/\{[^{}]*\}/g, "{}");
  for (const block of hasBlocks(selectorsOnly)) {
    for (const selector of splitTopLevelText(block.slice(0, -1), ",")) {
      for (const compound of compoundsOf(selector)) {
        if (!compound.includes(":has(")) continue;
        hasCompounds.add(compound.replace(/::[\w-]+(\([^)]*\))?$/, ""));
        if (/:has\(\s*[+~]/.test(compound)) hasSiblings = true;
      }
    }
  }
  // Structural pseudo-classes: which siblings a child list change can
  // affect, and the compounds where they are not the subject (".a:last-child .b"),
  // whose matches decide whether a sibling's subtree must restyle too.
  const structural = /:(?:nth-child|nth-last-child|first-child|last-child|only-child|nth-of-type|nth-last-of-type|first-of-type|last-of-type|only-of-type)\b/;
  const structuralCompounds = new Set();
  for (const block of selectorsOnly.matchAll(/[^{}]*\{/g)) {
    if (!structural.test(block[0])) continue;
    for (const selector of splitTopLevelText(block[0].slice(0, -1), ",")) {
      const compounds = compoundsOf(selector);
      for (const compound of compounds.slice(0, -1)) if (structural.test(compound)) structuralCompounds.add(compound);
    }
  }
  // Invalidation features (class ".x", id "#x", attribute "[x", tag "t:x",
  // state ":state", anything "*") of compounds that are not a selector's
  // subject: left of a descendant/child combinator, a change to them can
  // restyle the element's subtree; left of + / ~, its later siblings.
  const descendantFeatures = new Set();
  const descendantTargets = new Map();
  const siblingFeatures = new Set();
  const descendantStateCompounds = [];
  // Selectors ending in a compound right of + / ~ that is not the subject
  // (".a + .b" of ".a + .b .c"): a later sibling's subtree restyles only
  // when its match of one of them changes.
  const siblingTargetCompounds = new Set();
  const siblingStateFeatures = new Set();
  const observedAttributes = new Set();
  // Scan the original sheet so nested at-rules retain their selectors. A
  // bracket in a declaration can conservatively add an unused dependency.
  // Names can be escaped; namespace prefixes do not change the local name.
  for (const match of text.matchAll(/\[\s*(?:(?:[\w*-]*)\|)?((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[\w\u00a0-\uffff-])+)/g)) {
    observedAttributes.add(cssUnescape(match[1]).toLowerCase());
  }
  for (const block of selectorsOnly.matchAll(/[^{}@]*\{/g)) {
    for (const selector of splitTopLevelText(block[0].slice(0, -1), ",")) {
      const parts = complexParts(selector);
      // A feature on an ancestor can only change subjects of these rules.
      // Keep unknown/universal subjects conservative; nested combinators can
      // observe a relation outside the changed element's ordinary subtree.
      let targets;
      parts.forEach(({ compound, combinator }, index) => {
        const nested = /\([^)]*[\s>+~][^)]*\)/.test(compound); // :is(.a .b) hides combinators
        const previous = parts[index - 1]?.combinator;
        if ((previous === "+" || previous === "~") && index < parts.length - 1) {
          // With what is left of it ("li:first-child + li"): the relation to
          // the earlier sibling can end while the compound still matches.
          const left = parts.slice(0, index).map((part) => `${part.compound} ${part.combinator === " " ? "" : part.combinator + " "}`).join("");
          siblingTargetCompounds.add(left + compound);
          // These cached prefixes can change after their own or an ancestor's
          // features change, even when no sibling relation changed yet.
          for (const part of parts.slice(0, index + 1))
            for (const feature of compoundFeatures(part.compound)) siblingStateFeatures.add(feature);
        }
        if (index === parts.length - 1 && !nested) return;
        const features = compoundFeatures(compound);
        if (nested || combinator === " " || combinator === ">") {
          for (const feature of features) {
            descendantFeatures.add(feature);
            if (feature.startsWith(':')) continue;
            const previous = descendantTargets.get(feature);
            if (previous === null) continue;
            if (targets === undefined) {
              const subject = nested || /:host\b|::slotted\(/.test(selector) ? null : selectorKeys(selector).subject;
              targets = subject?.map(key => ({id:'#',class:'.',attr:'[',tag:'t:'})[key.kind] + key.name) ?? null;
            }
            if (nested || !targets?.length) descendantTargets.set(feature, null);
            else {
              const set = previous ?? new Set();
              for (const target of targets) set.add(target);
              descendantTargets.set(feature, set);
            }
          }
          const states = features.filter((feature) => feature.startsWith(":"));
          if (states.length) descendantStateCompounds.push({ states, required: positiveCompoundFeatures(compound),
            alternatives: positiveSelectorAlternatives(compound) });
        }
        if (nested || combinator === "+" || combinator === "~") for (const feature of features) siblingFeatures.add(feature);
      });
    }
  }
  return {
    sibling, hasCompounds, hasSiblings, structuralCompounds, descendantFeatures, descendantTargets, siblingFeatures, descendantStateCompounds, siblingTargetCompounds, siblingStateFeatures, observedAttributes,
    forward: /:(?:nth-child|nth-of-type|first-of-type|only-of-type)\b/.test(selectorsOnly),
    firstChild: /:(?:first-child|only-child)\b/.test(selectorsOnly),
    backward: /:(?:nth-last-child|nth-last-of-type|last-of-type|only-of-type)\b/.test(selectorsOnly),
    lastChild: /:(?:last-child|only-child)\b/.test(selectorsOnly),
    defined: text.includes(":defined"), target: /:target\b/.test(text),
    validity: /:(?:valid|invalid)(?![\w-])/i.test(cssUnescape(selectorsOnly)),
    controlState: /:(?:enabled|disabled|read-only|read-write)(?![\w-])/i.test(cssUnescape(selectorsOnly)),
  };
}

/** Merge sheet-local subject keys; any universal dependency keeps its fallback. */
export function mergeDescendantTargets(parts) {
  const result = new Map();
  for (const part of parts) for (const [feature, targets] of part.descendantTargets) {
    if (targets === null) { result.set(feature, null); continue; }
    const previous = result.get(feature);
    if (previous === null) continue;
    const merged = previous ?? new Set();
    for (const target of targets) merged.add(target);
    result.set(feature, merged);
  }
  return result;
}

/**
 * Queue ordinary ancestor-feature changes without walking DOM per mutation.
 * The changed element itself is always restyled by the caller. State and
 * unknown selectors retain the caller's existing complete-subtree path.
 */
export function queueDescendantInvalidation(pending, roots, element, features, targetsByFeature) {
  if (roots.has(element)) return;
  for (const feature of features) {
    if (!targetsByFeature.has(feature)) continue;
    const targets = targetsByFeature.get(feature);
    if (targets === null) { roots.add(element); pending.delete(element); return; }
    let queued = pending.get(element);
    if (!queued) pending.set(element, queued = new Set());
    for (const target of targets) queued.add(target);
  }
}

/**
 * Walk overlapping invalidated subtrees once, selecting only possible rule
 * subjects. The style engine propagates any changed inherited/custom values
 * from those self checks. Full dirty roots already cover their descendants.
 */
export function collectDescendantInvalidations(pending, roots, self, document) {
  const active = new Map();
  const matches = element => {
    if (active.has('t:' + element.localName.toLowerCase())) return true;
    const id = element.getAttribute('id');
    if (id && active.has('#' + id)) return true;
    for (const name of element.classList) if (active.has('.' + name)) return true;
    for (const attribute of element.attributes) if (active.has('[' + attribute.name.toLowerCase())) return true;
    return false;
  };
  const visit = element => {
    if (roots.has(element)) return;
    if (active.size && matches(element)) self.add(element);
    const targets = pending.get(element);
    if (targets) for (const target of targets) active.set(target, (active.get(target) ?? 0) + 1);
    for (const child of element.children) visit(child);
    if (targets) for (const target of targets) {
      const count = active.get(target) - 1;
      if (count) active.set(target, count); else active.delete(target);
    }
  };
  for (const element of pending.keys()) {
    if (!element.isConnected || element.ownerDocument !== document) continue;
    let covered = roots.has(element);
    for (let node = element.parentElement; node && !covered; node = node.parentElement)
      covered = pending.has(node) || roots.has(node);
    if (!covered) visit(element);
  }
}

const HAS_BLOCK = /[^{}]*:has\([^{]*\{/y;

/**
 * The matches of /[^{}]*:has\([^{]*\{/g in `text`. Searched globally, that
 * expression retries at every position of every brace-free run; a match can
 * only start where such a run starts (after a brace, where the previous
 * match ended) and contains ":has(", so only those runs are tried.
 */
function* hasBlocks(text) {
  let end = 0;
  for (let at = text.indexOf(":has("); at !== -1; at = text.indexOf(":has(", Math.max(at + 1, end))) {
    const start = Math.max(text.lastIndexOf("{", at), text.lastIndexOf("}", at)) + 1;
    if (start < end) continue;
    HAS_BLOCK.lastIndex = start;
    const match = HAS_BLOCK.exec(text);
    if (!match) continue;
    end = HAS_BLOCK.lastIndex;
    yield match[0];
  }
}

/** Splits at top-level `separator` (outside (), [] and quotes). */
function splitTopLevelText(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) { if (character === "\\") index++; else if (character === quote) quote = ""; continue; }
    if (character === '"' || character === "'") quote = character;
    else if (character === "\\") index++;
    else if (character === "(" || character === "[") depth++;
    else if (character === ")" || character === "]") depth--;
    else if (character === separator && depth === 0) { parts.push(text.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

const STATE_PSEUDO = /:(?:checked|indeterminate|default|disabled|enabled|placeholder-shown|valid|invalid|in-range|out-of-range|required|optional|read-only|read-write|user-valid|user-invalid|autofill|open|popover-open|modal|target|focus|focus-visible|focus-within|hover|active|visited|link|any-link|defined|fullscreen)(?![\w-])/g;

/** Outer :is/:where groups require at least one subject alternative to fit.
 * Requirements inside :not/:has cannot constrain this element positively.
 * Nested functional conditions remain conservative rather than excluding
 * a possible match. Complex alternatives constrain their rightmost subject.
 */
function positiveSelectorAlternatives(compound) {
  const groups = [];
  let depth = 0;
  for (let index = 0; index < compound.length; index++) {
    const character = compound[index];
    if (character === "\\") { index++; continue; }
    if (character === "(" || character === "[") { depth++; continue; }
    if (character === ")" || character === "]") { depth--; continue; }
    if (depth || character !== ":") continue;
    const match = /^:(?:is|where)\(/.exec(compound.slice(index));
    if (!match) continue;
    const start = index + match[0].length;
    let end = start, nested = 1, quote = "";
    for (; end < compound.length && nested; end++) {
      const char = compound[end];
      if (char === "\\") end++;
      else if (quote) { if (char === quote) quote = ""; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === "(") nested++;
      else if (char === ")") nested--;
    }
    if (nested) continue;
    groups.push(splitTopLevelText(compound.slice(start,end-1), ",")
      .map(selector => positiveCompoundFeatures(complexParts(selector).at(-1)?.compound ?? "")));
    index = end - 1;
  }
  return groups;
}

/** CSS escapes in an identifier (".\\:popover-open", "\\31 a") resolved. */
function cssUnescape(text) {
  return text.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16))).replace(/\\(.)/g, "$1");
}

/** Invalidation features a compound selector mentions (see selectorTraitsFor). */
function compoundFeatures(compound) {
  const features = [];
  const plain = compound.replace(/\[[^\]]*\]/g, (attribute) => {
    const name = /^\[\s*([\w-]+)/.exec(attribute)?.[1];
    if (name) features.push("[" + name.toLowerCase());
    return "";
  });
  for (const match of plain.matchAll(/([.#])((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[\w\u00a0-\uffff-])+)/g)) features.push(match[1] + cssUnescape(match[2]));
  const tag = /^(?:[a-zA-Z][\w-]*)/.exec(plain)?.[0];
  if (tag) features.push("t:" + tag.toLowerCase());
  for (const match of plain.matchAll(STATE_PSEUDO)) features.push(match[0]);
  // Nothing but a universal selector or pseudo-classes: it can match anything.
  if (!features.length || /^\*/.test(plain)) features.push("*");
  return features;
}

/** Positive outer-compound requirements that must hold regardless of pseudo state. */
function positiveCompoundFeatures(compound) {
  const features = [];
  const tag = /^[a-zA-Z][\w-]*/.exec(compound)?.[0];
  if (tag) features.push("t:" + tag.toLowerCase());
  let depth = 0;
  for (let index = 0; index < compound.length; index++) {
    const character = compound[index];
    if (character === "\\") { index++; continue; }
    if (character === "(") { depth++; continue; }
    if (character === ")") { depth--; continue; }
    if (depth) continue;
    if (character === "[") {
      const name = /^\s*([\w-]+)/.exec(compound.slice(index + 1))?.[1];
      if (name) features.push("[" + name.toLowerCase());
      let quote = "";
      for (index++; index < compound.length; index++) {
        const inner = compound[index];
        if (inner === "\\") index++;
        else if (quote) { if (inner === quote) quote = ""; }
        else if (inner === '"' || inner === "'") quote = inner;
        else if (inner === "]") break;
      }
    } else if (character === "." || character === "#") {
      const match = /^((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[\w\u00a0-\uffff-])+)/.exec(compound.slice(index + 1));
      if (match) features.push(character + cssUnescape(match[1]));
    }
  }
  return features;
}

/** The features an element has (for a sibling it inserts next to, for example). */
export function elementFeatures(element) {
  const features = ["t:" + element.localName];
  const id = element.getAttribute("id");
  if (id) features.push("#" + id);
  for (const name of element.classList) features.push("." + name);
  for (const attribute of element.attributes) features.push("[" + attribute.name);
  return features;
}

/** Whether a character code is JavaScript white space (what /\s/ matches and trim() removes). */
function isSpace(code) {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0 || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f
    || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

const GREATER = 0x3e, PLUS = 0x2b, TILDE = 0x7e;

/**
 * Calls `separator(index, code)` at each top-level combinator character of
 * a complex selector (white space, ">", "+", "~" outside (), [], quotes and
 * escapes) and returns nothing; the text between separators is a compound.
 */
function forEachSeparator(selector, separator) {
  let depth = 0;
  let quote = 0;
  for (let index = 0; index < selector.length; index++) {
    const code = selector.charCodeAt(index);
    if (quote) {
      if (code === 0x5c) index++;
      else if (code === quote) quote = 0;
      continue;
    }
    if (code === 0x22 || code === 0x27) { quote = code; continue; }
    if (code === 0x5c) { index++; continue; }
    if (code === 0x28 || code === 0x5b) depth++;
    else if (code === 0x29 || code === 0x5d) depth--;
    else if (depth === 0 && (code === GREATER || code === PLUS || code === TILDE || isSpace(code))) separator(index, code);
  }
}

/** A complex selector's compounds with the combinator after each (" ", ">", "+", "~", or null for the subject). */
function complexParts(selector) {
  const parts = [];
  let start = 0;
  forEachSeparator(selector, (index, code) => {
    if (index > start) parts.push({ compound: selector.slice(start, index), combinator: null });
    start = index + 1;
    if (!isSpace(code) && parts.length) parts.at(-1).combinator = selector[index];
    else if (parts.length && parts.at(-1).combinator === null) parts.at(-1).combinator = " ";
  });
  if (selector.length > start) parts.push({ compound: selector.slice(start), combinator: null });
  return parts;
}

/** The compound selectors of a complex selector (split at top-level combinators). */
function compoundsOf(selector) {
  const compounds = [];
  let start = 0;
  forEachSeparator(selector, (index) => {
    if (index > start) compounds.push(selector.slice(start, index));
    start = index + 1;
  });
  if (selector.length > start) compounds.push(selector.slice(start));
  return compounds;
}
