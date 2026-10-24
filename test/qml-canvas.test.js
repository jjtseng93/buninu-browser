import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
test('QML Canvas paints into HTML canvas and repaints after resize and property changes',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start();
  await host.call('loadDocument',{url:'data:text/x-qml,canvas',contentType:'text/x-qml',source:`import QtQuick
Canvas {id: c; width:16;height:16;property color ink:"red"
onInkChanged:requestPaint()
onPaint:{var ctx=getContext("2d");ctx.reset();ctx.fillStyle=ink;ctx.fillRect(0,0,width,height);globalThis.paints=(globalThis.paints||0)+1;}
Component.onCompleted:globalThis.canvasObject=c
}`});
  await host.call('whenLoaded');
  for(let i=0;i<100;i++){if(await host.call('evaluate','globalThis.paints>0'))break;await Bun.sleep(10);}
  expect(await host.call('evaluate','Array.from(document.querySelector("canvas").getContext("2d").getImageData(8,8,1,1).data)')).toEqual([255,0,0,255]);
  await host.call('evaluate','canvasObject.ink="blue";canvasObject.width=32;canvasObject.requestPaint();canvasObject.requestPaint()');
  for(let i=0;i<100;i++){if(await host.call('evaluate','document.querySelector("canvas").width===32 && globalThis.paints>1'))break;await Bun.sleep(10);}
  expect(await host.call('evaluate','Array.from(document.querySelector("canvas").getContext("2d").getImageData(24,8,1,1).data)')).toEqual([0,0,255,255]);
  expect(await host.call('evaluate','canvasObject.available')).toBe(true);
 }finally{host.close();}
},20000);
