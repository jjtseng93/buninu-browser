import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';

const errors = [], phases = [], frames = [], lifecycle = [];
const styles = Promise.withResolvers();
const response = (url, text, contentType) => ({ok:true, status:200, url, body:new TextEncoder().encode(text), contentType});
const renderer = await createPageRenderer({
  fetchResource(url, kind) {
    if (kind === 'stylesheet') return styles.promise;
    assert.equal(kind, 'image');
    return Promise.resolve(response(url, '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><path fill="red" d="M0 0h32v24H0z"/></svg>', 'image/svg+xml'));
  },
  reportError:error => errors.push(String(error)),
  trace:message => phases.push(message),
  onLifecycle:name => lifecycle.push(name),
  onFrame({tile}) {
    if (!tile) return;
    const offset = (10 * tile.pixelWidth + 10) * 4;
    frames.push([...tile.pixels.subarray(offset, offset + 4)]);
  },
});
const releaseStyles = () => styles.resolve(response('https://preview.test/held.css', 'body{background:green}', 'text/css'));
try {
  renderer.resize(80,60,1);
  phases.length = 0;frames.length = 0;lifecycle.length = 0;
  await renderer.loadDocument({url:'https://preview.test/',contentType:'text/html',
    source:'<!doctype html><title>preview</title><link rel="stylesheet" href="/held.css"><body style="margin:0;background:blue"><img style="display:block" src="/ready.svg">'});
  assert.ok(phases.some(message => message.includes(': preview ')), 'held CSS still permits an initial preview');
  assert.deepEqual(lifecycle, [], 'preview must not complete the document before blocking CSS');
  assert.deepEqual(frames[0], [255,0,0,255], 'already-decoded image appears in the first preview frame');
  releaseStyles();await renderer.whenLoaded();
  assert.deepEqual(lifecycle, ['DOMContentLoaded','load']);
  assert.deepEqual(errors, []);
  process.stdout.write('initial preview resources passed\n');
} finally {
  releaseStyles();renderer.dispose();
}
