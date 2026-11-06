// QML Image uses the browser image loader for raster and inert SVG images alike.
export function createQmlImages(api) {
  const { document, effect, cleanup } = api;
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
