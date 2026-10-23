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
