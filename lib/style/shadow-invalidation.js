/** Whether an update crosses the boundary between DOM and composed-tree style.
 * Keep those updates on the coherent full traversal until incremental style
 * propagation understands slot inheritance as well as DOM selector ancestry.
 */
export function touchesShadowScope(node, roots) {
  if (!node) return true;
  if (node.getRootNode?.().host) return true;
  for (const root of roots) {
    const host = root.host;
    if (node === host || host.contains(node) || node.contains?.(host)) return true;
  }
  return false;
}
