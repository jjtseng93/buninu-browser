import { test, expect } from 'bun:test';
import { RendererHost } from '../lib/renderer/host.js';
test('created delegates expose persisted state before completion and are adopted without rebuilding', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,persisted',
      contentType: 'text/x-qml',
      source: `
import QtQuick
import QtQml.Models
Item { id:root; width:300;height:200
 property int built:0; property int gone:0; property var held:null; property string observed:""
 ListView {id:view;width:200;height:100;reuseItems:false
 model:DelegateModel {id:rows;model:100;filterOnGroup:"shown";groups:DelegateModelGroup {id:shown;name:"shown";includeByDefault:false}}
 delegate:Text {id:cell;required property int index; text:"row "+index;width:200;height:20
 Component.onCompleted:{root.built++;root.observed=String(cell.DelegateModel.inPersistedItems)}
 Component.onDestruction:root.gone++ }
 }
 Button {id:create;onClicked:root.held=rows.items.create(0)}
 Button {id:adopt;onClicked:{rows.items.addGroups(0,1,"shown");view.forceLayout();root.held.DelegateModel.inPersistedItems=false}}
 Button {id:shrink;onClicked:{shown.removeGroups(0,1,"shown");view.forceLayout()}}
 Text {id:status;y:140;text:[root.built,root.gone,rows.persistedItems.count,root.observed,view.count].join(":")}
}`,
    });
    await host.call('whenLoaded');
    const click = async (id) => {
      await host.call('evaluate', `document.getElementById('${id}').click()`);
      await host.call('evaluate', '0');
    };
    const status = () =>
      host.call('evaluate', 'document.getElementById("status").textContent');
    await click('create');
    expect(await status()).toBe('1:0:1:true:0');
    await click('create');
    expect(await status()).toBe('1:0:1:true:0');
    await click('adopt');
    expect(await status()).toBe('1:0:0:true:1');
    await click('shrink');
    expect(await status()).toBe('1:1:0:true:0');
  } finally {
    host.close();
  }
}, 30000);

test('a persisted delegate parked without a parent is taken back into the view when laid out', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,persisted-parked',
      contentType: 'text/x-qml',
      source: `
import QtQuick
import QtQml.Models
Item { id:root; width:300;height:200
 property var held:null; property int adopted:0
 GridView {id:view;width:200;height:100;cellWidth:50;cellHeight:50;reuseItems:true
 model:DelegateModel {id:rows;model:100;filterOnGroup:"shown";groups:DelegateModelGroup {id:shown;name:"shown";includeByDefault:false}}
 delegate:Text {id:cell;required property int index; text:"tile "+index;width:50;height:50
 onParentChanged:if (cell.parent === view.contentItem) root.adopted++ }
 }
 Button {id:park;onClicked:{root.held=rows.items.create(0);root.held.parent=null}}
 Button {id:land;onClicked:{rows.items.addGroups(0,4,"shown");view.forceLayout()}}
 Text {id:status;y:140;text:[root.held===null?"none":root.held.parent===view.contentItem?"in view":root.held.parent===null?"no parent":"elsewhere",root.adopted,view.count].join(":")}
}`,
    });
    await host.call('whenLoaded');
    const click = async (id) => {
      await host.call('evaluate', `document.getElementById('${id}').click()`);
      await host.call('evaluate', '0');
    };
    const status = () => host.call('evaluate', 'document.getElementById("status").textContent');
    await click('park');
    expect(await status()).toBe('no parent:0:0');
    // Qt lays a persisted item out in the view's content item; flea's Grid adopts its parked tiles on that parent change.
    await click('land');
    expect(await status()).toBe('in view:1:4');
  } finally {
    host.close();
  }
}, 30000);
