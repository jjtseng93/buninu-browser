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
