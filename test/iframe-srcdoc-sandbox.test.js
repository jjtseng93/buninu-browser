import {expect, test} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

async function page(body) {
  const host = new RendererHost();
  await host.call('resize', 320, 240, 1);
  await host.call('loadDocument', {url:'https://example.test/', contentType:'text/html', source:`<body>${body}</body>`});
  return host;
}
// Polls an expression until it is truthy: frames load after the parent.
async function until(host, expression, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await host.call('evaluate', expression);
    if (value || Date.now() > end) return value;
    await Bun.sleep(30);
  }
}

test('srcdoc is the frame document, with the embedding page\'s origin', async () => {
  const host = await page('<iframe id="f" srcdoc="<p id=x>from srcdoc</p><script>parent.seen = location.href</script>"></iframe>');
  try {
    expect(await until(host, `document.getElementById('f').contentDocument?.getElementById('x')?.textContent`)).toBe('from srcdoc');
    expect(await host.call('evaluate', `[globalThis.seen, document.getElementById('f').contentWindow.origin]`))
      .toEqual(['about:srcdoc', 'https://example.test']);
  } finally { host.close(); }
}, 20000);

test('srcdoc wins over src, and changing it loads the new markup', async () => {
  const host = await page('<iframe id="f" src="https://example.test/other" srcdoc="<p id=x>one</p>"></iframe>');
  try {
    expect(await until(host, `document.getElementById('f').contentDocument?.getElementById('x')?.textContent`)).toBe('one');
    await host.call('evaluate', `document.getElementById('f').setAttribute('srcdoc', '<p id=x>two</p>')`);
    expect(await until(host, `document.getElementById('f').contentDocument?.getElementById('x')?.textContent === 'two'`)).toBe(true);
  } finally { host.close(); }
}, 20000);

test('an empty sandbox runs no script and gives the document an opaque origin', async () => {
  const host = await page('<iframe id="f" sandbox srcdoc="<p id=x>shown</p><script>parent.ran = true</script>"></iframe>');
  try {
    // The frame loads; its script never runs, and the parent cannot reach its document.
    await Bun.sleep(400);
    expect(await host.call('evaluate', `[globalThis.ran === true, document.getElementById('f').contentDocument]`)).toEqual([false, null]);
  } finally { host.close(); }
}, 20000);

test('allow-scripts runs script but keeps the origin opaque; allow-same-origin restores it', async () => {
  const host = await page(`
    <script>globalThis.messages = []; addEventListener('message', (event) => messages.push(event.data))</script>
    <iframe id="a" sandbox="allow-scripts" srcdoc="<script>parent.postMessage(String(self.origin), '*')</script>"></iframe>`);
  try {
    expect(await until(host, `messages.length && messages[0]`)).toBe('null');
    expect(await host.call('evaluate', `document.getElementById('a').contentDocument`)).toBe(null);
    await host.call('evaluate', `
      const frame = document.createElement('iframe');
      frame.id = 'b';
      frame.setAttribute('sandbox', 'ALLOW-SCRIPTS allow-same-origin');
      frame.srcdoc = '<p id=x>same</p>';
      document.body.append(frame);`);
    expect(await until(host, `document.getElementById('b').contentDocument?.getElementById('x')?.textContent`)).toBe('same');
  } finally { host.close(); }
}, 20000);

test('a sandboxed frame without allow-forms does not submit forms', async () => {
  const host = await page(`<iframe id="f" sandbox="allow-scripts allow-same-origin" srcdoc="<form action='https://example.test/next'><button id=go>go</button></form>"></iframe>`);
  try {
    expect(await until(host, `!!document.getElementById('f').contentDocument?.getElementById('go')`)).toBe(true);
    await host.call('evaluate', `document.getElementById('f').contentDocument.getElementById('go').click()`);
    await Bun.sleep(300);
    expect(await host.call('evaluate', `document.getElementById('f').contentWindow.location.href`)).toBe('about:srcdoc');
  } finally { host.close(); }
}, 20000);

test('the sandbox attribute applies when the frame next navigates', async () => {
  const host = await page('<iframe id="f" srcdoc="<p id=x>open</p>"></iframe>');
  try {
    expect(await until(host, `document.getElementById('f').contentDocument?.getElementById('x')?.textContent`)).toBe('open');
    // Setting sandbox alone changes nothing for the current document.
    await host.call('evaluate', `document.getElementById('f').setAttribute('sandbox', '')`);
    expect(await host.call('evaluate', `document.getElementById('f').contentDocument?.getElementById('x')?.textContent`)).toBe('open');
    await host.call('evaluate', `document.getElementById('f').srcdoc = '<p id=x>closed</p>'`);
    await Bun.sleep(400);
    expect(await host.call('evaluate', `document.getElementById('f').contentDocument`)).toBe(null);
  } finally { host.close(); }
}, 20000);
