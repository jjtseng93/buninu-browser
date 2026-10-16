import { afterAll, beforeAll, expect, test } from 'bun:test';
import { RendererHost } from '../lib/renderer/host.js';
import { NetworkService } from '../lib/network/network-service.js';

let renderer;
const active = new Set();
const aborted = [];
beforeAll(async () => {
  const network = new NetworkService({ fetch: async (url, init) => {
    if (url.endsWith('/complete')) return new Response('complete');
    active.add(url);
    if (url.endsWith('/headers')) return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        active.delete(url); aborted.push(url); reject(init.signal.reason);
      }, { once: true });
    });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('first chunk'));
      init.signal.addEventListener('abort', () => {
        active.delete(url); aborted.push(url); controller.error(init.signal.reason);
      }, { once: true });
    } }));
  } });
  renderer = new RendererHost({ network, timeout: 20_000 });
  await renderer.start();
});
afterAll(() => renderer?.close());
const load = () => renderer.call('loadDocument', {
  url: 'https://page.test/', contentType: 'text/html', status: 200,
  source: '<!doctype html><title>fetch lifecycle</title><p>Ready</p>',
});
const evaluate = source => renderer.call('evaluate', source);
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error('condition timed out');
}

test('aborting after response headers errors the streaming body with the supplied reason', async () => {
  await load();
  await evaluate(`window.controller = new AbortController(); window.ready = false;
    fetch('/stream', { signal: controller.signal }).then(response => {
      window.result = 'pending'; window.ready = true;
      response.text().then(text => result = text, error => result = error);
    });`);
  await until(async () => await evaluate('ready'));
  await evaluate(`controller.abort('cancelled body')`);
  await until(async () => await evaluate('result') === 'cancelled body');
  await until(() => active.size === 0);
  expect(aborted).toContain('https://page.test/stream');
});

test('same-origin navigation cancels old document fetches before and after headers', async () => {
  await load();
  await evaluate(`fetch('/body').then(r => r.text()).catch(() => {});
    fetch('/headers').catch(() => {}); undefined;`);
  await until(() => active.size === 2);
  await load();
  await until(() => active.size === 0);
  expect(aborted).toContain('https://page.test/body');
  expect(aborted).toContain('https://page.test/headers');
  expect(await evaluate(`fetch('/complete').then(r => r.text())`)).toBe('complete');
});

test('aborting before headers preserves an arbitrary AbortSignal reason', async () => {
  await load();
  await evaluate(`window.controller = new AbortController(); window.result = 'pending';
    fetch('/headers', {signal: controller.signal}).catch(error => result = error); undefined;`);
  await until(() => active.size === 1);
  await evaluate(`controller.abort('cancelled headers')`);
  await until(async () => await evaluate('result') === 'cancelled headers');
  await until(() => active.size === 0);
  expect(await evaluate('result')).toBe('cancelled headers');
});

test('navigation cancels unfinished image, script and stylesheet resource transfers', async () => {
  await load();
  await evaluate(`const image = document.createElement('img'); image.src = '/image/headers'; document.body.append(image);
    const script = document.createElement('script'); script.src = '/script/headers'; document.head.append(script);
    const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/style/headers'; document.head.append(style);
    undefined;`);
  await until(() => active.size === 3);
  await load();
  await until(() => active.size === 0);
  for (const kind of ['image', 'script', 'style']) expect(aborted).toContain(`https://page.test/${kind}/headers`);
  expect(await evaluate('document.title')).toBe('fetch lifecycle');
});
