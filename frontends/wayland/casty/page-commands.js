// Extracted unchanged from Casty lib/input.js (MIT), except exporting the helpers.
export const FIND_SCRIPT = `(query) => {
  const state = window.__castyFind || (window.__castyFind = { text: '', index: -1 });
  if (query) { if (query !== state.text) state.index = -1; state.text = query; }
  if (!state.text) return { error: 'Usage: find <text>' };
  // Search the concatenated text, so a match may span nodes (pages that wrap
  // each letter in its own element, for one)
  const nodes = [], starts = [];
  let all = '';
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { nodes.push(child); starts.push(all.length); all += child.data; }
      else if (child.nodeType === 1 && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/i.test(child.tagName)) walk(child);
    }
  };
  if (document.body) walk(document.body);
  const haystack = all.toLowerCase(), needle = state.text.toLowerCase();
  const matches = [];
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) matches.push(at);
  if (!matches.length) return { text: state.text, total: 0, index: -1 };
  state.index = (state.index + 1) % matches.length;
  // Text node and offset holding character \`at\` (the last node starting at or before it)
  const locate = (at, end) => {
    let i = 0;
    while (i + 1 < nodes.length && (starts[i + 1] < at || (!end && starts[i + 1] === at))) i++;
    return [nodes[i], at - starts[i]];
  };
  const from = matches[state.index];
  const [startNode, startOffset] = locate(from, false);
  const [endNode, endOffset] = locate(from + needle.length, true);
  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {}
  startNode.parentElement?.scrollIntoView?.({ block: 'center' });
  return { text: state.text, total: matches.length, index: state.index };
}`;

export async function findInPage(client, query) {
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression: `(${FIND_SCRIPT})(${JSON.stringify(query)})`,
    returnByValue: true,
  });
  if (exceptionDetails) return { error: 'Find failed' };
  return result?.value ?? { error: 'Find failed' };
}

// Ported from ../exeapk's ERUDA_TOGGLE_JS: loads eruda (github.com/liriliri/eruda)
// from a CDN on first use, then only shows or hides it. Resolves to a status
// instead of alert()ing, which would block a headless page.
const ERUDA_SCRIPT = `new Promise(resolve => {
  const toggle = () => {
    window.__erudaShown = !window.__erudaShown;
    if (window.__erudaShown) eruda.show(); else eruda.hide();
    resolve(window.__erudaShown ? 'Eruda shown' : 'Eruda hidden');
  };
  if (window.eruda) { toggle(); return; }
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/eruda';
  s.onload = () => {
    try { eruda.init(); window.__erudaShown = false; toggle(); }
    catch (e) { resolve('Eruda failed: ' + e.message); }
  };
  s.onerror = () => resolve('Eruda load failed (need network, or blocked by the page)');
  (document.body || document.documentElement).appendChild(s);
})`;

export async function toggleEruda(client) {
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression: ERUDA_SCRIPT,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) return 'Eruda failed';
  return result?.value ?? 'Eruda failed';
}
