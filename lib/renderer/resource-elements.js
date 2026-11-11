import {shadowRootsIn} from '../happy-dom/shadow-tree.js';

const SELECTORS = Object.freeze({
  media: "video, audio",
  images: "img",
  sheets: "style, link[rel~='stylesheet']",
  frames: "iframe",
});
const HTML = 'http://www.w3.org/1999/xhtml', SVG = 'http://www.w3.org/2000/svg';
const RESOURCE_KIND = Object.freeze({video:'media',audio:'media',img:'images',iframe:'frames'});
function resourceKind(element) {
  const name=element.localName, namespace=element.namespaceURI;
  if(name==='style'&&(namespace===HTML||namespace===SVG))return 'sheets';
  if(namespace!==HTML)return null;
  if(name==='link'&&(element.getAttributeNS(null,'rel')??'').toLowerCase().split(/[\t\n\f\r ]+/).includes('stylesheet'))return 'sheets';
  return RESOURCE_KIND[name]??null;
}
export function queryResourceElements(document,kind) {
  // Preserve HTML's existing discovery contract. XML qualified names are
  // case-sensitive and may carry prefixes, so use namespace/local name there.
  if((document.contentType??document.ownerDocument?.contentType)==='text/html')return Array.from(document.querySelectorAll(SELECTORS[kind]));
  return Array.from(document.querySelectorAll('*')).filter(element=>resourceKind(element)===kind);
}

/**
 * Cache discovery, never resource state. Tag membership changes with DOM
 * structure; only the stylesheet list also depends on an attribute (rel).
 * Callers still read src/href, credentials, media/type/disabled, text and the
 * document base URL on every pass. Ordinary data/ARIA/class mutations therefore
 * do not cause four whole-document queries during a geometry flush.
 */
export function createResourceElements(document) {
  const lists = new Map();
  const ancestors = new Map();
  let scopedLists = new WeakMap();
  let shadowRoots = shadowRootsIn(document);
  let observedRoots = [];
  let disposed = false;
  const discard = kind => { lists.delete(kind); ancestors.delete(kind); };
  const invalidate = records => {
    // A scope query never crosses a shadow boundary. Invalidate the root of
    // each mutation, not every component's resource list. Moving a subtree
    // produces removal/insertion records for both affected roots; changes to
    // the set of observed roots still clear all scoped caches in roots().
    for (const record of records) scopedLists.delete(record.target.getRootNode());
    if (records.some(record => record.type === 'childList')) {
      const next = shadowRoots.filter(root => root.host.isConnected && root.ownerDocument === document);
      const seen = new Set(next);
      const scanned = new Set();
      for (const record of records) if (record.type === 'childList') {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1 || !node.isConnected || node.ownerDocument !== document) continue;
          for (const root of shadowRootsIn({children: [node]}, scanned)) if (!seen.has(root)) { seen.add(root); next.push(root); }
        }
      }
      if (next.length !== shadowRoots.length || next.some((root, index) => root !== shadowRoots[index])) shadowRoots = next;
      // roots() invalidates aggregates when hosts attach/detach. Otherwise
      // the resource-specific subtree checks below also apply inside shadow
      // roots; ordinary text/UI insertion does not change resource membership.
    }
    let visited;
    for (const record of records) {
      if (!lists.size) return;
      if (record.type === "attributes") discard("sheets");
      if (record.type !== "childList") continue;
      for (const node of record.removedNodes) {
        if (node.nodeType !== 1) {
          if (node.nodeType !== 3 && node.nodeType !== 8) { lists.clear(); ancestors.clear(); return; }
          continue;
        }
        // Snapshot ancestry survives detached subtrees being emptied or moved
        // before observer delivery, without scanning every cached resource.
        for (const [kind, parents] of ancestors) if (parents.has(node)) discard(kind);
      }
      const pending = [...record.addedNodes];
      while (pending.length && lists.size) {
        const node = pending.pop();
        if (node.nodeType !== 1) {
          if (node.nodeType !== 3 && node.nodeType !== 8) { lists.clear(); ancestors.clear(); return; }
          continue;
        }
        // Nested insertion records can name the same subtree many times.
        visited ??= new Set();
        if (visited.has(node)) continue;
        visited.add(node);
        if(document.contentType==='text/html') {
          const tag=node.tagName.toUpperCase();
          if(tag==='VIDEO'||tag==='AUDIO')discard('media');
          else if(tag==='IMG')discard('images');
          else if(tag==='IFRAME')discard('frames');
          else if(tag==='STYLE'||tag==='LINK'&&node.matches("link[rel~='stylesheet']"))discard('sheets');
        } else {
          const kind=resourceKind(node);
          if(kind)discard(kind);
        }
        if (lists.size) for (const child of node.children) pending.push(child);
      }
    }
  };
  // Use an independent observer: discovery precedes style computation and
  // must not consume or reorder the CSS invalidation observer's records.
  const observer = new document.defaultView.MutationObserver(invalidate);
  const options = {subtree: true, childList: true, attributes: true, attributeFilter: ['rel']};
  observer.observe(document, options);
  function roots() {
    if (disposed) throw new Error('Resource element discovery is disposed');
    invalidate(observer.takeRecords());
    if (shadowRoots.length !== observedRoots.length || shadowRoots.some((root, index) => root !== observedRoots[index])) {
      lists.clear(); ancestors.clear();
      scopedLists = new WeakMap();
      // Rebind instead of accumulating detached roots in an observer forever.
      observer.disconnect(); observer.observe(document, options);
      for (const root of shadowRoots) observer.observe(root, options);
      observedRoots = shadowRoots;
    }
    return shadowRoots;
  }
  return {
    shadowRoots: roots,
    shadowAttached(root) {
      if (root.host.isConnected && root.ownerDocument === document && !shadowRoots.includes(root)) shadowRoots = [...shadowRoots, root];
    },
    get(kind, scope = document) {
      const selector = SELECTORS[kind];
      if (!selector) throw new TypeError(`Unknown resource element kind: ${kind}`);
      if (disposed) throw new Error("Resource element discovery is disposed");
      // Script may insert an image/link and synchronously read geometry in
      // the same task, before observer callbacks have been delivered.
      invalidate(observer.takeRecords());
      const scopes = roots();
      if (scope !== document) {
        // Only connected, observed scopes are cacheable. Queries of an old
        // detached root still work, but its future mutations are unobserved.
        if (!scopes.includes(scope)) return Object.freeze(queryResourceElements(scope, kind));
        let scoped = scopedLists.get(scope);
        if (!scoped) scopedLists.set(scope, scoped = new Map());
        if (!scoped.has(kind)) scoped.set(kind, Object.freeze(queryResourceElements(scope, kind)));
        return scoped.get(kind);
      }
      let list = lists.get(kind);
      if (!list) {
        list = Object.freeze(queryResourceElements(document,kind).concat(kind === 'sheets' ? []
          : scopes.flatMap(root => queryResourceElements(root, kind))));
        lists.set(kind, list);
        const parents = new WeakSet();
        for (const element of list) {
          for (let node = element; node && !parents.has(node); node = node.parentNode) parents.add(node);
        }
        ancestors.set(kind, parents);
      }
      return list;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      lists.clear();
      ancestors.clear();
      scopedLists = new WeakMap();
      shadowRoots = []; observedRoots = [];
    },
  };
}
