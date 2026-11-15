import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBrowser} from '../lib/headless-shell.js';

test('retiring a focused QML editor returns keys to its live scope without stealing another editor',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'qml-focus-retire-'));
 const path=join(dir,'main.qml');
 await Bun.write(path,`import QtQuick
Rectangle { width:400; height:300
 FocusScope { id: scope; anchors.fill:parent; focus:true
  property int moves:0
  property int presses:0
  PointHandler { onActiveChanged: if(active) scope.presses++ }
  Keys.onPressed: event => { if(event.key===Qt.Key_Down){moves++;event.accepted=true} }
  TextInput { id: editor; width:100;height:30;focus:true;text:"name" }
  TextInput { id: other; y:50;width:100;height:30;text:"other" }
  Loader { id: loader; y:100;sourceComponent: Component { TextInput {width:100;height:30;text:"loaded"} } }
  Component.onCompleted: {globalThis.fixture={scope:scope,editor:editor,other:other,loader:loader}}
 }
}`);
 const browser=await createBrowser({spareRenderer:false});const c=browser.context;
 const wait=async expr=>{for(let i=0;i<80;i++){if(await c.evaluate(expr))return;await Bun.sleep(20)}throw Error('focus did not settle: '+expr)};
 try{
  await c.navigate(Bun.pathToFileURL(path).href);
  await c.evaluate('fixture.editor.forceActiveFocus();fixture.editor.visible=false');
  await wait('fixture.scope.activeFocus && document.activeElement.tagName!=="BODY"');
  await c.press('ArrowDown');expect(await c.evaluate('fixture.scope.moves')).toBe(1);
  await c.evaluate('fixture.loader.item.forceActiveFocus();fixture.loader.active=false');
  await wait('fixture.scope.activeFocus && document.activeElement.tagName!=="BODY"');
  await c.press('ArrowDown');expect(await c.evaluate('fixture.scope.moves')).toBe(2);
  await c.evaluate('fixture.editor.visible=true;fixture.editor.forceActiveFocus();fixture.editor.visible=false;fixture.other.forceActiveFocus()');
  await wait('fixture.other.activeFocus');await Bun.sleep(40);
  expect(await c.evaluate('fixture.other.activeFocus')).toBe(true);
  await c.evaluate('__qmlRuntime.element(fixture.other).addEventListener("mousedown",e=>e.stopPropagation())');
  await c.click(20,60);
  expect(await c.evaluate('fixture.scope.presses')).toBe(1);
  expect(await c.evaluate('fixture.other.activeFocus')).toBe(true);
 }finally{await browser.close();rmSync(dir,{recursive:true,force:true})}
},30000);
