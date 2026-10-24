import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
import {qmlWindowConstraints} from '../lib/qml/window-constraints.js';
test('window constraints normalize and update Wayland size hints',async()=>{
 const calls=[];let hints=['[360,240]','[200,0]'];
 const sync=qmlWindowConstraints({request:(...args)=>calls.push(args)},{toplevel:8,surface:6},{url:'file:///test.qml',evaluate:async()=>hints});
 await sync();await sync();
 expect(calls).toEqual([[8,'set_min_size',360,240],[8,'set_max_size',360,0],[6,'commit']]);
 hints=null;await sync();expect(calls.slice(3)).toEqual([[8,'set_min_size',0,0],[8,'set_max_size',0,0],[6,'commit']]);
});
test('FloatingWindow minimum size, attached window notifications and Button slots',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
 await host.start();
 await host.call('loadDocument',{url:'data:text/x-qml,controls',contentType:'text/x-qml',source:`import QtQuick
import Quickshell
ShellRoot {
 FloatingWindow {id:a;minimumSize:Qt.size(1500,1200)
  Button {id:b;width:100;height:40;padding:5;focusPolicy:Qt.NoFocus
   contentItem:Text {id:label;text:"hello"}
   background:Rectangle {id:bg;color:"red"}
   Window.onWindowChanged:globalThis.changes=(globalThis.changes||0)+1
  }
 }
 FloatingWindow{id:c}
 Component.onCompleted:{globalThis.a=a;globalThis.b=b;globalThis.c=c;globalThis.label=label;globalThis.bg=bg;}
}`});
 await host.call('whenLoaded');
 expect(await host.call('evaluate','[a.width,a.height]')).toEqual([1500,1200]);
 expect(await host.call('evaluate','[label.x,label.y,label.width,label.height,bg.width,bg.height,b.activeFocusOnTab]')).toEqual([5,5,90,30,100,40,false]);
 expect(await host.call('evaluate','b.Window.window===a')).toBe(true);
 const before=await host.call('evaluate','globalThis.changes');
 await host.call('evaluate','b.parent=c');await Bun.sleep(20);
 expect(await host.call('evaluate','b.Window.window===c')).toBe(true);
 expect(await host.call('evaluate','globalThis.changes')).toBe(before+1);
 }finally{host.close();}
},20000);

test('ListModel roles populate required Repeater properties and remain reactive',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
 await host.start();await host.call('loadDocument',{url:'data:text/x-qml,roles',contentType:'text/x-qml',source:`import QtQuick
Item {
 ListModel{id:model}
 Repeater{id:rep;model:model;delegate:Text {required property string key;required property int amount;text:key+amount}}
 Component.onCompleted:{globalThis.rep=rep;globalThis.rows=model;model.append({key:"a",amount:2});}
}`});await host.call('whenLoaded');
 expect(await host.call('evaluate','[rep.count,rep.itemAt(0).text]')).toEqual([1,'a2']);
 await host.call('evaluate','rows.setProperty(0,"amount",3)');await Bun.sleep(20);
 expect(await host.call('evaluate','rep.itemAt(0).text')).toBe('a3');
 }finally{host.close();}
},20000);

test('nested Loader startup preserves outer property notifications',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
 await host.start();await host.call('loadDocument',{url:'data:text/x-qml,nested-notifications',contentType:'text/x-qml',source:`import QtQuick
Item {id:root
 property int counter:0
 onCounterChanged:globalThis.changes=(globalThis.changes||[]).concat([counter])
 Loader {sourceComponent:Item {property size dimensions;property real side:dimensions.width;Component.onCompleted:globalThis.initialSide=side}}
 Component.onCompleted:{globalThis.root=root;counter=1;}
}`});await host.call('whenLoaded');
 expect(await host.call('evaluate','globalThis.initialSide')).toBe(0);
 expect(await host.call('evaluate','globalThis.changes')).toEqual([1]);
 await host.call('evaluate','root.counter=2');await Bun.sleep(20);
 expect(await host.call('evaluate','globalThis.changes')).toEqual([1,2]);
 }finally{host.close();}
},20000);

import {createQt} from '../lib/qml/builtins.js';
test('Qt date/time formatting uses local date fields and locale format order',()=>{
 const qt=createQt(),date=new Date(2024,10,23,17,45,36);
 expect(qt.formatTime(date,'HH:mm')).toBe('17:45');
 expect(qt.formatTime(date,'h:mm AP')).toBe('5:45 PM');
 expect(qt.formatDateTime(date,"yyyy-MM-dd 'at' HH:mm")).toBe('2024-11-23 at 17:45');
 expect(qt.locale('en_US').measurementSystem).toBe(1);
 expect(qt.locale('zh_TW').measurementSystem).toBe(0);
 expect(qt.locale('en_US').dateFormat(1).indexOf('M')).toBeLessThan(qt.locale('en_US').dateFormat(1).indexOf('d'));
});

test('createObject does not make the owning binding depend on new child state',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
 await host.start();await host.call('loadDocument',{url:'data:text/x-qml,factory-tracking',contentType:'text/x-qml',source:`import QtQuick
Item {id:root
 property var child:factory.createObject(root)
 property Component factory:Component {Item {property int counter:0;property int derived:counter+1;Component.onCompleted:globalThis.created=(globalThis.created||0)+1}}
 Component.onCompleted:{globalThis.root=root;globalThis.first=child;}
}`});await host.call('whenLoaded');
 expect(await host.call('evaluate','globalThis.created')).toBe(1);
 await host.call('evaluate','first.counter=9');await Bun.sleep(20);
 expect(await host.call('evaluate','[root.child===first,root.child.derived,globalThis.created]')).toEqual([true,10,1]);
 }finally{host.close();}
},20000);
