import { expect, test } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';
import * as symbols from '../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

const tick = () => new Promise(resolve => queueMicrotask(resolve));

test('multiple windows share notification ordering and one closing window cannot cancel another', async () => {
  const first = parseHTMLDocument('<div></div>'), second = parseHTMLDocument('<div></div>');
  const events = [];
  try {
    const older = new first.window.MutationObserver(() => events.push('older'));
    const newer = new second.window.MutationObserver(() => events.push('newer'));
    older.observe(first.document.body, { attributes: true });
    newer.observe(second.document.body, { attributes: true });
    second.document.body.setAttribute('x', '1');
    queueMicrotask(() => events.push('promise'));
    first.document.body.setAttribute('x', '1');
    await tick();
    expect(events).toEqual(['older', 'newer', 'promise']);
    events.length = 0;
    first.document.body.setAttribute('x', '2');
    second.document.body.setAttribute('x', '2');
    const closing = first.window.happyDOM.close();
    await tick(); await closing;
    expect(events).toEqual(['newer']);
    second.document.body.setAttribute('x', '3'); await tick();
    expect(events).toEqual(['newer', 'newer']);
  } finally { await first.window.happyDOM.close(); await second.window.happyDOM.close(); }
});

test('window teardown disconnects every observer including cross-document and detached targets', async () => {
  const first = parseHTMLDocument('<div><span></span></div>'), second = parseHTMLDocument('<div></div>');
  const target = first.document.querySelector('div'), child = target.firstChild, other = second.document.body;
  let calls = 0;
  try {
    const observers = Array.from({ length: 3 }, () => new first.window.MutationObserver(() => calls++));
    for (const observer of observers) {
      observer.observe(first.document.body, { attributes: true, subtree: true });
      observer.observe(other, { attributes: true });
    }
    target.remove(); child.setAttribute('x', '1'); other.setAttribute('x', '1');
    await first.window.happyDOM.close(); await tick();
    expect(calls).toBe(0);
    for (const node of [target, child, other]) expect(node[symbols.mutationListeners]).toHaveLength(0);
    for (const observer of observers) expect(observer.takeRecords()).toEqual([]);
    child.setAttribute('x', '2'); other.setAttribute('x', '2'); await tick();
    expect(calls).toBe(0);
  } finally { await first.window.happyDOM.close(); await second.window.happyDOM.close(); }
});

test('repeated subtree moves retain only live registrations and disconnect releases every listener', async () => {
  const { window, document } = parseHTMLDocument('<section><div><span></span></div><aside></aside></section>');
  const root = document.querySelector('section'), parent = root.firstChild, child = parent.firstChild, other = root.lastChild;
  const nodes = [root, parent, child, other]; const seen = [];
  try {
    const observer = new window.MutationObserver(records => seen.push(records.length));
    observer.observe(root, { attributes: true, childList: true, subtree: true });
    observer.observe(parent, { attributes: true, subtree: true });
    for (let round = 0; round < 10; round++) {
      parent.remove(); child.remove(); other.appendChild(child); root.appendChild(parent);
      parent.appendChild(child); parent.remove(); root.appendChild(parent);
      await tick();
      expect(nodes.map(node => node[symbols.mutationListeners].length)).toEqual([1, 2, 2, 1]);
    }
    parent.remove(); child.remove(); observer.disconnect();
    for (const node of nodes) expect(node[symbols.mutationListeners]).toHaveLength(0);
    const count = seen.length; child.setAttribute('after', '1'); await tick();
    expect(seen).toHaveLength(count);
  } finally { await window.happyDOM.close(); }
});

test('callback exceptions are reported without aborting later observers', async () => {
  const { window, document } = parseHTMLDocument('<div></div>');
  const events = [];
  try {
    window.addEventListener('error', event => { events.push(event.message); event.preventDefault(); });
    const first = new window.MutationObserver(() => { events.push('first'); throw new Error('expected-observer-error'); });
    const second = new window.MutationObserver(() => events.push('second'));
    for (const observer of [first, second]) observer.observe(document.body, { attributes: true });
    document.body.setAttribute('x', '1'); await tick();
    expect(events).toEqual(['first', 'expected-observer-error', 'second']);
  } finally { await window.happyDOM.close(); }
});

test('SES observer delivery agrees with Chromium for batching, options and callback mutations', async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/mutation-observer.js', import.meta.url).pathname],
    { stdout: 'pipe', stderr: 'pipe' });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe('');
  expect(exit).toBe(0);
}, 15_000);
