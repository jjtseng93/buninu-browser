const SELECTORS = Object.freeze({
  media: "video, audio",
  images: "img",
  sheets: "style, link[rel~='stylesheet']",
  frames: "iframe",
});

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
  let disposed = false;
  const discard = kind => { lists.delete(kind); ancestors.delete(kind); };
  const invalidate = records => {
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
        // Match the selector engine's case folding, including foreign tags.
        const tag = node.tagName.toUpperCase();
        if (tag === "VIDEO" || tag === "AUDIO") discard("media");
        else if (tag === "IMG") discard("images");
        else if (tag === "IFRAME") discard("frames");
        else if (tag === "STYLE" || (tag === "LINK" && node.matches("link[rel~='stylesheet']"))) discard("sheets");
        if (lists.size) for (const child of node.children) pending.push(child);
      }
    }
  };
  // Use an independent observer: discovery precedes style computation and
  // must not consume or reorder the CSS invalidation observer's records.
  const observer = new document.defaultView.MutationObserver(invalidate);
  observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["rel"] });
  return {
    get(kind) {
      const selector = SELECTORS[kind];
      if (!selector) throw new TypeError(`Unknown resource element kind: ${kind}`);
      if (disposed) throw new Error("Resource element discovery is disposed");
      // Script may insert an image/link and synchronously read geometry in
      // the same task, before observer callbacks have been delivered.
      invalidate(observer.takeRecords());
      let list = lists.get(kind);
      if (!list) {
        list = Object.freeze(Array.from(document.querySelectorAll(selector)));
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
    },
  };
}
