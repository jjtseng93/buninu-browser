import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

test('Item visibility inherits ancestors while preserving explicit values and bindings',async()=>{
 const h=new RendererHost({timeout:20000});
 try{
  await h.start();
  await h.call('loadDocument',{url:'data:text/x-qml,effective-visible',contentType:'text/x-qml',source:`import QtQuick
Item { id: root; width: 300; height: 200; property bool shown:true
 function rebind(){child.visible=Qt.binding(function(){return root.shown})}
 Item {id:hiddenParent;visible:false;width:100;height:100
  Item {id:child;visible:root.shown;property int changes:0;onVisibleChanged:changes++}
  Item {id:defaultChild}
  Row {id:row;spacing:4;Rectangle {width:10;height:20} Rectangle {width:30;height:20}}

  QtObject {id:metadata;readonly property bool visible:true}
 }
 Item {id:other;width:100;height:100}
 Component.onCompleted:globalThis.fixture={root:root,hidden:hiddenParent,child:child,defaultChild:defaultChild,metadata:metadata,other:other,row:row}
}`});
  await h.call('whenLoaded');
  const run=s=>h.call('evaluate',s);
  const read=()=>run('[fixture.child.visible,fixture.defaultChild.visible,fixture.metadata.visible]');
  expect(await read()).toEqual([false,false,true]);
  expect(await run('[fixture.row.implicitWidth,fixture.row.implicitHeight]')).toEqual([44,20]);
  expect(await run('document.getElementById("defaultChild").style.display')).toBe('block');
  await run('fixture.hidden.visible=true');expect(await read()).toEqual([true,true,true]);
  await run('fixture.hidden.visible=false;fixture.child.visible=true');expect(await read()).toEqual([false,false,true]);
  await run('fixture.root.shown=false;fixture.hidden.visible=true');expect(await read()).toEqual([true,true,true]);
  await run('fixture.root.rebind()');expect(await read()).toEqual([false,true,true]);
  await run('fixture.root.shown=true;fixture.hidden.visible=false;fixture.child.parent=fixture.other');expect(await read()).toEqual([true,false,true]);
  await run('fixture.child.parent=fixture.hidden');expect(await read()).toEqual([false,false,true]);
  await run('fixture.child.visible=false;fixture.hidden.visible=true');expect(await read()).toEqual([false,true,true]);
  expect(await run('fixture.child.changes')).toBeGreaterThan(1);
 }finally{h.close()}
},30000);

test('a timer gated on child.visible stops while an ancestor is hidden and resumes on show',async()=>{
 const h=new RendererHost({timeout:20000});
 try{
  await h.start();await h.call('loadDocument',{url:'data:text/x-qml,hidden-timer',contentType:'text/x-qml',source:`import QtQuick
Item {id:root;visible:false;property int ticks:0
 Item {id:child;Timer {interval:10;repeat:true;running:child.visible;onTriggered:root.ticks++}}
 Component.onCompleted:globalThis.fixture={root:root,child:child}
}`});await h.call('whenLoaded');
  const run=s=>h.call('evaluate',s);
  await Bun.sleep(100);expect(await run('fixture.root.ticks')).toBe(0);
  await run('fixture.root.visible=true');
  for(let i=0;i<30&&!(await run('fixture.root.ticks>0'));i++)await Bun.sleep(20);
  expect(await run('fixture.root.ticks')).toBeGreaterThan(0);
  await run('fixture.root.visible=false');const stopped=await run('fixture.root.ticks');
  await Bun.sleep(100);expect(await run('fixture.root.ticks')).toBe(stopped);
 }finally{h.close()}
},30000);
