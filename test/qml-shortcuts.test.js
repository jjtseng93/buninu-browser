import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
test('Instantiator owns Shortcut delegates and deactivation removes keyboard handlers',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start();
  await host.call('loadDocument',{url:'data:text/x-qml,shortcuts',contentType:'text/x-qml',source:`import QtQuick
import QtQml.Models
Item {
 property int hits:0
 Instantiator {id:inst;model:["Ctrl+L", "Shift+N", "?", "Ctrl+K, Ctrl+C"]
 delegate:Shortcut {autoRepeat:false;sequence:modelData;onActivated:globalThis.pressed.push(index)}
 }
 Shortcut {sequence:"X";onActivated:globalThis.bad=true;onActivatedAmbiguously:globalThis.amb=(globalThis.amb||0)+1}
 Shortcut {sequence:"X";onActivated:globalThis.bad=true;onActivatedAmbiguously:globalThis.amb=(globalThis.amb||0)+1}
 Shortcut {id:probe;enabled:false;sequence:"ctrl+l"}
 Component.onCompleted:{globalThis.pressed=[];globalThis.inst=inst;globalThis.probe=probe;}
}`});
  await host.call('whenLoaded');
  const key=async(key,mods={})=>host.call('evaluate',`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true,...${JSON.stringify(mods)}}))`);
  expect(await host.call('evaluate','inst.count')).toBe(4);
  expect(await host.call('evaluate','probe.portableText')).toBe('Ctrl+L');
  expect(await host.call('evaluate','inst.objectAt(0).parent===inst')).toBe(true);
  await key('l',{ctrlKey:true,repeat:true});
  expect(await host.call('evaluate','pressed')).toEqual([]);
  await key('x');
  expect(await host.call('evaluate','[globalThis.amb,!!globalThis.bad]')).toEqual([2,false]);
  await key('l',{ctrlKey:true});await key('N',{shiftKey:true});await key('?',{shiftKey:true});
  await key('k',{ctrlKey:true});await key('c',{ctrlKey:true});
  expect(await host.call('evaluate','pressed')).toEqual([0,1,2,3]);
  await host.call('evaluate','inst.active=false');
  await Bun.sleep(20);await key('l',{ctrlKey:true});
  expect(await host.call('evaluate','inst.count')).toBe(0);
  expect(await host.call('evaluate','inst.object')).toBe(null);
  expect(await host.call('evaluate','pressed')).toEqual([0,1,2,3]);
  await host.call('evaluate','inst.active=true');await Bun.sleep(20);await key('l',{ctrlKey:true});
  expect(await host.call('evaluate','pressed')).toEqual([0,1,2,3,0]);
 }finally{host.close();}
},20000);
