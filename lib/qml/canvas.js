// QML lifecycle adapter; all pixels and drawing commands use HTML Canvas 2D.
export function createQmlCanvas(api) {
  const {effect, untrack, emit, cleanup} = api;
  function make(v, type, element) {
    if (type !== 'Canvas') return;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none';
    element.appendChild(canvas);
    let frame, disposed = false, ready = false;
    const callbacks = new Set();
    Object.assign(v, {available:false, contextType:'2d', canvasSize:{width:0,height:0}});
    const context = canvas.getContext('2d');
    // QML Context2D.reset resets state and pixels. Reuse HTML canvas's
    // dimension-reset behavior when the underlying 2D implementation lacks it.
    const qmlContext = new Proxy(context, {
      get(target, key) {
        if (key === 'reset' && typeof target.reset !== 'function') return () => {canvas.width = canvas.width;};
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, key, value) {target[key]=(key==='fillStyle'||key==='strokeStyle') && value && typeof value==='object' && 'r' in value ? api.cssColor(value) : value;return true;},
    });
    v.getContext = type => type === '2d' ? qmlContext : null;
    Object.defineProperty(v, 'context', {get:()=>v.contextType === '2d' && v.available ? v.getContext('2d') : null});
    v.requestPaint = () => {
      if (disposed || frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (disposed || !ready) return;
        untrack(() => {
          emit(v, 'onPaint', {x:0,y:0,width:canvas.width,height:canvas.height});
          emit(v, 'onPainted');
        });
      });
    };
    v.markDirty = () => v.requestPaint();
    v.requestAnimationFrame = callback => {
      if (disposed) return 0;
      const id = requestAnimationFrame(time => {callbacks.delete(id);if (!disposed) callback(time);});
      callbacks.add(id);
      return id;
    };
    v.cancelRequestAnimationFrame = id => {callbacks.delete(id);cancelAnimationFrame(id);};
    effect(() => {
      const w = Math.max(0,Math.ceil(v.canvasSize.width || v.width));
      const h = Math.max(0,Math.ceil(v.canvasSize.height || v.height));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      untrack(() => {ready=true;v.available=true;v.requestPaint();});
    });
    cleanup(() => {disposed=true;cancelAnimationFrame(frame);for (const id of callbacks) cancelAnimationFrame(id);callbacks.clear();});
  }
  return {make};
}
