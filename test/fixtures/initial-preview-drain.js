import {strict as assert} from 'node:assert';

// Give the renderer a deterministic queued-I/O ordering without weakening its
// production API with test hooks. The timer still fires normally; the response
// is delivered in its following check phase, before a newly scheduled preview
// rendering task. There are no wall-clock performance assertions.
const nativeTimeout = globalThis.setTimeout;
const nativeImmediate = globalThis.setImmediate;
let previewDelay = null, afterDeadline = null, deadlines = 0;
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay === previewDelay && afterDeadline) {
    const action = afterDeadline;afterDeadline = null;
    return nativeTimeout(() => {
      deadlines++;
      callback(...args);
      nativeImmediate(action);
    }, delay);
  }
  return nativeTimeout(callback, delay, ...args);
};
let createPageRenderer;
try {
  const module = await import('../../lib/renderer/page-renderer.js');
  createPageRenderer = module.createPageRenderer;
  previewDelay = module.PREVIEW_DELAY_MS;
} finally {globalThis.setTimeout = nativeTimeout;}

const response = (url, text) => ({ok:true, status:200, url, body:new TextEncoder().encode(text), contentType:'text/css'});
const makeRenderer = async (styles, frames, phases, errors) => createPageRenderer({
  fetchResource(url, kind) {assert.equal(kind, 'stylesheet');return styles.promise;},
  trace:message => phases.push(message),
  reportError:error => errors.push(String(error)),
  onFrame({tile}) {
    if (!tile) return;
    const offset = (10 * tile.pixelWidth + 10) * 4;
    frames.push([...tile.pixels.subarray(offset, offset + 4)]);
  },
});

{
  const styles = Promise.withResolvers(), frames = [], phases = [], errors = [];
  const renderer = await makeRenderer(styles, frames, phases, errors);
  const release = () => styles.resolve(response('https://drain.test/ready.css', 'body{background:green}'));
  try {
    renderer.resize(80,60,1);frames.length = 0;phases.length = 0;
    afterDeadline = release;
    await renderer.loadDocument({url:'https://drain.test/',contentType:'text/html',
      source:'<!doctype html><title>drained</title><link rel="stylesheet" href="/ready.css"><body>'});
    await renderer.whenLoaded();
    assert.equal(deadlines, 1, 'the preview deadline won before CSS was delivered');
    assert.equal(phases.some(message => message.includes(': preview ')), false, 'ready CSS skips the unstyled preview');
    assert.deepEqual(frames[0], [0,128,0,255], 'the first frame already includes the stylesheet');
    assert.deepEqual(errors, []);
  } finally {afterDeadline = null;release();renderer.dispose();}
}

{
  const styles = Promise.withResolvers(), frames = [], phases = [], errors = [];
  const renderer = await makeRenderer(styles, frames, phases, errors);
  const newer = Promise.withResolvers();
  const release = () => styles.resolve(response('https://drain.test/stale.css', 'body{background:red}'));
  try {
    renderer.resize(80,60,1);frames.length = 0;phases.length = 0;
    afterDeadline = () => newer.resolve(renderer.loadDocument({url:'https://drain.test/new',contentType:'text/html',
      source:'<!doctype html><title>newer</title><body style="background:blue">'}));
    await renderer.loadDocument({url:'https://drain.test/stale',contentType:'text/html',
      source:'<!doctype html><title>stale</title><link rel="stylesheet" href="/stale.css"><body style="background:red">'});
    await newer.promise;await renderer.whenLoaded();
    assert.equal(deadlines, 2, 'new navigation arrived during the preview drain');
    assert.equal(phases.some(message => message.startsWith('https://drain.test/stale: preview ')), false);
    assert.ok(frames.length > 0);
    for (const pixel of frames) assert.deepEqual(pixel, [0,0,255,255], 'stale preview cannot overwrite the newer document');
    assert.deepEqual(errors, []);
  } finally {afterDeadline = null;release();renderer.dispose();}
}

process.stdout.write('initial preview scheduling passed\n');
