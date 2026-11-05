import { test, expect } from 'bun:test';
import { RendererHost } from '../lib/renderer/host.js';

// Press, hold for `ms`, then release and click on the element with this id.
const hold = async (host, id, ms) => {
  const fire = (type) =>
    host.call(
      'evaluate',
      `(() => { const e = document.getElementById(${JSON.stringify(id)}), r = e.getBoundingClientRect();
        e.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, { bubbles: true, button: 0,
          buttons: ${type === 'mousedown' ? 1 : 0}, clientX: r.x + 5, clientY: r.y + 5, detail: 1 })); })()`,
    );
  await fire('mousedown');
  await Bun.sleep(ms);
  await fire('mouseup');
  await fire('click');
};
const status = (host) =>
  host.call('evaluate', 'document.getElementById("status").textContent');

test('TapHandler long press follows longPressThreshold, and 0 keeps a held press a tap', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,longpress',
      contentType: 'text/x-qml',
      source: `import QtQuick
Item {
 width:200;height:120
 property int taps:0
 property int longs:0
 property int heldTaps:0
 property int heldLongs:0
 Rectangle {id:standard;width:80;height:40;color:"red"
  TapHandler {onTapped:taps++;onLongPressed:longs++}}
 Rectangle {id:held;x:100;width:80;height:40;color:"blue"
  TapHandler {longPressThreshold:0;onTapped:heldTaps++;onLongPressed:heldLongs++}}
 Text {id:status;y:60;text:taps+":"+longs+":"+heldTaps+":"+heldLongs}
}`,
    });
    await host.call('whenLoaded');
    // Default threshold: a quick press taps, a long one is a long press only.
    await hold(host, 'standard', 50);
    expect(await status(host)).toBe('1:0:0:0');
    await hold(host, 'standard', 1100);
    expect(await status(host)).toBe('1:1:0:0');
    // 0 disables the long press, so however long it is held it still taps.
    await hold(host, 'held', 1100);
    expect(await status(host)).toBe('1:1:1:0');
  } finally {
    host.close();
  }
}, 30000);
