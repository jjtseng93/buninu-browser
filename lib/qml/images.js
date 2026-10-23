// QML Image uses existing raster decoding or an inert inline SVG DOM. The SVG
// subset matches the browser's renderer; it does not rasterize/re-encode SVG.
export function createQmlImages(api) {
  const { document, effect, host, cleanup } = api;
  const ns = 'http://www.w3.org/2000/svg';
  function svg(source) {
    if (source.length > 4 * 1024 * 1024) throw Error('QML SVG exceeds 4 MiB');
    const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
    const root = parsed.documentElement;
    if (root?.localName !== 'svg' || parsed.querySelector('parsererror'))
      throw Error('Invalid SVG image');
    const supported = new Set([
      'svg',
      'g',
      'path',
      'rect',
      'circle',
      'ellipse',
      'line',
      'polyline',
      'polygon',
    ]);
    const ignored = new Set(['title', 'desc', 'metadata']);
    let nodes = 0;
    function copy(from) {
      if (++nodes > 10000) throw Error('QML SVG element limit');
      if (!supported.has(from.localName))
        throw Error('Unsupported QML SVG element: ' + from.localName);
      const to = document.createElementNS(ns, from.localName);
      for (const attr of from.attributes) {
        if (
          /^on/i.test(attr.name) ||
          ['href', 'xlink:href'].includes(attr.name) ||
          /url\s*\(/i.test(attr.value)
        )
          throw Error('Unsupported active/external QML SVG attribute');
        to.setAttribute(attr.name, attr.value);
      }
      for (const child of from.children) {
        if (!ignored.has(child.localName)) to.appendChild(copy(child));
      }
      return to;
    }
    const element = copy(root),
      box = (root.getAttribute('viewBox') || '')
        .trim()
        .split(/[\s,]+/)
        .map(Number);
    const width = parseFloat(root.getAttribute('width')) || box[2],
      height = parseFloat(root.getAttribute('height')) || box[3];
    if (!(width > 0 && height > 0)) throw Error('SVG image has no dimensions');
    if (!element.hasAttribute('viewBox'))
      element.setAttribute('viewBox', `0 0 ${width} ${height}`);
    return { element, width, height };
  }
  return (v, element, url) => {
    let generation = 0,
      current,
      node = null,
      pendingImage = null;
    const remove = () => {
      node?.remove();
      node = null;
    };
    const fit = () => {
      v.status;
      if (!node) return;
      node.style.position = 'absolute';
      node.style.pointerEvents = 'none';
      node.style.width = v.width + 'px';
      node.style.height = v.height + 'px';
      node.style.left = '0';
      node.style.top = '0';
      node.style.objectFit =
        v.fillMode === 1
          ? 'contain'
          : v.fillMode === 2
            ? 'cover'
            : v.fillMode === 6
              ? 'none'
              : 'fill';
      node.style.imageRendering = v.smooth ? 'auto' : 'pixelated';
      node.style.transform = v.mirror ? 'scaleX(-1)' : '';
      const ratio =
        v.fillMode === 6
          ? 1
          : (v.fillMode === 2 ? Math.max : Math.min)(
              v.width / (v.implicitWidth || 1),
              v.height / (v.implicitHeight || 1),
            );
      v.paintedWidth = [1, 2, 6].includes(v.fillMode)
        ? v.implicitWidth * ratio
        : v.width;
      v.paintedHeight = [1, 2, 6].includes(v.fillMode)
        ? v.implicitHeight * ratio
        : v.height;
      if (node.localName === 'svg') {
        // The inline SVG renderer always preserves its viewBox ratio. Fit by
        // sizing the DOM box, then let the QML wrapper clip crop/pad overflow.
        node.style.width = v.paintedWidth + 'px';
        node.style.height = v.paintedHeight + 'px';
        node.style.left = (v.width - v.paintedWidth) / 2 + 'px';
        node.style.top = (v.height - v.paintedHeight) / 2 + 'px';
      }
      element.style.overflow = 'hidden';
    };
    effect(() => {
      if (current === v.source) return;
      current = v.source;
      const token = ++generation;
      pendingImage?.remove();
      pendingImage = null;
      if (!current) {
        remove();
        v.status = 0;
        v.progress = 0;
        v.implicitWidth = 0;
        v.implicitHeight = 0;
        return;
      }
      if (!v.retainWhileLoading) remove();
      v.status = 2;
      v.progress = 0;
      const source = new URL(current, url).href;
      const ready = (next, width, height) => {
        if (token !== generation) {
          next.remove();
          return;
        }
        remove();
        node = next;
        element.appendChild(node);
        v.implicitWidth = width;
        v.implicitHeight = height;
        v.status = 1;
        v.progress = 1;
        fit();
      };
      const failed = () => {
        if (token === generation) {
          remove();
          v.status = 3;
          v.progress = 0;
        }
      };
      if (
        /\.svg(?:[?#]|$)/i.test(source) ||
        /^data:image\/svg\+xml/i.test(source)
      ) {
        (async () => {
          let text;
          if (source.startsWith('file:')) {
            if (!host) throw Error('Local SVG requires local QML');
            const result = host.read(source);
            if (result.error) throw Error(result.error);
            text = result.text;
          } else {
            const response = await fetch(source);
            if (!response.ok) throw Error('SVG HTTP ' + response.status);
            text = await response.text();
          }
          const result = svg(text);
          ready(result.element, result.width, result.height);
        })().catch(failed);
      } else {
        const image = document.createElement('img');
        pendingImage = image;
        image.style.display = 'none';
        element.appendChild(image);
        image.addEventListener(
          'load',
          () => {
            if (pendingImage === image) pendingImage = null;
            image.style.display = 'block';
            ready(image, image.naturalWidth, image.naturalHeight);
          },
          { once: true },
        );
        image.addEventListener(
          'error',
          () => {
            if (pendingImage === image) pendingImage = null;
            image.remove();
            failed();
          },
          { once: true },
        );
        image.src = source;
      }
    });
    effect(fit);
    cleanup(() => {
      generation++;
      pendingImage?.remove();
      pendingImage = null;
      remove();
    });
  };
}
