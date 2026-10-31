// Image bytes are decoded by our renderer, not Happy DOM's disabled loader.
// Share their state with HTMLImageElement's page-facing IDL attributes.
const states = new WeakMap();
const decodes = new WeakMap();
const encodingError = () => new DOMException('The image cannot be decoded.', 'EncodingError');

export function imageSourceChanged(element) {
  const waiting=decodes.get(element);if(!waiting)return;
  const src=element.getAttribute('src');
  for(const item of waiting)if(item.src!==src){waiting.delete(item);item.reject(encodingError());}
  if(!waiting.size)decodes.delete(element);
}

function decodeImage(element,request) {
  return new Promise((resolve,reject)=>{
    // Like HTML's decode algorithm, inspect the current request in a
    // microtask: img.decode(); img.src=... in the same task is supported.
    queueMicrotask(()=>{
      const src=element.getAttribute('src');
      if(!src){reject(encodingError());return;}
      const state=states.get(element);
      if(state?.src===src&&state.complete){state.decoded?resolve():reject(encodingError());return;}
      const waiting=decodes.get(element)??new Set();
      const item={src,resolve,reject};waiting.add(item);decodes.set(element,waiting);
      try{request(element);}catch(error){waiting.delete(item);reject(error);}
    });
  });
}

export function beginImageLoad(element, src) {
  imageSourceChanged(element);
  states.set(element, { src, complete: false, width: 0, height: 0 });
}

export function finishImageLoad(element, src, resource, dispatch = () => {}) {
  if (element.getAttribute('src') !== src) return;
  states.set(element, { src, complete: true, decoded:!!resource, width: resource?.width ?? 0, height: resource?.height ?? 0 });
  const waiting=decodes.get(element);
  if(waiting){decodes.delete(element);for(const item of waiting){
    if(item.src===src&&resource)item.resolve();else item.reject(encodingError());
  }}
  dispatch(resource ? 'load' : 'error');
}

export function installImageLoadingAttributes(prototype, nodeOf, request = () => {}) {
  Object.defineProperty(prototype,'decode',{configurable:true,enumerable:true,writable:true,
    value:function decode(){return decodeImage(nodeOf(this),request);}});
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
