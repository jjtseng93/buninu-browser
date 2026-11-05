import {expect, test} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

test('removed iframe realms stop queued and newly requested work before the next paint', async () => {
  const host = new RendererHost();
  try {
    await host.call('resize', 320, 200, 1);
    await host.call('loadDocument', {url:'https://example.test/',contentType:'text/html',source:'<body></body>'});
    expect(await host.call('evaluate', `
      globalThis.calls = [];
      globalThis.frame = document.createElement('iframe');
      document.body.append(frame);
      globalThis.child = frame.contentWindow;
      // Layout queues an asynchronous child resize; removal must cancel its
      // effects as well as ordinary page tasks.
      globalThis.frameWidth = frame.getBoundingClientRect().width;
      child.setTimeout(() => calls.push('queued timeout'), 0);
      child.setInterval(() => calls.push('queued interval'), 10);
      child.requestAnimationFrame(() => calls.push('queued animation'));
      child.requestIdleCallback(() => calls.push('queued idle'), {timeout:1});
      child.addEventListener('message', () => calls.push('queued message'));
      child.postMessage('queued', '*');
      frame.remove();
      globalThis.handles = [
        child.setTimeout(() => calls.push('late timeout'), 0),
        child.setInterval(() => calls.push('late interval'), 10),
        child.requestAnimationFrame(() => calls.push('late animation')),
        child.requestIdleCallback(() => calls.push('late idle'), {timeout:1})
      ];
      child.postMessage('late', '*');
      globalThis.inactiveFrame = child.document.createElement('iframe');
      child.document.body.append(inactiveFrame);
      // Visibility is not lifetime: a connected hidden document still runs.
      globalThis.hidden = document.createElement('iframe');
      hidden.style.display = 'none'; document.body.append(hidden);
      hidden.contentWindow.setTimeout(() => calls.push('connected timeout'), 0);
      [frame.contentWindow === null, handles.every(id => typeof id === 'number'), inactiveFrame.contentWindow === null, frameWidth > 0];
    `)).toEqual([true, true, true, true]);
    await Bun.sleep(180);
    expect(await host.call('evaluate', 'calls')).toEqual(['connected timeout']);
  } finally { host.close(); }
}, 20000);

test('reinsertion gets a fresh child and stale tasks/load events cannot revive the old child', async () => {
  const host = new RendererHost();
  try {
    await host.call('resize', 320, 200, 1);
    await host.call('loadDocument', {url:'https://example.test/',contentType:'text/html',source:'<body></body>'});
    expect(await host.call('evaluate', `
      globalThis.calls = []; globalThis.loads = 0;
      globalThis.holder = document.createElement('div'); document.body.append(holder);
      globalThis.frame = document.createElement('iframe');
      frame.onload = () => loads++;
      holder.append(frame);
      globalThis.old = frame.contentWindow;
      old.marker = 'old';
      old.document.body.textContent = 'old';
      old.setTimeout(() => calls.push('old'), 0);
      holder.remove(); document.body.append(holder);
      globalThis.fresh = frame.contentWindow;
      fresh.document.body.textContent = 'fresh';
      fresh.document.body.style.background = 'rgb(0, 255, 0)';
      fresh.setTimeout(() => calls.push('fresh'), 0);
      [old !== fresh, old.marker, fresh.document.body.textContent];
    `)).toEqual([true, 'old', 'fresh']);
    await Bun.sleep(180);
    expect(await host.call('evaluate', '[calls, loads, frame.contentWindow === fresh]'))
      .toEqual([['fresh'], 1, true]);
  } finally { host.close(); }
}, 20000);

test('removing an outer iframe disposes descendants in the same DOM operation', async () => {
  const host = new RendererHost();
  try {
    await host.call('resize', 320, 200, 1);
    await host.call('loadDocument', {url:'https://example.test/',contentType:'text/html',source:'<body></body>'});
    expect(await host.call('evaluate', `
      globalThis.calls = [];
      globalThis.outer = document.createElement('iframe'); document.body.append(outer);
      globalThis.child = outer.contentWindow;
      globalThis.inner = child.document.createElement('iframe'); child.document.body.append(inner);
      globalThis.grandchild = inner.contentWindow;
      grandchild.setTimeout(() => calls.push('queued'), 0);
      outer.remove();
      grandchild.requestIdleCallback(() => calls.push('late'));
      child.setTimeout(() => calls.push('parent'), 0);
      typeof grandchild.setInterval(() => calls.push('interval'), 10);
    `)).toBe('number');
    await Bun.sleep(180);
    expect(await host.call('evaluate', 'calls')).toEqual([]);
  } finally { host.close(); }
}, 20000);
