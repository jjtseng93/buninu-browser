import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBrowser } from '../lib/headless-shell.js';

const html = () => new Response('<!doctype html><title>new origin</title><p>page</p>', {
  headers: { 'content-type': 'text/html' },
});
function site(handler) {
  return Bun.serve({ port: 0, fetch: request => handler?.(request) ?? html() });
}
const url = (server, path = '/') => `http://127.0.0.1:${server.port}${path}`;
async function exited(pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    await Bun.sleep(20);
  }
  return false;
}

test('the pristine blank keeps its sandbox and PID for the first origin after presentation setup', async () => {
  const server = site();
  const browser = await createBrowser({ webkit: false });
  try {
    const first = browser.rendererPid;
    const sandbox = structuredClone(browser.sandbox);
    expect(first).toBeGreaterThan(0);
    expect(browser.sparePid).toBeNull();
    expect(sandbox.ses).toEqual({ installed: true, reason: null });
    expect(typeof sandbox.seccomp.installed).toBe('boolean');
    await browser.context.title();
    await browser.context.resize(320, 240);
    await browser.context.setUserAgent('InitialRendererTest/1');
    browser.context.addInitScript('window.initRuns=(window.initRuns||0)+1');
    expect(await browser.context.screenshot()).toBeTruthy();
    await browser.context.scrollOffset();
    await browser.context.cdp('Page.getLayoutMetrics');

    await browser.context.navigate(url(server));
    expect(browser.rendererPid).toBe(first);
    expect(browser.sandbox).toEqual(sandbox);
    expect(await browser.context.evaluate('[innerWidth,innerHeight,navigator.userAgent,window.initRuns]'))
      .toEqual([320, 240, 'InitialRendererTest/1', 1]);
    await browser.context.navigate(url(server, '/same-origin'));
    expect(browser.rendererPid).toBe(first);
    await browser.context.navigate(`http://localhost:${server.port}/different-origin`);
    expect(browser.rendererPid).not.toBe(first);
    expect(await exited(first)).toBeTrue();
  } finally { browser.close(); server.stop(true); }
}, 30_000);

test('navigation waiting for initial readiness adopts the blank and runs only retained init scripts', async () => {
  const server = site();
  const browser = await createBrowser({ waitForRenderer: false, spareRenderer: false });
  try {
    let first;
    const initial = browser.ready.then(() => { first = browser.rendererPid; });
    const navigation = browser.context.navigate(url(server));
    const removed = browser.context.addInitScript('window.removedScript=true');
    browser.context.addInitScript('window.initRuns=(window.initRuns||0)+1');
    browser.context.removeInitScript(removed);
    await browser.context.resize(321, 234);
    await Promise.all([initial, navigation]);
    expect(browser.rendererPid).toBe(first);
    expect(await browser.context.evaluate('[innerWidth,innerHeight,window.initRuns,window.removedScript===undefined]'))
      .toEqual([321, 234, 1, true]);
  } finally { browser.close(); server.stop(true); }
}, 30_000);

for (const [name, use] of [
  ['evaluation', context => context.evaluate('window.blankPoison=true')],
  ['javascript navigation', context => context.navigate('javascript:window.blankPoison=true;void 0')],
  ['keyboard input', context => context.press('a')],
  ['reload', context => context.reload()],
  ['explicit blank navigation', context => context.navigate('about:blank')],
  ['data document', context => context.navigate('data:text/html,<script>window.blankPoison=true</script>')],
  ['cleared user agent', async context => {
    await context.setUserAgent('DiscardedOverride/1');
    context.setUserAgent(null);
  }],
]) {
  test(`a blank used by ${name} cannot be assigned to the first HTTP origin`, async () => {
    const server = site();
    const browser = await createBrowser({ spareRenderer: false, webkit: false });
    try {
      const first = browser.rendererPid;
      await use(browser.context);
      await browser.context.navigate(url(server));
      expect(browser.rendererPid).not.toBe(first);
      expect(await browser.context.evaluate('window.blankPoison===undefined')).toBeTrue();
      expect(await browser.context.evaluate('navigator.userAgent')).not.toBe('DiscardedOverride/1');
      expect(await exited(first)).toBeTrue();
    } finally { browser.close(); server.stop(true); }
  }, 30_000);
}

test('a file document followed by HTTP still crosses into a fresh renderer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'initial-renderer-'));
  const file = join(directory, 'page.html');
  await Bun.write(file, '<script>window.blankPoison=true</script><p>local</p>');
  const server = site();
  const browser = await createBrowser({ spareRenderer: false });
  try {
    await browser.context.navigate(pathToFileURL(file).href);
    const local = browser.rendererPid;
    await browser.context.navigate(url(server));
    expect(browser.rendererPid).not.toBe(local);
    expect(await browser.context.evaluate('window.blankPoison===undefined')).toBeTrue();
    expect(await exited(local)).toBeTrue();
  } finally { browser.close(); server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

test('an evaluation queued before startup revokes adoption before it awaits the renderer', async () => {
  const server = site();
  const browser = await createBrowser({ waitForRenderer: false, spareRenderer: false });
  try {
    let first;
    const initial = browser.ready.then(() => { first = browser.rendererPid; });
    const evaluation = browser.context.evaluate('window.blankPoison=true');
    const navigation = browser.context.navigate(url(server));
    await Promise.all([initial, evaluation, navigation]);
    expect(browser.rendererPid).not.toBe(first);
    expect(await browser.context.evaluate('window.blankPoison===undefined')).toBeTrue();
  } finally { browser.close(); server.stop(true); }
}, 30_000);

test('evaluation during the first document fetch prevents adoption', async () => {
  const requested = Promise.withResolvers(), response = Promise.withResolvers();
  const server = site(() => { requested.resolve(); return response.promise; });
  const browser = await createBrowser({ spareRenderer: false });
  try {
    const first = browser.rendererPid;
    const navigation = browser.context.navigate(url(server));
    await requested.promise;
    await browser.context.evaluate('window.blankPoison=true');
    response.resolve(html());
    await navigation;
    expect(browser.rendererPid).not.toBe(first);
    expect(await browser.context.evaluate('window.blankPoison===undefined')).toBeTrue();
  } finally { response.resolve(html()); browser.close(); server.stop(true); }
}, 30_000);

test('the first redirect binds the reused process to the final origin', async () => {
  const server = site(request => new URL(request.url).pathname === '/redirect'
    ? new Response(null, { status: 302, headers: { location: `http://localhost:${server.port}/final` } })
    : html());
  const browser = await createBrowser({ spareRenderer: false });
  try {
    const first = browser.rendererPid;
    await browser.context.navigate(url(server, '/redirect'));
    expect(browser.rendererPid).toBe(first);
    await browser.context.navigate(`http://localhost:${server.port}/same-origin`);
    expect(browser.rendererPid).toBe(first);
    await browser.context.navigate(url(server, '/original-origin'));
    expect(browser.rendererPid).not.toBe(first);
  } finally { browser.close(); server.stop(true); }
}, 30_000);

test('closing during initial startup cancels the acquired renderer', async () => {
  const browser = await createBrowser({ waitForRenderer: false, spareRenderer: false });
  const ready = browser.ready.then(() => null, error => error);
  browser.close();
  expect(await ready).toBeInstanceOf(Error);
  expect(browser.rendererPid).toBeNull();
  expect(browser.sparePid).toBeNull();
}, 30_000);

test('closing during the first fetch cannot install a new renderer afterwards', async () => {
  const requested = Promise.withResolvers(), response = Promise.withResolvers();
  const server = site(() => { requested.resolve(); return response.promise; });
  const browser = await createBrowser({ spareRenderer: false });
  try {
    const first = browser.rendererPid;
    const navigation = browser.context.navigate(url(server)).then(() => null, error => error);
    await requested.promise;
    browser.close();
    response.resolve(html());
    expect(await navigation).toBeInstanceOf(Error);
    expect(browser.rendererPid).toBeNull();
    expect(browser.sparePid).toBeNull();
    expect(await exited(first)).toBeTrue();
  } finally { response.resolve(html()); browser.close(); server.stop(true); }
}, 30_000);
