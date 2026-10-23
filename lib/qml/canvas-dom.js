/** Local-QML-only drawImage(Element) adapter. No DOM mutation or encoded images. */
import { buildDisplayList } from '../paint/display-list.js';

const documents = new WeakSet();
const snapshots = new WeakMap();
export function enableQmlDomImages(document) { documents.add(document); }
export function hasQmlDomImages(document) { return documents.has(document); }

/** Extract laid-out content, retaining internal stacking/clips but not ancestors. */
export function subtreeDisplayList(element, { tree, layout, resources, backgroundResource, scrollOffsetOf }) {
  const root = [...tree.nodesById.values()].find(node => node.domNode === element);
  const box = root && layout.boxes.find(box => box.nodeId === root.id && !box.inline);
  if (!root || !box) throw new DOMException('DOM image source needs a connected, laid-out box.', 'InvalidStateError');
  const nodesById = new Map();
  const visit = node => { nodesById.set(node.id, node); for (const child of node.children ?? []) visit(child); };
  visit(root);
  // A synthetic parent keeps the source's own overflow clip, which the painter
  // ordinarily skips for its document root. Ancestor effects are not imported.
  const isolatedTree = { root: { id: Symbol('qml-image-root'), children: [root] }, nodesById };
  const boxes = layout.boxes.filter(entry => nodesById.has(entry.nodeId));
  const fragments = layout.fragments.map(fragment => ({ ...fragment,
    runs: fragment.runs.filter(run => nodesById.has(run.nodeId)),
  })).filter(fragment => fragment.runs.length);
  // A selected layer can have an ancestor stacking context with no selected
  // boxes. Keep that context's ordering metadata, never its painted content.
  const layers = new Set();
  for (const entry of [...boxes, ...fragments]) {
    for (let layer = entry.layer; layer && layer.order !== 0; layer = layer.parent) layers.add(layer);
  }
  for (const layer of layers) fragments.push({ layer, runs: [] });
  let list = buildDisplayList({ ...layout, boxes, fragments }, isolatedTree,
    resources, backgroundResource, scrollOffsetOf);
  // Snapshot coordinates do not scroll with the page viewport. Fixed items
  // already carry their laid-out positions and must not receive its offset.
  if (list.items.some(item => item.fixed)) {
    const images = list.images;
    list = { ...list, items: list.items.map(item => item.fixed ? { ...item, fixed: false } : item) };
    Object.defineProperty(list, 'images', { value: images });
  }
  return { list, box, nodesById };
}

export function captureQmlDomImage(element, options) {
  const { document, kit, resources, canvasResource, isOriginClean, paint } = options;
  if (element?.nodeType !== 1 || element.ownerDocument !== document || !element.isConnected) {
    throw new DOMException('DOM image source must belong to this QML document.', 'InvalidStateError');
  }
  // Refresh only nested canvas resources; no whole-page raster is needed.
  for (const node of options.tree.nodesById.values()) {
    if (node.tagName !== 'CANVAS' || !element.contains(node.domNode)) continue;
    const bitmap = canvasResource(node.domNode);
    if (bitmap) resources.set(node.domNode, bitmap);
    else resources.delete(node.domNode);
  }
  const { list, box, nodesById } = subtreeDisplayList(element, options);
  const width = Math.ceil(box.width), height = Math.ceil(box.height);
  if (!(width > 0 && height > 0) || width > 8192 || height > 8192 || width * height > 16777216) {
    throw new DOMException('DOM image dimensions exceed the snapshot limit.', 'InvalidStateError');
  }
  // Frame resources are controlled by another document. This internal feature
  // deliberately does not capture frames or browser-owned UI.
  if ([...nodesById.values()].some(node => node.domNode?.tagName === 'IFRAME')) {
    throw new DOMException('DOM images cannot contain frames.', 'NotSupportedError');
  }
  const originClean = list.images.every(isOriginClean);
  const surface = kit.MakeSurface(width, height);
  if (!surface) throw new DOMException('Cannot allocate DOM image.', 'InvalidStateError');
  try {
    surface.getCanvas().clear(kit.TRANSPARENT);
    paint(surface.getCanvas(), list, { x: box.x, y: box.y, width, height }, 1);
    surface.flush();
    const image = surface.makeImageSnapshot();
    if (!image) throw new DOMException('Cannot snapshot DOM image.', 'InvalidStateError');
    const resource = { image, width, height, originClean };
    snapshots.set(resource, { element, image });
    return resource;
  } finally { surface.dispose(); }
}

/** Consume ephemeral sources even if drawImage rejects its arguments. */
export function drawQmlDomImage(resource, target, context, args) {
  const snapshot = resource && snapshots.get(resource);
  if (!snapshot) return false;
  snapshots.delete(resource);
  try {
    if (snapshot.element.contains(target)) {
      throw new DOMException('DOM image source contains the destination canvas.', 'InvalidStateError');
    }
    context.drawImage(snapshot.image, ...args.slice(1));
    return true;
  } finally { snapshot.image.delete(); }
}
