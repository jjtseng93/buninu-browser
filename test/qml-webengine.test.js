import {expect, test} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

// WebEngineView (lib/qml/media.js) is a sandboxed iframe: loadHtml fills it, script runs only
// with settings.javascriptEnabled, and its document never gets same-origin access.
async function load(javascriptEnabled) {
  const host = new RendererHost();
  await host.call('resize', 320, 240, 1);
  await host.call('loadDocument', {url: 'data:text/x-qml,web', contentType: 'text/x-qml', source: `import QtQuick
import QtWebEngine
Item {
  width: 320; height: 240
  property var init: (globalThis.statuses = [])
  WebEngineView {
    anchors.fill: parent
    settings.javascriptEnabled: ${javascriptEnabled}
    settings.localContentCanAccessRemoteUrls: false
    onLoadingChanged: function (info) { globalThis.statuses.push(info.status) }
    Component.onCompleted: loadHtml('<p id="p">page</p><script>document.getElementById("p").textContent = "ran"; parent.reached = true</script>')
  }
}`});
  await host.call('whenLoaded');
  return host;
}
const until = async (host, expression) => {
  for (let i = 0; i < 100; i++) {
    const value = await host.call('evaluate', expression);
    if (value) return value;
    await Bun.sleep(50);
  }
  return null;
};

test('loadHtml loads the page into a sandboxed frame and reports success', async () => {
  const host = await load(false);
  try {
    expect(await until(host, 'globalThis.statuses.includes(2) && globalThis.statuses')).toEqual([0, 2]);
    const frame = await host.call('evaluate', `(() => { const f = document.querySelector('iframe');
      return { sandbox: f.getAttribute('sandbox'), navigation: f.hasAttribute('data-buninu-navigation'), document: f.contentDocument, reached: globalThis.reached === true }; })()`);
    expect(frame).toEqual({ sandbox: '', navigation: true, document: null, reached: false });
  } finally { await host.close(); }
}, 30000);

test('javascriptEnabled allows script but never same-origin access', async () => {
  const host = await load(true);
  try {
    await until(host, 'globalThis.statuses.length >= 2');
    const frame = await host.call('evaluate', `(() => { const f = document.querySelector('iframe');
      return { sandbox: f.getAttribute('sandbox'), document: f.contentDocument, reached: globalThis.reached === true }; })()`);
    expect(frame).toEqual({ sandbox: 'allow-scripts', document: null, reached: false });
  } finally { await host.close(); }
}, 30000);

test('a view loaded later reports one start and one success, never its initial blank page', async () => {
  const host = new RendererHost();
  try {
    await host.call('resize', 320, 240, 1);
    await host.call('loadDocument', {url: 'data:text/x-qml,web-late', contentType: 'text/x-qml', source: `import QtQuick
import QtWebEngine
Item {
  width: 320; height: 240
  property var init: (globalThis.statuses = [])
  WebEngineView {
    id: view
    anchors.fill: parent
    onLoadingChanged: function (info) { globalThis.statuses.push(info.status) }
  }
  Timer { interval: 300; running: true; onTriggered: view.loadHtml('<p>late</p>') }
}`});
    await host.call('whenLoaded');
    expect(await until(host, 'globalThis.statuses.includes(2) && globalThis.statuses')).toEqual([0, 2]);
    await Bun.sleep(300);
    expect(await host.call('evaluate', 'globalThis.statuses')).toEqual([0, 2]);
  } finally { await host.close(); }
}, 30000);

// A QML MouseArea is an overlay element above the WebEngineView it covers. A wheel it does not
// take reaches the page beneath, as Qt delivers it; one it takes stays with it.
test('a wheel a covering MouseArea does not take scrolls the WebEngineView beneath', async () => {
  const {createBrowser} = await import('../lib/headless-shell.js');
  const {mkdtemp, rm} = await import('node:fs/promises');
  const {join} = await import('node:path');
  const {tmpdir} = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'qml-webengine-wheel-'));
  const html = "<body style='margin:0'>" + Array.from({length: 80}, (_, i) => `<p style='height:30px;margin:0;background:${i % 2 ? '#ccc' : '#888'}'>row ${i}</p>`).join('') + '</body>';
  const browser = await createBrowser({spareRenderer: false});
  const moved = async (overlay) => {
    const file = join(dir, `${overlay.length}.qml`);
    await Bun.write(file, `import QtQuick
import QtWebEngine
Item { width: 400; height: 300
  WebEngineView { anchors.fill: parent; settings.javascriptEnabled: false
    onLoadingChanged: function (info) { if (info.status === 2) globalThis.pageLoaded = true }
    Component.onCompleted: loadHtml(${JSON.stringify(html)}) }
  ${overlay}
}`);
    await browser.context.navigate(Bun.pathToFileURL(file).href);
    for (let i = 0; i < 100 && !(await browser.context.evaluate('globalThis.pageLoaded === true')); i++) await Bun.sleep(50);
    await Bun.sleep(500);
    const before = Bun.hash(await browser.context.screenshot({format: 'png'}));
    for (let i = 0; i < 3; i++) await browser.context.scroll(0, 120, {x: 200, y: 150});
    await Bun.sleep(800);
    return Bun.hash(await browser.context.screenshot({format: 'png'})) !== before;
  };
  try {
    await browser.context.resize(400, 300, 1);
    expect(await moved('MouseArea { anchors.fill: parent; hoverEnabled: true; acceptedButtons: Qt.NoButton }')).toBe(true);
    expect(await moved('MouseArea { anchors.fill: parent; onWheel: function (w) { w.accepted = false } }')).toBe(true);
    expect(await moved('MouseArea { anchors.fill: parent; onWheel: function (w) {} }')).toBe(false);
  } finally { await browser.close(); await rm(dir, {recursive: true, force: true}); }
}, 90000);
