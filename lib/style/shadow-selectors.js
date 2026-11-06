import {compileSelector, matchesCompiled} from '../happy-dom/selector-matcher.js';
import SelectorCombinator from '../../vendor/happy-dom/packages/happy-dom/src/query-selector/SelectorCombinatorEnum.ts';
import {assignedSlot} from '../renderer/slot-assignment.js';

const argumentsCache = new WeakMap();
const plainItems = new WeakMap();
const special = new Set(['host', 'host-context', 'is', 'where', 'not']);
// These observe the host itself, its descendants, or inherited ancestor state;
// the shadow-boundary mutation gate already covers those paths.
const localHostStates = new Set(['hover', 'active', 'focus', 'focus-visible', 'focus-within',
  'popover-open', 'modal', 'fullscreen', 'defined', 'empty', 'enabled', 'disabled',
  'checked', 'indeterminate', 'placeholder-shown', 'read-only', 'read-write',
  'link', 'any-link', 'visited', 'scope', 'root', 'target', 'lang', 'dir']);

function argument(element, pseudo) {
  if (!argumentsCache.has(pseudo)) argumentsCache.set(pseudo, compileSelector(element, pseudo.arguments ?? ''));
  return argumentsCache.get(pseudo);
}

/** Compile the selector once, including ::slotted's compound argument. */
export function compileShadowSelector(element, selector) {
  const start = selector.search(/::slotted\(/i);
  if (start < 0) return {compiled: compileSelector(element, selector)};
  // ::slotted() accepts one compound, not a selector list or combinator.
  if (!selector.endsWith(')') || /::slotted\(/i.test(selector.slice(start + 1))) return null;
  const value = compileSelector(element, selector.slice(start + 10, -1));
  if (!value || value.length !== 1 || value[0].length !== 1) return null;
  return {compiled: compileSelector(element, selector.slice(0, start) || '*'), slotted: value};
}

/** Conservative dependencies not covered by ordinary document invalidation.
 * Inspect parsed selectors (including nested selector lists), not text which
 * might hide a pseudo in strings, comments or selector-list functions.
 */
export function shadowSelectorDependencies(element, selector) {
  const dependencies = {outside:false, defined:false, target:false};
  const uncertain = () => { dependencies.outside = dependencies.defined = dependencies.target = true; };
  const visit = (groups, depth = 0, hostArgument = false) => {
    if (depth > 128 || groups === undefined) { uncertain();return; }
    for (const items of groups ?? []) {
      if (hostArgument && items.length > 1) dependencies.outside = true;
      for (const item of items) for (const pseudo of item.pseudos ?? []) {
        const name = pseudo.name;
        if (name === 'defined' || name === 'target') dependencies[name] = true;
        // These can observe siblings or arbitrary context of a host. Treat
        // their use inside the shadow tree conservatively too; reducing that
        // fallback requires tracking which compounds can match the host.
        if (['host-context', 'has', 'valid', 'invalid', 'default'].includes(name) || name.startsWith('nth-')
          || ['first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type', 'only-of-type'].includes(name)) dependencies.outside = true;
        if (['host', 'host-context', 'is', 'where', 'not', 'has'].includes(name) && pseudo.arguments) {
          const nested = argument(element, pseudo);
          // The upstream :has matcher can consume relative selector items
          // even when our ordinary selector compiler rejects the argument.
          // Never discard state dependencies from an uncertain nested tree.
          if (!nested?.length || nested.some(items => !items.length)) uncertain();
          else visit(nested, depth + 1, name === 'host' || name === 'host-context' || hostArgument);
        } else if (pseudo.selectorItems?.length) {
          visit(pseudo.selectorItems.map(item => [item]), depth + 1, hostArgument);
        } else if (hostArgument && name !== 'host' && !localHostStates.has(name)) dependencies.outside = true;
      }
    }
  };
  if (selector === undefined) uncertain();
  else if (selector) { visit(selector.compiled);visit(selector.slotted ?? []); }
  return dependencies;
}

export function shadowSelectorDependsOnOutside(element, selector) {
  return shadowSelectorDependencies(element, selector).outside;
}

export function matchesShadowSelector(element, selector, root) {
  if (!selector?.compiled) return false;
  if (selector.slotted) {
    if (!root) return false;
    const slot = assignedSlot(element);
    return slot?.getRootNode() === root && matchesCompiled(element, selector.slotted)
      && matchesInScope(slot, selector.compiled, root);
  }
  if (root && element !== root.host && element.getRootNode() !== root) return false;
  return matchesInScope(element, selector.compiled, root);
}

function matchesInScope(element, groups, root, depth = 0) {
  if (!groups || depth > 128) return false;
  const parent = node => node === root?.host ? null : root && node.parentNode === root ? root.host : node.parentElement;
  const match = (node, items, index) => {
    if (!node || !matchesItem(node, items[index], root, depth)) return false;
    if (index === items.length - 1) return true;
    switch (items[index].combinator) {
      case SelectorCombinator.child: return match(parent(node), items, index + 1);
      case SelectorCombinator.adjacentSibling:
        return node !== root?.host && match(node.previousElementSibling, items, index + 1);
      case SelectorCombinator.subsequentSibling:
        if (node !== root?.host) for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling)
          if (match(sibling, items, index + 1)) return true;
        return false;
      default:
        for (let ancestor = parent(node); ancestor; ancestor = parent(ancestor)) if (match(ancestor, items, index + 1)) return true;
        return false;
    }
  };
  return groups.some(items => match(element, items, 0));
}

function matchesItem(element, item, root, depth) {
  const pseudos = item.pseudos ?? [];
  const host = element === root?.host;
  // A host is featureless inside its shadow scope. Its ordinary class/type/id
  // selectors only match as arguments of :host(), not as '.host > child'.
  if (host && (item.id || item.tagName || item.classNames?.length || item.attributes?.length
    || !pseudos.some(p => ['host', 'host-context', 'is', 'where'].includes(p.name)))) return false;
  let plain = plainItems.get(item);
  if (!plain) {
    plain = Object.assign(Object.create(Object.getPrototypeOf(item)), item);
    plain.pseudos = pseudos.filter(p => !special.has(p.name));
    plainItems.set(item, plain);
  }
  if (!plain.match(root ?? element, element)) return false;
  for (const pseudo of pseudos) {
    if (!special.has(pseudo.name)) continue;
    if (pseudo.name === 'host' || pseudo.name === 'host-context') {
      if (!host) return false;
      if (!pseudo.arguments) { if (pseudo.name === 'host-context') return false; continue; }
      const compiled = argument(element, pseudo);
      if (!compiled || compiled.length !== 1 || compiled[0].length !== 1) return false;
      if (pseudo.name === 'host') { if (!matchesCompiled(element, compiled)) return false; }
      else {
        let found = false;
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement ?? ancestor.getRootNode()?.host)
          if (matchesCompiled(ancestor, compiled)) { found = true; break; }
        if (!found) return false;
      }
    } else {
      const found = matchesInScope(element, argument(element, pseudo), root, depth + 1);
      if (pseudo.name === 'not' ? found : !found) return false;
    }
  }
  return true;
}
