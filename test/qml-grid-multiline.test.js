import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
test('GridLayout fills columns and reflows; PathMultiline creates independent SVG subpaths',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start();
  await host.call('loadDocument',{url:'data:text/x-qml,grid',contentType:'text/x-qml',source:`import QtQuick
import QtQuick.Layouts
import QtQuick.Shapes
Item {width:200;height:100
 GridLayout {id:g;width:200;columns:2;columnSpacing:20;rowSpacing:5
 Rectangle {id:a;implicitWidth:30;implicitHeight:10;Layout.fillWidth:true}
 Rectangle {id:b;implicitWidth:30;implicitHeight:20;Layout.fillWidth:true}
 Rectangle {id:c;implicitWidth:30;implicitHeight:10;Layout.fillWidth:true}
 }
 Shape {ShapePath {strokeColor:"red";fillColor:"transparent";PathMultiline {id:p;paths:[[Qt.point(1,2),Qt.point(3,4)],[Qt.point(5,6),Qt.point(7,8)]]}}}
 Component.onCompleted:{globalThis.g=g;globalThis.cells=[a,b,c];globalThis.pathObject=p;}
}`});
  await host.call('whenLoaded');
  expect(await host.call('evaluate','cells.map(c=>[c.x,c.y,c.width,c.height])')).toEqual([[0,0,90,10],[110,0,90,20],[0,25,90,10]]);
  expect(await host.call('evaluate','document.querySelector("path").getAttribute("d")')).toBe('M1 2 L3 4 M5 6 L7 8');
  await host.call('evaluate','g.width=60');
  await Bun.sleep(20);
  expect(await host.call('evaluate','cells.map(c=>c.width)')).toEqual([20,20,20]);
  await host.call('evaluate','g.width=200;g.columns=1;pathObject.paths=[[{x:9,y:10},{x:11,y:12}]]');
  await Bun.sleep(20);
  expect(await host.call('evaluate','cells.map(c=>[c.x,c.y,c.width])')).toEqual([[0,0,200],[0,15,200],[0,40,200]]);
  expect(await host.call('evaluate','document.querySelector("path").getAttribute("d")')).toBe('M9 10 L11 12');
 }finally{host.close();}
},20000);

test('nested fill layouts retain intrinsic widths when a parent resizes',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start();
  await host.call('loadDocument',{url:'data:text/x-qml,nested-grid',contentType:'text/x-qml',source:`import QtQuick
import QtQuick.Layouts
GridLayout {id:g;width:200;columns:2;columnSpacing:20
 ColumnLayout {id:a;Layout.fillWidth:true;Rectangle {implicitWidth:30;implicitHeight:10;Layout.fillWidth:true}}
 ColumnLayout {id:b;Layout.fillWidth:true;Rectangle {implicitWidth:30;implicitHeight:10;Layout.fillWidth:true}}
 Component.onCompleted:{globalThis.grid=g;globalThis.columns=[a,b]}
}`});
  await host.call('whenLoaded');
  expect(await host.call('evaluate','columns.map(c=>[c.width,c.implicitWidth])')).toEqual([[90,30],[90,30]]);
  await host.call('evaluate','grid.width=400');await Bun.sleep(20);
  expect(await host.call('evaluate','columns.map(c=>[c.width,c.implicitWidth])')).toEqual([[190,30],[190,30]]);
 }finally{host.close();}
},20000);
