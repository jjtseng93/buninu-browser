// Image bytes are decoded by our renderer, not Happy DOM's disabled loader.
// Share their state with HTMLImageElement's page-facing IDL attributes.
const states = new WeakMap();

export function beginImageLoad(element, src) {
  states.set(element, { src, complete: false, width: 0, height: 0 });
}

export function finishImageLoad(element, src, resource, dispatch = () => {}) {
  if (element.getAttribute('src') !== src) return;
  states.set(element, { src, complete: true, width: resource?.width ?? 0, height: resource?.height ?? 0 });
  dispatch(resource ? 'load' : 'error');
}

export function installImageLoadingAttributes(prototype, nodeOf) {
  for (const [property, field] of [['naturalWidth', 'width'], ['naturalHeight', 'height'], ['complete', 'complete']]) {
    Object.defineProperty(prototype, property, {
      configurable: true, enumerable: true,
      get() {
        const node = nodeOf(this), src = node.getAttribute('src');
        const state = states.get(node);
        if (state && state.src === src) return state[field];
        return field === 'complete' ? !src : 0;
      },
    });
  }
}
