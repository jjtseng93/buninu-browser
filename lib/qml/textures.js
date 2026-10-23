// Serialized into the QML realm. Snapshot ownership stays in ordinary canvases.
export function createQmlTextures(api) {
  const { elements, state, effect, untrack, signal, cleanup } = api;
  const entries = new WeakMap(), refs = new WeakMap(), pending = new Set();
  const reference = value => {
    let ref = refs.get(value);
    if (!ref) refs.set(value, ref = state({ count: 0, hidden: 0 }));
    return ref;
  };
  function attach(value, delta, hide) {
    if (!value) return;
    const ref = reference(value);
    ref.count += delta;
    if (hide) ref.hidden += delta;
    const element = elements.get(value);
    if (element) {
      if (ref.count) element.setAttribute('data-qml-texture-source', '');
      else element.removeAttribute('data-qml-texture-source');
      if (ref.hidden || (!value.visible && ref.count)) element.setAttribute('data-qml-source-hidden', '');
      else element.removeAttribute('data-qml-source-hidden');
    }
  }
  function make(v, type, element) {
    if (type !== 'ShaderEffectSource') return;
    if (!api.host) throw Error('ShaderEffectSource requires a local QML host renderer');
    Object.assign(v, { sourceItem: null, sourceRect: { x: 0, y: 0, width: 0, height: 0 },
      textureSize: { width: 0, height: 0 }, hideSource: false, live: true,
      scheduledUpdateCompleted: signal() });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none';
    canvas.setAttribute('data-qml-texture', '');
    element.appendChild(canvas);
    const entry = { canvas, revision: state({ value: 0 }), ready: false };
    entries.set(v, entry);
    let source = null, hiding = false, observer, frame, disposed = false, requested = true;
    const queue = () => {
      if (!disposed && frame === undefined) { pending.add(capture); frame = requestAnimationFrame(capture); }
    };
    const capture = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      pending.delete(capture);
      frame = undefined;
      if (disposed || !source || !requested) return;
      const input = elements.get(source);
      if (!input?.isConnected || !(source.width > 0 && source.height > 0)) return;
      const rect = v.sourceRect;
      const sw = rect.width > 0 ? rect.width : source.width;
      const sh = rect.height > 0 ? rect.height : source.height;
      const w = Math.ceil(v.textureSize.width > 0 ? v.textureSize.width : sw);
      const h = Math.ceil(v.textureSize.height > 0 ? v.textureSize.height : sh);
      if (!(w > 0 && h > 0) || w > 8192 || h > 8192 || w * h > 16777216)
        throw Error('QML texture exceeds snapshot size limit');
      requested = false;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(input, rect.width > 0 ? rect.x : 0, rect.height > 0 ? rect.y : 0, sw, sh, 0, 0, w, h);
      entry.ready = true;
      entry.revision.value++;
      // Only signal once pixels are actually in the destination canvas.
      v.scheduledUpdateCompleted();
    };
    v.scheduleUpdate = () => { requested = true; queue(); };
    effect(() => {
      const next = v.sourceItem, hide = v.hideSource;
      const live = v.live;
      const size = v.textureSize, rect = v.sourceRect;
      size.width; size.height; rect.x; rect.y; rect.width; rect.height;
      if (next) { next.width; next.height; next.visible; }
      untrack(() => {
        if (next !== source || hide !== hiding) {
          observer?.disconnect();
          attach(source, -1, hiding);
          source = next; hiding = hide;
          attach(source, 1, hiding);
          if (source) {
            const input = elements.get(source);
            if (!input) throw Error('ShaderEffectSource.sourceItem must be an Item');
            observer = new MutationObserver(() => {
              if (v.live) { requested = true; queue(); }
            });
            observer.observe(input, { subtree: true, attributes: true, childList: true, characterData: true });
          } else {
            entry.ready = false;
            canvas.width = canvas.height = 1;
            entry.revision.value++;
          }
        }
        if (live || !entry.ready || requested) { requested = true; queue(); }
      });
    });
    cleanup(() => {
      disposed = true;
      pending.delete(capture);
      observer?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      untrack(() => attach(source, -1, hiding));
      canvas.width = canvas.height = 1;
      canvas.remove();
      entries.delete(v);
    });
  }
  function keepLayout(v) {
    const ref = reference(v);
    const keep = ref.count > 0;
    const element = elements.get(v);
    const hidden = ref.hidden > 0 || (keep && !v.visible);
    if (element && element.hasAttribute('data-qml-source-hidden') !== hidden) {
      if (hidden) element.setAttribute('data-qml-source-hidden', '');
      else element.removeAttribute('data-qml-source-hidden');
    }
    return keep;
  }
  function image(v) {
    const entry = entries.get(v);
    if (!entry) throw Error('ShapePath.fillItem currently requires ShaderEffectSource');
    entry.revision.value;
    return entry.ready ? entry.canvas : null;
  }
  return { make, keepLayout, image, flush: () => { for (const capture of [...pending]) capture(); } };
}
