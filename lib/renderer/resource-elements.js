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
  let disposed = false;
  const invalidate = records => {
    for (const record of records) {
      if (record.type === "childList") {
        // Text counters and stylesheet textContent replace text nodes too.
        // They cannot change these element-only selectors; callers still
        // read each cached element's current text and resource attributes.
        const nodes = [...record.addedNodes, ...record.removedNodes];
        if (nodes.some(node => node.nodeType !== 3 && node.nodeType !== 8)) {
          lists.clear(); return;
        }
      }
      if (record.type === "attributes") lists.delete("sheets");
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
      }
      return list;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      lists.clear();
    },
  };
}
