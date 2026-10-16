import { afterAll, beforeAll, expect, test } from 'bun:test';
import { RendererHost } from '../lib/renderer/host.js';
import { NetworkService } from '../lib/network/network-service.js';

let renderer;
const active = new Set();
const aborted = [];
const bodies = new Map();
const binaryBody = new Uint8Array([0, 255, 195, 40, 237, 160, 128, 240, 159, 152, 128]);
beforeAll(async () => {
  const network = new NetworkService({ fetch: async (url, init) => {
    if (url.endsWith('/complete')) return new Response('complete');
    if (url.endsWith('/binary')) return new Response(binaryBody, { headers: { 'content-type': 'application/octet-stream' } });
    active.add(url);
    if (url.endsWith('/headers')) return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        active.delete(url); aborted.push(url); reject(init.signal.reason);
      }, { once: true });
    });
    return new Response(new ReadableStream({ start(controller) {
      bodies.set(url, controller);
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

const startXhr = (path, timeout = 0) => evaluate(`
  window.xhrEvents = [];
  window.xhr = new XMLHttpRequest();
  xhr.timeout = ${timeout};
  for (const type of ['load', 'error', 'abort', 'timeout', 'loadend']) {
    xhr.addEventListener(type, () => xhrEvents.push(type));
  }
  xhr.open('GET', ${JSON.stringify(path)});
  xhr.send();
  undefined;
`);

test('XMLHttpRequest reports body errors after headers and clears the failed response', async () => {
  await load();
  await startXhr('/xhr-body-error');
  await until(async () => await evaluate('xhr.readyState') === 3);
  bodies.get('https://page.test/xhr-body-error').error(new Error('body connection closed'));
  active.delete('https://page.test/xhr-body-error');
  await until(async () => (await evaluate('xhrEvents')).includes('loadend'));
  expect(await evaluate('xhrEvents')).toEqual(['error', 'loadend']);
  expect(await evaluate('[xhr.readyState, xhr.status, xhr.statusText, xhr.responseURL, xhr.response, xhr.responseText, xhr.getAllResponseHeaders()]'))
    .toEqual([4, 0, '', '', null, '', '']);
});

test('XMLHttpRequest abort after headers reports abort even with a configured timeout', async () => {
  await load();
  await startXhr('/xhr-body-abort', 10_000);
  await until(async () => await evaluate('xhr.readyState') === 3);
  await evaluate('xhr.abort()');
  await until(async () => (await evaluate('xhrEvents')).includes('loadend'));
  expect(await evaluate('xhrEvents')).toEqual(['abort', 'loadend']);
  expect(await evaluate('xhr.status')).toBe(0);
  await until(() => active.size === 0);
});

test('XMLHttpRequest timeout after headers reports timeout and releases the transfer', async () => {
  await load();
  await startXhr('/xhr-body-timeout', 100);
  await until(async () => (await evaluate('xhrEvents')).includes('loadend'));
  expect(await evaluate('xhrEvents')).toEqual(['timeout', 'loadend']);
  expect(await evaluate('[xhr.readyState, xhr.status]')).toEqual([4, 0]);
  await until(() => active.size === 0);
});

test('XMLHttpRequest binary response types preserve arbitrary bytes and return their platform types', async () => {
  await load();
  await evaluate(`Headers.prototype.get = function () { throw new Error('page Headers.get hook'); }; undefined;`);
  for (const responseType of ['arraybuffer', 'blob']) {
    const result = await evaluate(`new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('GET', '/binary');
      request.responseType = ${JSON.stringify(responseType)};
      request.onload = async () => {
        const value = request.response;
        const bytes = request.responseType === 'blob' ? await value.arrayBuffer() : value;
        resolve({ bytes: [...new Uint8Array(bytes)], isArrayBuffer: value instanceof ArrayBuffer,
          isBlob: value instanceof Blob, type: value.type ?? null, responseText: request.responseText,
          contentType: request.getResponseHeader('content-type') });
      };
      request.onerror = () => reject(new Error('binary request failed'));
      request.send();
    })`);
    expect(result).toEqual({ bytes: [...binaryBody], isArrayBuffer: responseType === 'arraybuffer',
      isBlob: responseType === 'blob', type: responseType === 'blob' ? 'application/octet-stream' : null,
      responseText: '', contentType: 'application/octet-stream' });
  }
});
