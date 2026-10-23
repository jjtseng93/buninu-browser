import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createBrowser } from '../lib/headless-shell.js';
import { loadGraphics } from '../lib/renderer/page-renderer.js';

test('ShaderEffectSource freezes, updates, hides sources and releases Loader references', async () => {
  const dir = mkdtempSync('/tmp/qml-textures-');
  const browser = await createBrowser({ spareRenderer: false });
  const { CanvasKit: kit } = await loadGraphics();
  async function pixel(x,y) {
    const image=kit.MakeImageFromEncoded(Buffer.from(await browser.context.screenshot({format:'png'}),'base64'));
    try { return [...image.readPixels(x,y,{width:1,height:1,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB})]; }
    finally { image.delete(); }
  }
  const run = code => browser.context.evaluate(code);
  async function until(fn) { for(let i=0;i<50;i++){if(await fn())return;await Bun.sleep(20);}throw Error(await run('document.body.innerText+JSON.stringify(errors)')); }
  try {
    await Bun.write(dir+'/main.qml', `import QtQuick
Rectangle {width:240;height:160;color:"white"
 property int frames:0
 Rectangle {id:source;width:60;height:40;color:"red"}
 Loader {id:layer;x:80;width:60;height:40;active:true
  sourceComponent:ShaderEffectSource {sourceItem:source;hideSource:true;live:false;onScheduledUpdateCompleted:frames+=1}}
 Loader {id:mirror;x:160;width:60;height:40;active:false;sourceComponent:ShaderEffectSource {sourceItem:source;hideSource:true;live:false}}
 Text {id:status;y:120;text:frames+":"+layer.active}
 Button {id:toggle;x:210;y:80;text:"hide";onClicked:layer.item.hideSource=!layer.item.hideSource}
 Button {id:blue;y:80;text:"blue";onClicked:source.color=source.color==="blue"?"red":"blue"}
 Button {id:update;x:70;y:80;text:"update";onClicked:layer.item.scheduleUpdate()}
 Button {id:live;x:140;y:80;text:"live";onClicked:layer.item.live=true}
 Button {id:mirrorOn;y:140;text:"mirror";onClicked:mirror.active=true}
 Button {id:clear;x:70;y:140;text:"clear";onClicked:mirror.item.sourceItem=null}
 Button {id:release;x:140;y:120;text:"release";onClicked:layer.active=false}
}`);
    await browser.context.addInitScript('globalThis.errors=[];addEventListener("error",e=>errors.push(String(e.error?.stack||e.message)))');
    await browser.context.navigate(Bun.pathToFileURL(dir+'/main.qml').href);
    await until(async()=> (await run('document.getElementById("status")?.textContent'))?.startsWith('1:'));
    expect(await pixel(5,5)).toEqual([255,255,255,255]);
    expect(await pixel(85,5)).toEqual([255,0,0,255]);
    await run('document.getElementById("toggle").click()');await Bun.sleep(30);
    expect(await pixel(5,5)).toEqual([255,0,0,255]);
    await run('document.getElementById("toggle").click()');await Bun.sleep(30);
    expect(await pixel(5,5)).toEqual([255,255,255,255]);
    await run('document.getElementById("blue").click()');await Bun.sleep(50);
    expect(await pixel(85,5)).toEqual([255,0,0,255]);
    await run('document.getElementById("update").click()');
    await until(async()=> (await run('document.getElementById("status").textContent')).startsWith('2:'));
    expect(await pixel(85,5)).toEqual([0,0,255,255]);
    await run('document.getElementById("live").click()');
    await until(async()=> (await run('document.getElementById("status").textContent')).startsWith('3:'));
    await run('document.getElementById("blue").click()');
    await until(async()=> (await run('document.getElementById("status").textContent')).startsWith('4:'));
    expect(await pixel(85,5)).toEqual([255,0,0,255]);
    await Bun.sleep(120);
    expect(await run('document.getElementById("status").textContent')).toBe('4:true');
    await run('document.getElementById("mirrorOn").click()');
    await until(async()=> (await pixel(165,5))[1]===0);
    await run('document.getElementById("release").click()');await Bun.sleep(30);
    expect(await pixel(5,5)).toEqual([255,255,255,255]);
    expect(await pixel(165,5)).toEqual([255,0,0,255]);
    await run('document.getElementById("clear").click()');await Bun.sleep(30);
    expect(await pixel(165,5)).toEqual([255,255,255,255]);
    expect(await pixel(5,5)).toEqual([255,0,0,255]);
    expect(await pixel(85,5)).toEqual([255,255,255,255]);
    expect(await run('errors')).toEqual([]);
  } finally { browser.close();rmSync(dir,{recursive:true,force:true}); }
},30000);
