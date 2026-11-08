import {expect, test} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
import {NetworkService} from '../lib/network/network-service.js';

const origin = 'https://cookie.test';
const has = (text, name) => text.split('; ').some(pair => pair.startsWith(name + '='));
async function fixture(fetch) {
  const network = new NetworkService({fetch});
  const renderer = new RendererHost({network, timeout: 15000});
  await renderer.start();
  await renderer.call('loadDocument', {url: origin + '/page', source: '<!doctype html><p>Cookies</p>', contentType: 'text/html'});
  return {network, renderer, evaluate: source => renderer.call('evaluate', source)};
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await Bun.sleep(5); }
  throw Error('cookie update did not arrive');
}

test('a redirect cookie reaches document.cookie even when the next hop rejects', async () => {
  const {network, renderer, evaluate} = await fixture(url => {
    if (url.endsWith('/redirect')) return new Response(null, {status: 302, headers: {
      location: '/unavailable', 'set-cookie': 'redirected=yes; Path=/',
    }});
    throw new TypeError('synthetic connection failure');
  });
  try {
    const result = await evaluate("fetch('/redirect').then(() => 'unexpected', () => document.cookie)");
    expect(has(network.documentCookie(origin), 'redirected')).toBe(true);
    expect(has(result, 'redirected')).toBe(true);
  } finally { renderer.close(); }
});

for (const abort of [false, true]) {
  test(`a buffered resource mirrors header cookies before its body ${abort ? 'is aborted' : 'completes'}`, async () => {
    let body;
    const {network, renderer, evaluate} = await fixture((_url, init) => {
      return new Response(new ReadableStream({start(controller) {
        body = controller;
        controller.enqueue(Uint8Array.of(1));
        init.signal?.addEventListener('abort', () => controller.error(init.signal.reason), {once: true});
      }}), {headers: {'set-cookie': 'buffered=yes; Path=/'}});
    });
    const controller = new AbortController();
    let pending;
    try {
      pending = network.subresource(origin + '/slow-body', origin + '/page', 'image', {signal: controller.signal});
      // Observe rejection immediately without changing the body-consumption path.
      const settled = pending.then(() => 'complete', () => 'aborted');
      await until(() => has(network.documentCookie(origin), 'buffered'));
      expect(has(await evaluate('document.cookie'), 'buffered')).toBe(true);
      if (abort) controller.abort(new Error('synthetic abort'));
      else body.close();
      expect(await settled).toBe(abort ? 'aborted' : 'complete');
      expect(has(await evaluate('document.cookie'), 'buffered')).toBe(true);
    } finally {
      controller.abort();
      try { body?.error(new Error('fixture cleanup')); } catch {}
      await pending?.catch(() => {});
      renderer.close();
    }
  });
}

for (const credentials of ['include', 'same-origin', 'omit']) {
  test(`response-cookie notification preserves ${credentials} credentials and CORS failure`, async () => {
    const {network, renderer, evaluate} = await fixture(() => new Response('not CORS readable', {headers: [
      ['set-cookie', 'cross=yes; Domain=cookie.test; Path=/; Secure'],
      ['set-cookie', 'private=yes; Domain=cookie.test; Path=/; Secure; HttpOnly'],
      ['set-cookie', 'foreign=no; Domain=unrelated.test; Path=/'],
    ]}));
    try {
      const result = await evaluate(`fetch('https://other.cookie.test/data', {credentials: ${JSON.stringify(credentials)}})
        .then(() => ({rejected: false}), () => ({rejected: true, cookie: document.cookie}))`);
      expect(result.rejected).toBe(true);
      expect(has(network.documentCookie(origin), 'cross')).toBe(credentials === 'include');
      expect(has(result.cookie, 'cross')).toBe(credentials === 'include');
      expect(has(result.cookie, 'private')).toBe(false);
      expect(has(result.cookie, 'foreign')).toBe(false);
    } finally { renderer.close(); }
  });
}

test('a successful fetch sees response cookies in its first callback before body completion', async () => {
  let body;
  const {network, renderer, evaluate} = await fixture(() => new Response(new ReadableStream({start(controller) {
    body = controller;
  }}), {headers: {'set-cookie': 'success=yes; Path=/'}}));
  try {
    const result = await evaluate("fetch('/success').then(response => ({cookie: document.cookie, status: response.status}))");
    expect(result.status).toBe(200);
    expect(has(result.cookie, 'success')).toBe(true);
    expect(has(network.documentCookie(origin), 'success')).toBe(true);
    body.close();
  } finally {
    try { body?.error(new Error('fixture cleanup')); } catch {}
    renderer.close();
  }
});

test('response-cookie observers can unsubscribe and cannot turn a response into a network error', async () => {
  const network = new NetworkService({fetch: () => new Response('ok', {headers: {'set-cookie': 'observed=yes; Path=/'}})});
  let changes = 0;
  const stopBroken = network.onResponseCookies(() => { throw Error('observer failure'); });
  const stop = network.onResponseCookies(() => { changes++; });
  expect((await network.pageFetch({url: origin + '/first'}, origin + '/page')).status).toBe(200);
  expect(changes).toBe(1);
  stop(); stop(); stopBroken();
  expect((await network.pageFetch({url: origin + '/second'}, origin + '/page')).status).toBe(200);
  expect(changes).toBe(1);
});

test('shared network cookie notifications retain each host origin and tolerate inactive or closed hosts', async () => {
  const network = new NetworkService({fetch: () => new Response('ok', {headers: [
    ['set-cookie', 'shared=yes; Domain=cookie.test; Path=/; Secure'],
    ['set-cookie', 'private=yes; Domain=cookie.test; Path=/; Secure; HttpOnly'],
  ]})});
  const first = new RendererHost({network, timeout: 15000});
  const other = new RendererHost({network, timeout: 15000});
  try {
    // Neither host has a child/document when this response changes the jar.
    await network.pageFetch({url: origin + '/before-start'}, origin + '/page');
    await first.start(); await other.start();
    await first.call('loadDocument', {url: origin + '/page', source: '<!doctype html>', contentType: 'text/html'});
    await other.call('loadDocument', {url: 'https://unrelated.test/page', source: '<!doctype html>', contentType: 'text/html'});
    expect(has(await first.call('evaluate', 'document.cookie'), 'shared')).toBe(true);
    expect(await other.call('evaluate', 'document.cookie')).toBe('');
    await network.pageFetch({url: origin + '/after-start'}, origin + '/page');
    expect(has(await first.call('evaluate', 'document.cookie'), 'shared')).toBe(true);
    expect(has(await first.call('evaluate', 'document.cookie'), 'private')).toBe(false);
    expect(await other.call('evaluate', 'document.cookie')).toBe('');
    first.close();
    expect((await network.pageFetch({url: origin + '/after-close'}, origin + '/page')).status).toBe(200);
    expect(await other.call('evaluate', 'document.cookie')).toBe('');
  } finally { first.close(); other.close(); }
});
