import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

test('Connections catches first synchronous Loader request and follows same-handler target/enabled changes',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start();
  await host.call('loadDocument',{url:'data:text/x-qml,connections-timing',contentType:'text/x-qml',source:`import QtQuick
Rectangle {
 id:root;width:300;height:200;property int received:0;property bool enabledLink:true;property int phase:0
 Component {id:dialog;Item {signal requested();function open(){requested()}}}
 Loader {id:loader;active:false;sourceComponent:dialog}
 Connections {target:loader.item;enabled:root.enabledLink;function onRequested(){root.received++}}
 Text {id:status;text:root.received}
 onClicked:{
  if(phase===0){loader.active=true;loader.item.open()}
  else if(phase===1){root.enabledLink=false;loader.item.open()}
  else if(phase===2){root.enabledLink=true;loader.item.open()}
  else if(phase===3){loader.active=false;loader.active=true;loader.item.open()}
  else loader.item.open()
  phase++
 }
}`});
  await host.call('whenLoaded');
  for(const count of [1,1,2,3,4]){
   await host.call('evaluate',"document.getElementById('root').click()");
   expect(await host.call('evaluate',"Number(document.getElementById('status').textContent)")).toBe(count);
  }
 }finally{host.close()}
},30000);

test('synchronous Loader reaches indirect item bindings before open returns',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start();
  await host.call('loadDocument',{url:'data:text/x-qml,loader-chain',contentType:'text/x-qml',source:`import QtQuick
Rectangle {
 id:root;width:300;height:200;property int received:0
 readonly property var quickLook:loader.item
 property var preview:root.quickLook
 Component {id:dialog;Item {signal requested();function open(){requested()}}}
 Loader {id:loader;active:false;sourceComponent:dialog}
 Connections {target:loader.item;function onRequested(){root.received++}}
 Text {id:status;text:root.received}
 onClicked:{loader.active=true;root.preview.open()}
}`});
  await host.call('whenLoaded');
  await host.call('evaluate',"document.getElementById('root').click()");
  expect(await host.call('evaluate',"Number(document.getElementById('status').textContent)")).toBe(1);
 }finally{host.close()}
},30000);

test('initial property handlers can call child ListView methods in a lazy component',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start();
  await host.call('loadDocument',{url:'data:text/x-qml,loader-child-methods',contentType:'text/x-qml',source:`import QtQuick
Rectangle {
 id:root;width:300;height:200;property int result:-9
 Component {id:preview;Item {
  property bool wrap:true
  onWrapChanged:root.result=list.indexAt(0,1)
  ListView {id:list;width:100;height:100;model:2;delegate:Rectangle {height:20;width:100}}
 }}
 Loader {id:loader;active:false;sourceComponent:preview}
 Text {id:status;text:root.result}
 onClicked:loader.active=true
}`});
  await host.call('whenLoaded');
  await host.call('evaluate',"document.getElementById('root').click()");
  expect(await host.call('evaluate',"Number(document.getElementById('status').textContent)")).toBe(0);
 }finally{host.close()}
},30000);
