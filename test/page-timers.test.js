import { afterAll, beforeAll, expect, test } from 'bun:test';
import { RendererHost } from '../lib/renderer/host.js';

const nestingScript = `new Promise(resolve => {
  const gaps = []; let previous = performance.now();
  function step() {
    const now = performance.now(); gaps.push(now - previous); previous = now;
    if (gaps.length === 12) resolve(gaps);
    else Promise.resolve().then(() => {}).then(() => queueMicrotask(() => setTimeout(step, 0)));
  }
  setTimeout(step, 0);
})`;
const intervalScript = `new Promise(resolve => {
  let conversions = 0, calls = 0;
  const id = setInterval(() => {
    if (++calls === 8) { clearTimeout(id); resolve({conversions, calls}); }
  }, {valueOf() { conversions++; return 0; }});
})`;
const scripts = new Map([
  ['/nested.js', `${nestingScript}.then(gaps => postMessage(gaps))`],
  ['/interval.js', `${intervalScript}.then(result => postMessage(result))`],
]);
let renderer;
beforeAll(async () => {
  renderer = new RendererHost({timeout: 20000, fetch: async url => {
    const script = scripts.get(new URL(url).pathname);
    return new Response(script ?? '', {headers: {'content-type': 'text/javascript'}});
  }});
  await renderer.start();
  await renderer.call('loadDocument', {url: 'https://timers.test/', source: '<!doctype html><p>Timers</p>', contentType: 'text/html'});
  await renderer.call('whenLoaded');
});
afterAll(() => renderer?.close());
const evaluate = code => renderer.call('evaluate', code);
const worker = path => evaluate(`new Promise((resolve, reject) => {
  const worker = new Worker(${JSON.stringify(path)});
  worker.onmessage = event => { worker.terminate(); resolve(event.data); };
  worker.onerror = event => { worker.terminate(); reject(Error(event.message)); };
})`);

for (const scope of ['Window', 'Worker']) {
  test(`${scope} preserves nested timer depth through Promise and queueMicrotask`, async () => {
    const gaps = scope === 'Window' ? await evaluate(nestingScript) : await worker('/nested.js');
    expect(gaps).toHaveLength(12);
    // Only a lower bound: a loaded CI host can delay callbacks arbitrarily.
    // The deterministic helper test checks the exact 0/4ms requested sequence.
    expect(gaps.slice(6).reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(20);
  });
  test(`${scope} converts interval delay once and either clear method cancels it`, async () => {
    expect(scope === 'Window' ? await evaluate(intervalScript) : await worker('/interval.js'))
      .toEqual({conversions: 1, calls: 8});
  });
}

test('handler string and delay conversion happen at registration and errors stay synchronous', async () => {
  expect(await evaluate(`new Promise(resolve => {
    const calls = []; globalThis.timerText = '';
    setTimeout({toString() { calls.push('handler'); return 'timerText = "executed"'; }},
      {valueOf() { calls.push('delay'); return 0; }});
    calls.push('registered');
    for (const delay of [1n, Symbol()]) {
      try { setTimeout(() => {}, delay); calls.push('accepted'); }
      catch (error) { calls.push(error.name); }
    }
    setTimeout(() => resolve({calls, timerText}), 20);
  })`)).toEqual({calls: ['handler', 'delay', 'registered', 'TypeError', 'TypeError'], timerText: 'executed'});
});
