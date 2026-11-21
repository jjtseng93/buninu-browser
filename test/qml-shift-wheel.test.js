import { test, expect } from 'bun:test';
import { RendererHost } from '../lib/renderer/host.js';

test('a wheel carries its held keys, and Shift turns it sideways in a Flickable wider than its view', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,shift-wheel',
      contentType: 'text/x-qml',
      source: `
import QtQuick
Item { id:root; width:300;height:200
 Flickable {id:wide;width:200;height:100;contentWidth:600;contentHeight:400;flickableDirection:Flickable.HorizontalAndVerticalFlick
  Rectangle {width:600;height:400;color:"#ccc"} }
 Flickable {id:tall;y:110;width:200;height:80;contentWidth:200;contentHeight:400
  Rectangle {width:200;height:400;color:"#ddd"} }
 Component.onCompleted:{globalThis.wide=wide;globalThis.tall=tall}
 }`,
    });
    await host.call('whenLoaded');
    const at = () => host.call('evaluate', '[wide.contentX,wide.contentY,tall.contentX,tall.contentY].join(",")');
    await host.call('wheel', 50, 50, 0, 40);
    expect(await at()).toBe('0,40,0,0');
    await host.call('wheel', 50, 50, 0, 30, { modifiers: 8 });
    expect(await at()).toBe('30,40,0,0');
    // A view with nothing to its side keeps a Shift+wheel vertical.
    await host.call('wheel', 50, 150, 0, 20, { modifiers: 8 });
    expect(await at()).toBe('30,40,0,20');
    await host.call('wheel', 50, 150, 30, 0, { modifiers: 8 });
    expect(await at()).toBe('30,40,0,20');
  } finally {
    host.close();
  }
}, 30000);

test('HTML wheel listeners receive held keys and physical axes before default scrolling', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', { url: 'data:text/html,wheel', contentType: 'text/html',
      source: '<body style="margin:0"><div style="height:200px;width:200px;background:red"></div></body>' });
    await host.call('whenLoaded');
    await host.call('evaluate', `document.addEventListener('wheel', e => {
      globalThis.lastWheel = [e.deltaX, e.deltaY, e.shiftKey, e.ctrlKey, e.altKey, e.metaKey];
      e.preventDefault();
    }, {passive:false})`);
    expect(await host.call('wheel', 30, 30, 0, 25, { modifiers: 15 })).toEqual({x:0,y:0});
    expect(await host.call('evaluate', 'lastWheel')).toEqual([0,25,true,true,true,true]);
  } finally {
    host.close();
  }
}, 30000);
