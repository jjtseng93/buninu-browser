import {afterAll, beforeAll, expect, test} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

let host;
beforeAll(async () => {
  host = new RendererHost({timeout: 20000});
  await host.start();
  await host.call('loadDocument', {
    url: 'https://test.local/', contentType: 'text/html',
    source: '<!doctype html><input value="unchanged">',
  });
  await host.call('whenLoaded');
});
afterAll(() => host?.close());

test('synthetic clipboard events preserve data identity and dispatch without editing', async () => {
  const result = await host.call('evaluate', `JSON.stringify((() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'synthetic text');
    const event = new ClipboardEvent('paste', {clipboardData: data, bubbles: true, cancelable: true});
    const input = document.querySelector('input');
    let received;
    input.addEventListener('paste', e => { received = e; e.preventDefault(); });
    const dispatched = input.dispatchEvent(event);
    return [event instanceof ClipboardEvent, event instanceof Event,
      event.clipboardData === data, received === event, event.isTrusted,
      event.composed, dispatched, input.value, event.clipboardData.getData('text/plain'),
      new ClipboardEvent('copy').clipboardData, 'clipboardData' in new Event('copy')];
  })())`);
  expect(JSON.parse(result)).toEqual([
    true, true, true, true, false, false, false, 'unchanged', 'synthetic text', null, false,
  ]);
});

test('clipboard event constructor rejects absent type and invalid data', async () => {
  const result = await host.call('evaluate', `JSON.stringify([
    () => new ClipboardEvent(), () => ClipboardEvent('paste'),
    () => new ClipboardEvent('paste', {clipboardData: {}})
  ].map(action => { try { action(); return 'accepted'; } catch (e) { return e.name; } }))`);
  expect(JSON.parse(result)).toEqual(['TypeError', 'TypeError', 'TypeError']);
});
