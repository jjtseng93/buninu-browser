const records = new WeakMap();
const documents = new WeakMap();

// Chromium exposes decoded playback frames and frames actually discarded by
// presentation, not an FPS estimate. The WASM decoder does not report corrupt
// pictures, so corruptedVideoFrames stays zero rather than inventing errors.
export function installVideoPlaybackQuality({ prototype, nodeOf, document, read, now }) {
  documents.set(document, { read, now });
  let TypeErrorConstructor = TypeError;
  const error = message => new TypeErrorConstructor(message);
  const receiver = value => {
    const node = nodeOf(value);
    if (node?.namespaceURI !== 'http://www.w3.org/1999/xhtml' || node.tagName !== 'VIDEO')
      throw error('Illegal invocation');
    return node;
  };
  function VideoPlaybackQuality() { throw error('Illegal constructor'); }
  Object.defineProperty(VideoPlaybackQuality, 'prototype', { writable: false });
  const getters = [];
  for (const name of ['creationTime', 'totalVideoFrames', 'droppedVideoFrames', 'corruptedVideoFrames']) {
    const get = function() {
      const record = records.get(this);
      if (!record) throw error('Illegal invocation');
      return record[name];
    };
    getters.push(get);
    Object.defineProperty(VideoPlaybackQuality.prototype, name, { get, configurable: true, enumerable: true });
  }
  Object.defineProperty(VideoPlaybackQuality.prototype, Symbol.toStringTag, { value: 'VideoPlaybackQuality', configurable: true });
  const methods = {
    getVideoPlaybackQuality() {
      const node = receiver(this), owner = documents.get(node.ownerDocument);
      const values = owner?.read(node) ?? { totalVideoFrames: 0, droppedVideoFrames: 0, corruptedVideoFrames: 0 };
      const quality = Object.create(VideoPlaybackQuality.prototype);
      records.set(quality, { creationTime: owner?.now() ?? 0, ...values });
      return quality;
    },
  };
  Object.defineProperty(prototype, 'getVideoPlaybackQuality', {
    value: methods.getVideoPlaybackQuality, writable: true, configurable: true, enumerable: true,
  });
  for (const [name, field] of [['webkitDecodedFrameCount', 'totalVideoFrames'], ['webkitDroppedFrameCount', 'droppedVideoFrames']]) {
    const get = function() { const node = receiver(this); return documents.get(node.ownerDocument)?.read(node)?.[field] ?? 0; };
    getters.push(get);
    Object.defineProperty(prototype, name, { get, configurable: true, enumerable: true });
  }
  return {
    VideoPlaybackQuality,
    initialize(global) {
      TypeErrorConstructor = global.TypeError;
      Object.setPrototypeOf(VideoPlaybackQuality.prototype, global.Object.prototype);
      for (const fn of [VideoPlaybackQuality, methods.getVideoPlaybackQuality, ...getters])
        Object.setPrototypeOf(fn, global.Function.prototype);
    },
  };
}
