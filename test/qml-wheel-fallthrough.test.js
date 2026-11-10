import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
test('rejected stacked QML wheel overlays pass both axes and modifiers exactly once',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
 await host.start();await host.call('resize',400,200,1);
 await host.call('loadDocument',{url:'data:text/x-qml,wheel-fallthrough',contentType:'text/x-qml',source:`import QtQuick
Item {id:scene;width:400;height:200;property bool block:false;property int seen:0;property int calls:0;property real dx:0;property real dy:0;property int mods:0
 MouseArea {anchors.fill:parent;onWheel:e=>{scene.calls++;scene.dx=e.angleDelta.x;scene.dy=e.angleDelta.y;scene.mods=e.modifiers;e.accepted=true}}
 MouseArea {anchors.fill:parent;z:1;onWheel:e=>{e.accepted=false}}
 MouseArea {anchors.fill:parent;z:2;onWheel:e=>{scene.seen++;e.accepted=scene.block}}
 Component.onCompleted:globalThis.root=scene
}`});await host.call('whenLoaded');
 const send=()=>host.call('evaluate','document.elementFromPoint(50,50).dispatchEvent(new WheelEvent("wheel",{bubbles:true,cancelable:true,clientX:50,clientY:50,deltaX:40,deltaY:80,ctrlKey:true}))');
 expect(await host.call('evaluate','(()=>{const e=new WheelEvent("wheel",{clientX:12,clientY:34,deltaZ:5,shiftKey:true});const d=new WheelEvent("wheel");return [e.clientX,e.clientY,e.deltaZ,e.shiftKey,d.clientX,d.clientY]})()')).toEqual([12,34,5,true,0,0]);
 await send();expect(await host.call('evaluate','[root.calls,root.dx,root.dy,root.mods]')).toEqual([1,-40,-80,0x04000000]);
 await host.call('wheel',50,50,40,80);expect(await host.call('evaluate','[root.calls,root.dx,root.dy]')).toEqual([2,-40,-80]);
 await host.call('evaluate','root.block=true');await send();expect(await host.call('evaluate','root.calls')).toBe(2);
 }finally{host.close()}
},30000);
