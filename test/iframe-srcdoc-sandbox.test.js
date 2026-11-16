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

test('a srcdoc fragment scrolls without replacing the document or firing load again', async () => {
  const content = `<a id="jump" href="#target">jump</a><div style="height:1200px"></div><h2 id="target">Target</h2><div style="height:400px"></div><script>
    setTimeout(() => { document.getElementById('jump').click();
      setTimeout(() => { parent.fragmentResult = {y:scrollY, text:document.getElementById('target').textContent}; }, 100);
    }, 600);
  </script>`;
  const host = await page('<iframe id="f" srcdoc="'+content.replaceAll('&','&amp;').replaceAll('"','&quot;')+'"></iframe>');
  try {
    expect(await until(host, `document.getElementById('f').contentDocument?.getElementById('target')?.textContent`)).toBe('Target');
    await host.call('evaluate', `globalThis.loads=0; document.getElementById('f').addEventListener('load',()=>globalThis.loads++);`);
    const result = await until(host, 'globalThis.fragmentResult');
    expect(result?.text).toBe('Target');
    expect(result?.y).toBeGreaterThan(0);
    expect(await host.call('evaluate', 'globalThis.loads')).toBe(0);
  } finally { await host.close(); }
}, 20000);

test('physical fragment clicks scroll with scripts disabled and keep the srcdoc document', async () => {
  const host = await page('<iframe id="f" sandbox onload="globalThis.loads=(globalThis.loads||0)+1" srcdoc="<a href=&#34;#目錄&#34;>jump</a><div style=&#34;height:1200px&#34;></div><div id=目錄 style=&#34;height:400px;background:rgb(255,0,0)&#34;>Target</div>"></iframe>');
  try {
    expect(await until(host, 'globalThis.loads')).toBe(1);
    await host.call('click', 28, 28);
    await Bun.sleep(200);
    expect(await host.call('evaluate', 'globalThis.loads')).toBe(1);
    const {loadGraphics} = await import('../lib/renderer/page-renderer.js');
    const k = (await loadGraphics()).CanvasKit;
    const img = k.MakeImageFromEncoded(Buffer.from(await host.call('screenshot', {format:'png'}), 'base64'));
    try {
      expect(Array.from(img.readPixels(50,50,{width:1,height:1,colorType:k.ColorType.RGBA_8888,
        alphaType:k.AlphaType.Unpremul,colorSpace:k.ColorSpace.SRGB}))).toEqual([255,0,0,255]);
    } finally {img.delete();}
  } finally { await host.close(); }
}, 20000);

test('physical iframe links honor the embedder navigation interception', async () => {
  const host = await page('<iframe id="f" data-buninu-navigation sandbox onload="globalThis.loads=(globalThis.loads||0)+1" srcdoc="<a href=&#34;https://example.test/other#目錄&#34;>outside</a>"></iframe>');
  try {
    expect(await until(host, 'globalThis.loads')).toBe(1);
    await host.call('evaluate', `document.getElementById('f').addEventListener('buninu-navigation', e => {globalThis.destination="intercepted";e.preventDefault();});`);
    await host.call('click', 28, 28);
    expect(await host.call('evaluate', 'globalThis.destination')).toBe('intercepted');
    await Bun.sleep(100);
    expect(await host.call('evaluate', 'globalThis.loads')).toBe(1);
  } finally { await host.close(); }
}, 20000);


test('allowing sandboxed fragment scrolling never enables scripts, event handlers or javascript URLs', async () => {
  const attack = "document.getElementById('target').style.background='rgb(0,255,0)'";
  const content = `<body onhashchange="${attack}"><a style="display:block;height:24px" href="#target" onclick="${attack}">jump</a><a style="display:block;height:24px" href="javascript:${attack}">script</a><div style="height:1200px"></div><div id="target" style="height:400px;background:rgb(255,0,0)">Target</div><script>${attack}</script></body>`;
  const host = await page('<iframe id="f" sandbox onload="globalThis.loads=(globalThis.loads||0)+1" srcdoc="'+content.replaceAll('&','&amp;').replaceAll('"','&quot;')+'"></iframe>');
  try {
    expect(await until(host, 'globalThis.loads')).toBe(1);
    await host.call('click', 28, 52); // javascript: link
    await host.call('click', 28, 28); // fragment, with onclick and onhashchange
    await Bun.sleep(200);
    expect(await host.call('evaluate', 'globalThis.loads')).toBe(1);
    expect(await host.call('evaluate', `document.getElementById('f').contentDocument`)).toBe(null);
    expect(await host.call('evaluate', `document.getElementById('f').getAttribute('sandbox')`)).toBe('');
    const {loadGraphics} = await import('../lib/renderer/page-renderer.js');
    const k = (await loadGraphics()).CanvasKit;
    const img = k.MakeImageFromEncoded(Buffer.from(await host.call('screenshot', {format:'png'}), 'base64'));
    try {
      expect(Array.from(img.readPixels(50,50,{width:1,height:1,colorType:k.ColorType.RGBA_8888,
        alphaType:k.AlphaType.Unpremul,colorSpace:k.ColorSpace.SRGB}))).toEqual([255,0,0,255]);
    } finally {img.delete();}
  } finally { await host.close(); }
}, 20000);
