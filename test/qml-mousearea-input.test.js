import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

test('rejected MouseAreas focus the underlying input and place its caret',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start();
  await host.call('resize',400,180,1);
  await host.call('loadDocument',{url:'data:text/x-qml,fallthrough-input',contentType:'text/x-qml',source:`import QtQuick
Rectangle {id:scene;width:400;height:180
 property bool block:false
 TextInput {id:field;x:20;y:20;width:200;height:40;text:"abcdef";font.pixelSize:20;selectByMouse:true}
 MouseArea {x:20;y:20;width:200;height:40;z:1;onPressed:mouse=>{mouse.accepted=false}}
 MouseArea {x:20;y:20;width:200;height:40;z:2;onPressed:mouse=>{mouse.accepted=block}}
 Component.onCompleted:globalThis.root=scene
}`});
  await host.call('whenLoaded');
  await host.call('click',21,30);
  expect(await host.call('evaluate','document.activeElement.id')).toBe('field');
  expect(await host.call('evaluate','document.activeElement.selectionStart')).toBe(0);
  await host.call('press','ArrowRight');
  expect(await host.call('evaluate','document.activeElement.selectionStart')).toBe(1);
  await host.call('evaluate','document.activeElement.blur();root.block=true');
  await host.call('click',21,30);
  expect(await host.call('evaluate','document.activeElement.id')).not.toBe('field');
 }finally{host.close()}
},30000);

test('native input editing keeps its text binding for later model changes',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start();
  await host.call('loadDocument',{url:'data:text/x-qml,input-binding',contentType:'text/x-qml',source:`import QtQuick
Item {id:scene;width:300;height:150;property string query:"old"
 TextInput {id:field;width:250;height:40;focus:true;text:scene.query;onTextEdited:scene.query=text}
 Component.onCompleted:globalThis.root=scene
}`});await host.call('whenLoaded');
  await host.call('press','End');await host.call('press','X');
  expect(await host.call('evaluate','root.query')).toBe('oldX');
  await host.call('evaluate','root.query=""');
  expect(await host.call('evaluate','document.getElementById("field").value')).toBe('');
  await host.call('evaluate','root.query="new"');
  expect(await host.call('evaluate','document.getElementById("field").value')).toBe('new');
 }finally{host.close()}
},30000);

test('hidden QML thumbnail geometry maps into a tap containment mask',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start();await host.call('resize',400,200,1);
  await host.call('loadDocument',{url:'data:text/x-qml,hidden-hit',contentType:'text/x-qml',source:`import QtQuick
Item {id:scene;width:400;height:200;property int taps:0
 Item {id:tile;x:100;y:20;width:130;height:124
  Item {x:30;y:12;width:64;height:64
   Image {id:thumb;width:64;height:64;visible:false}
  }
  Item {anchors.fill:parent
   containmentMask:QtObject {function contains(p:point):bool {var q=thumb.mapFromItem(tile,p.x,p.y);return q.x>=0&&q.y>=0&&q.x<64&&q.y<64}}
   TapHandler {onTapped:scene.taps++}
  }
 }
 Component.onCompleted:{globalThis.root=scene;globalThis.tile=tile;globalThis.thumb=thumb}
}`});await host.call('whenLoaded');
  expect(await host.call('evaluate','thumb.mapFromItem(tile,40,22)')).toEqual({x:10,y:10});
  expect(await host.call('evaluate','thumb.mapToItem(tile,10,10)')).toEqual({x:40,y:22});
  // Qt's point and rect overloads: a scene point handed back in, as a menu placed from mapToItem(null, ...) does.
  expect(await host.call('evaluate','thumb.mapFromItem(tile,{x:40,y:22})')).toEqual({x:10,y:10});
  expect(await host.call('evaluate','thumb.mapFromItem(null,thumb.mapToItem(null,7,9))')).toEqual({x:7,y:9});
  expect(await host.call('evaluate','thumb.mapToItem(tile,10,10,5,6)')).toEqual({x:40,y:22,width:5,height:6});
  expect(await host.call('evaluate','thumb.mapToItem(tile,{x:10,y:10,width:5,height:6})')).toEqual({x:40,y:22,width:5,height:6});
  await host.call('click',145,45);
  expect(await host.call('evaluate','root.taps')).toBe(1);
  await host.call('click',105,25);
  expect(await host.call('evaluate','root.taps')).toBe(1);
 }finally{host.close()}
},30000);
