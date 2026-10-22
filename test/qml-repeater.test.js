import {test, expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

test('Repeater scopes delegates, updates models, preserves sibling order and disposes old handlers', async () => {
  const host=new RendererHost({timeout:20000});
  try {
    await host.start();
    await host.call('loadDocument',{url:'https://qml.test/repeater.qml',contentType:'text/x-qml',source:`
import QtQuick
Rectangle {
 id: root; width: 600; height: 300
 property var items: [10,20,30]
 property int clicks: 0
 property int factor: 2
 Text {id: before; text: "before"}
 Repeater {
  id: list; model: root.items
  delegate: Rectangle {
   id: cell
   required property var modelData
   required property int index
   x: index*100; y: 50; width: 90; height: 40
   Text {text: cell.index+":"+cell.modelData*root.factor; anchors.horizontalCenter: parent.horizontalCenter}
   TapHandler {gesturePolicy: TapHandler.ReleaseWithinBounds; onTapped: root.clicks++}
  }
 }
 Text {id: after; text: "after"}
 Text {id: status; text: root.clicks+":"+list.count}
 Button {id: replace; onClicked: {root.items=[7,8];root.factor=3}}
 Button {id: clear; onClicked: root.items=[]}
}`});
    await host.call('whenLoaded');
    const texts=()=>host.call('evaluate','JSON.stringify([...document.querySelectorAll("[data-qml-type=Text]")].map(e=>e.textContent))');
    expect(JSON.parse(await texts())).toEqual(['before','0:20','1:40','2:60','after','0:3']);
    await host.call('evaluate',`globalThis.oldCell=document.querySelector('[data-qml-type=Repeater]').previousElementSibling;oldCell.click()`);
    expect(await host.call('evaluate','document.getElementById("status").textContent')).toBe('1:3');
    await host.call('evaluate','document.getElementById("replace").click()');
    expect(JSON.parse(await texts())).toEqual(['before','0:21','1:24','after','1:2']);
    await host.call('evaluate','oldCell.click()');
    expect(await host.call('evaluate','document.getElementById("status").textContent')).toBe('1:2');
    await host.call('evaluate','document.getElementById("clear").click()');
    expect(JSON.parse(await texts())).toEqual(['before','after','1:0']);
  } finally {host.close();}
},30000);

test('nested numeric Repeaters keep instance IDs local and allow later outer IDs', async () => {
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();
  await host.call('loadDocument',{url:'https://qml.test/nested.qml',contentType:'text/x-qml',source:`
import QtQuick
Item {
 Repeater {
  model: 2
  delegate: Item {
   id: row
   required property int index
   Repeater {
    model: 2
    delegate: Text {
     required property int index
     text: suffix.text+":"+row.index+":"+index
    }
   }
  }
 }
 Text {id: suffix; text: "item"}
}`});
  await host.call('whenLoaded');
  expect(JSON.parse(await host.call('evaluate','JSON.stringify([...document.querySelectorAll("[data-qml-type=Text]")].map(e=>e.textContent))'))).toEqual(['item:0:0','item:0:1','item:1:0','item:1:1','item']);
 }finally{host.close();}
},30000);
