/** Secure Contexts: a trustworthy document and no insecure ancestor. */
export function secureContextForDocument(url, parent = null) {
  const seen = new Set();
  while (true) {
    let parsed;
    try { parsed = new URL(url); } catch { return false; }
    // Initial empty documents inherit their creator's context. A fresh
    // top-level about:blank has an opaque origin and is not secure.
    const inherited = parsed.protocol === 'about:' && ['blank', 'srcdoc'].includes(parsed.pathname);
    if (inherited ? !parent : !trustworthyURL(parsed)) return false;
    if (!parent) return true;
    if (seen.has(parent)) return false;
    seen.add(parent);
    url = parent.url?.() ?? parent.origin?.();
    parent = parent.parent?.() ?? null;
  }
}

function trustworthyURL(url) {
  if (url.protocol === 'blob:') {
    if (url.origin === 'null') return false;
    return trustworthyURL(new URL(url.origin));
  }
  if (['https:', 'wss:', 'file:'].includes(url.protocol)) return true;
  if (!['http:', 'ws:'].includes(url.protocol)) return false;
  // URL canonicalization covers alternate IPv4 spellings and compressed IPv6.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}
