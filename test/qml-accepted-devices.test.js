import { test, expect } from 'bun:test';
import { RendererHost } from '../lib/renderer/host.js';

// The engine is driven by a mouse only (a touchpad arrives as one): a pointer handler that accepts
// no mouse-like device never fires, as on a desktop Qt, and one that accepts it works as before.
const fire = (host, id, type, buttons) =>
  host.call(
    'evaluate',
    `(() => { const e = document.getElementById(${JSON.stringify(id)}), r = e.getBoundingClientRect();
      (${type === 'mousemove' ? 'document' : 'e'}).dispatchEvent(new MouseEvent(${JSON.stringify(type)}, { bubbles: true, button: 0,
        buttons: ${buttons}, clientX: r.x + 5, clientY: r.y + 5, detail: 1 })); })()`,
  );
const hold = async (host, id, ms) => {
  await fire(host, id, 'mousedown', 1);
  await Bun.sleep(ms);
  await fire(host, id, 'mouseup', 0);
  await fire(host, id, 'click', 0);
};
const status = (host) => host.call('evaluate', 'document.getElementById("status").textContent');

test('acceptedDevices: only mouse-like devices reach a handler, the rest never fire', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,accepted-devices',
      contentType: 'text/x-qml',
      source: `import QtQuick
Item {
 width:300;height:120
 property int mouseTaps:0
 property int touchTaps:0
 property int touchLongs:0
 property int stylusTaps:0
 property int defaultTaps:0
 Rectangle {id:mouse;width:60;height:40;color:"red"
  TapHandler {acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad;onTapped:mouseTaps++}}
 Rectangle {id:touch;x:70;width:60;height:40;color:"blue"
  TapHandler {acceptedDevices: PointerDevice.TouchScreen;onTapped:touchTaps++;onLongPressed:touchLongs++}}
 Rectangle {id:stylus;x:140;width:60;height:40;color:"green"
  TapHandler {acceptedDevices: PointerDevice.Stylus;onTapped:stylusTaps++}}
 Rectangle {id:plain;x:210;width:60;height:40;color:"gray"
  TapHandler {id:plainTap;onTapped:defaultTaps++}}
 Rectangle {id:hoverMouse;y:50;width:60;height:40;color:"red"
  HoverHandler {id:hm;acceptedDevices: PointerDevice.Mouse}}
 Rectangle {id:hoverTouch;x:70;y:50;width:60;height:40;color:"blue"
  HoverHandler {id:ht;acceptedDevices: PointerDevice.TouchScreen}}
 Text {id:status;y:100;text:mouseTaps+":"+touchTaps+":"+touchLongs+":"+stylusTaps+":"+defaultTaps+":"+(plainTap.acceptedDevices===PointerDevice.AllDevices)+":"+hm.hovered+":"+ht.hovered}
}`,
    });
    await host.call('whenLoaded');
    expect(await status(host)).toBe('0:0:0:0:0:true:false:false');
    await hold(host, 'mouse', 50);
    await hold(host, 'plain', 50);
    expect(await status(host)).toBe('1:0:0:0:1:true:false:false');
    // A touch-screen-only handler ignores the mouse, a quick press and a held one alike.
    await hold(host, 'touch', 50);
    await hold(host, 'touch', 1100);
    // So does one for a stylus, which this engine is never given.
    await hold(host, 'stylus', 50);
    expect(await status(host)).toBe('1:0:0:0:1:true:false:false');
    // Hovering follows the same rule.
    await fire(host, 'hoverMouse', 'mousemove', 0);
    expect(await status(host)).toBe('1:0:0:0:1:true:true:false');
    await fire(host, 'hoverTouch', 'mousemove', 0);
    expect(await status(host)).toBe('1:0:0:0:1:true:false:false');
  } finally {
    host.close();
  }
}, 30000);
