import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {createBrowser} from '../lib/headless-shell.js';
import {loadGraphics} from '../lib/renderer/page-renderer.js';

test('QML input selection paints full and partial ranges without changing input geometry',async()=>{
 const dir=mkdtempSync('/tmp/qml-selection-');let browser;
 try{
  await Bun.write(dir+'/main.qml',`import QtQuick
Rectangle {width:360;height:160;color:"white"
 TextInput {id:field;x:10;y:10;width:300;height:30;text:"abcdefghij";font.pixelSize:20;color:"black";selectionColor:"#00aaff";selectedTextColor:"white"}
 Button {id:all;y:70;onClicked:{field.forceActiveFocus();field.selectAll()}}
 Button {id:part;x:90;y:70;onClicked:{field.forceActiveFocus();field.select(2,5)}}
 Button {id:none;x:180;y:70;onClicked:{field.forceActiveFocus();field.deselect()}}
}`);
  browser=await createBrowser({spareRenderer:false});await browser.context.resize(360,160);await browser.context.navigate(Bun.pathToFileURL(dir+'/main.qml').href);
  const run=s=>browser.context.evaluate(s),click=async id=>{await run(`document.getElementById('${id}').click()`);await run('0');};
  const bounds=()=>run('document.getElementById("field").getBoundingClientRect().toJSON()');
  const original=await bounds();
  const {CanvasKit:kit}=await loadGraphics();
  async function blue(){const png=Buffer.from(await browser.context.screenshot({format:'png'}),'base64'),im=kit.MakeImageFromEncoded(png);try{const data=im.readPixels(0,0,{width:360,height:160,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB});let n=0;for(let i=0;i<data.length;i+=4)if(data[i]===0&&data[i+1]===170&&data[i+2]===255)n++;return n;}finally{im.delete();}}
  await click('all');const full=await blue();expect(full).toBeGreaterThan(300);expect(await bounds()).toEqual(original);
  expect(await run('({start:document.getElementById("field").selectionStart,end:document.getElementById("field").selectionEnd})')).toEqual({start:0,end:10});
  await click('part');const partial=await blue();expect(partial).toBeGreaterThan(50);expect(partial).toBeLessThan(full);expect(await bounds()).toEqual(original);
  await click('none');expect(await blue()).toBe(0);
  await browser.context.click(original.x+1,original.y+12);
  expect(await run('document.getElementById("field").selectionStart')).toBe(0);
  await browser.context.type('X');expect(await run('document.getElementById("field").value')).toBe('Xabcdefghij');
  await click('all');await browser.context.press('Backspace',{code:'Backspace'});expect(await run('document.getElementById("field").value')).toBe('');expect(await blue()).toBe(0);
 }finally{browser?.close();rmSync(dir,{recursive:true,force:true});}
},30000);

test('QML input arrows collapse and extend selection, and the caret paints and blinks',async()=>{
 const dir=mkdtempSync('/tmp/qml-caret-');let browser;
 try{
  await Bun.write(dir+'/main.qml',`import QtQuick
Rectangle {width:360;height:100;color:"white"
 TextInput {id:field;x:10;y:10;width:300;height:30;text:"abc😀xyz";font.pixelSize:20;color:"black"}
 Button {id:all;y:60;onClicked:{field.forceActiveFocus();field.selectAll()}}
}`);
  browser=await createBrowser({spareRenderer:false});await browser.context.resize(360,100);await browser.context.navigate(Bun.pathToFileURL(dir+'/main.qml').href);
  const run=s=>browser.context.evaluate(s),state=()=>run(`(()=>{const e=document.getElementById('field');return [e.selectionStart,e.selectionEnd]})()`);
  const key=async(k,modifiers=0)=>{await browser.context.press(k,{code:k,modifiers});await run('0');};
  await run(`document.getElementById('all').click()`);await run('0');
  await key('ArrowRight');expect(await state()).toEqual([8,8]);
  await key('ArrowLeft');expect(await state()).toEqual([7,7]);
  await key('ArrowLeft',8);expect(await state()).toEqual([6,7]);
  await key('ArrowLeft',8);expect(await state()).toEqual([5,7]);
  await key('ArrowLeft',8);expect(await state()).toEqual([3,7]);
  await key('ArrowRight');expect(await state()).toEqual([7,7]);
  await key('a',2);await key('ArrowLeft');expect(await state()).toEqual([0,0]);
  const on=await browser.context.screenshot({format:'png'});
  // Capture work can span a blink phase on a loaded machine. Observe several
  // frames rather than assuming two wall-clock samples land in opposite phases.
  let changed=false;
  for(let i=0;i<20;i++){
   await Bun.sleep(125);
   if(await browser.context.screenshot({format:'png'})!==on){changed=true;break;}
  }
  expect(changed).toBe(true);
  await run(`document.getElementById('field').blur()`);await run('0');
  const blurred=await browser.context.screenshot({format:'png'});await Bun.sleep(550);
  expect(await browser.context.screenshot({format:'png'})).toBe(blurred);

 }finally{browser?.close();rmSync(dir,{recursive:true,force:true});}
},30000);
