import { expect, test } from 'bun:test';
import { createBrowser } from '../lib/headless-shell.js';

function site() {
  return Bun.serve({
    port: 0,
    fetch() {
      return new Response('<!doctype html><title>new document</title><p>page</p>', {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
}

test('early new-document scripts skip the initial blank but run once in later documents', async () => {
  const server = site();
  const browser = await createBrowser({ spareRenderer: false, waitForRenderer: false });
  try {
    browser.context.addInitScript('window.initRuns=(window.initRuns||0)+1');
    await browser.ready;
    expect(await browser.context.evaluate('window.initRuns||0')).toBe(0);
    await browser.context.navigate(`http://127.0.0.1:${server.port}/`);
    expect(await browser.context.evaluate('window.initRuns')).toBe(1);
    await browser.context.reload();
    expect(await browser.context.evaluate('window.initRuns')).toBe(1);
    // A later explicit blank is a new document, unlike the initial empty one.
    await browser.context.navigate('about:blank');
    expect(await browser.context.evaluate('window.initRuns')).toBe(1);
  } finally { browser.close(); server.stop(true); }
}, 30_000);

test('a navigation already waiting for startup receives the latest script registry', async () => {
  const server = site();
  const browser = await createBrowser({ spareRenderer: false, waitForRenderer: false });
  try {
    const navigation = browser.context.navigate(`http://127.0.0.1:${server.port}/`);
    const removed = browser.context.addInitScript('window.removedScript=true');
    browser.context.addInitScript('window.scriptOrder=["first"]');
    browser.context.addInitScript('window.scriptOrder.push("second")');
    browser.context.removeInitScript(removed);
    await navigation;
    expect(await browser.context.evaluate('window.removedScript===undefined')).toBe(true);
    expect(await browser.context.evaluate('window.scriptOrder.join(",")')).toBe('first,second');
  } finally { browser.close(); server.stop(true); }
}, 30_000);

test('scripts registered after initial blank startup still apply only to later documents', async () => {
  const server = site();
  const browser = await createBrowser({ spareRenderer: false });
  try {
    browser.context.addInitScript('window.laterScript=true');
    expect(await browser.context.evaluate('window.laterScript===undefined')).toBe(true);
    await browser.context.navigate(`http://127.0.0.1:${server.port}/`);
    expect(await browser.context.evaluate('window.laterScript')).toBe(true);
  } finally { browser.close(); server.stop(true); }
}, 30_000);
