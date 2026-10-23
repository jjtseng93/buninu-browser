import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { createBrowser } from '../lib/headless-shell.js';
import { loadGraphics } from '../lib/renderer/page-renderer.js';
import { fleaSandbox } from './helpers/flea-sandbox.js';
const flea=process.env.BUNINU_FLEA_ROOT, omarchy=process.env.BUNINU_OMARCHY_ROOT;
for(const kind of ['swap','clip']) test.skipIf(!flea||!omarchy)('unchanged Flea '+kind+' paints actual texture pixels',async()=>{
  const sandbox=fleaSandbox(flea,omarchy);
  let browser;
  try {
    const content=kind==='swap'?`
 property bool complete:true
 Flea.PreviewSwap {id:swap;x:20;y:20;width:180;height:100;ready:complete;folderHold:true
  Rectangle {id:source;anchors.fill:parent;color:"red"}}
 Button {id:move;y:150;text:"Move";onClicked:{complete=false;swap.hold(function(){source.color="blue";swap.start(false)},1)}}
 Button {id:finish;x:100;y:150;text:"Finish";onClicked:{swap.folderHold=false;complete=true}}
 Text {id:status;y:200;text:JSON.stringify(swap.describe())}
`:`
 Rectangle {id:source;x:20;y:20;width:100;height:60;color:"red"}
 Flea.HtmlClip {id:clip;x:150;y:20;width:100;height:60;radius:20;target:source}
 Button {id:blue;y:150;text:"Blue";onClicked:source.color="blue"}
`;
    const file=join(sandbox.dir,'main.qml');
    await Bun.write(file,`import QtQuick\nimport ${JSON.stringify(join(sandbox.flea,'ui'))} as Flea\nRectangle {width:400;height:240;color:"white"\n${content}\n}`);
    browser=await createBrowser({spareRenderer:false,rendererTimeout:15000});
    await browser.context.resize(400,240);
    await browser.context.addInitScript('globalThis.errors=[];addEventListener("error",e=>errors.push(String(e.error?.stack||e.message)))');
    await browser.context.navigate(Bun.pathToFileURL(file).href);
    const run=code=>browser.context.evaluate(code);
    async function until(fn){for(let i=0;i<70;i++){if(await fn())return;await Bun.sleep(20);}throw Error(await run('document.body.innerText+JSON.stringify(errors)'));}
    const {CanvasKit:kit}=await loadGraphics();
    async function capture(){return Buffer.from(await browser.context.screenshot({format:'png'}),'base64');}
    function pixel(bytes,x,y){const image=kit.MakeImageFromEncoded(bytes);try{return [...image.readPixels(x,y,{width:1,height:1,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB})];}finally{image.delete();}}
    if(kind==='swap'){
      await until(async()=>await run('!!document.getElementById("move")'));
      expect(pixel(await capture(),30,30)).toEqual([255,0,0,255]);
      await run('document.getElementById("move").click()');
      await until(async()=>await run('JSON.parse(document.getElementById("status").textContent).holding'));
      const held=await capture();await Bun.write('/tmp/flea-preview-held.png',held);
      expect(pixel(held,30,30)).toEqual([255,0,0,255]);
      expect(await run('document.getElementById("source").style.backgroundColor')).toBe('blue');
      await run('document.getElementById("finish").click()');
      await until(async()=>!(await run('JSON.parse(document.getElementById("status").textContent).holding')));
      const done=await capture();await Bun.write('/tmp/flea-preview-released.png',done);
      expect(pixel(done,30,30)).toEqual([0,0,255,255]);
      expect(await run('JSON.parse(document.getElementById("status").textContent).last.end')).toBe('landed');
    }else{
      await until(async()=>pixel(await capture(),200,50)[0]===255&&pixel(await capture(),200,50)[1]===0);
      const rounded=await capture();await Bun.write('/tmp/flea-preview-rounded.png',rounded);
      expect(pixel(rounded,25,25)).toEqual([255,255,255,255]);
      expect(pixel(rounded,151,21)).toEqual([255,255,255,255]);
      expect(pixel(rounded,200,50)).toEqual([255,0,0,255]);
      await run('document.getElementById("blue").click()');
      await until(async()=>pixel(await capture(),200,50)[0]===0);
      expect(pixel(await capture(),200,50)).toEqual([0,0,255,255]);
    }
    expect(await run('errors')).toEqual([]);
  }finally{browser?.close();sandbox.close();}
},30000);
