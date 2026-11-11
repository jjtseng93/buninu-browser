import {test,expect} from 'bun:test';
import {createBrowser} from '../lib/headless-shell.js';
import {loadGraphics} from '../lib/renderer/page-renderer.js';
import {animatedGif} from './fixtures/animated-gif.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const gif='data:image/gif;base64,'+animatedGif().toString('base64');
async function pixel(browser,x=5,y=5){
 const k=(await loadGraphics()).CanvasKit;
 const im=k.MakeImageFromEncoded(Buffer.from(await browser.context.screenshot({format:'png'}),'base64'));
 try{return Array.from(im.readPixels(x,y,{width:1,height:1,colorType:k.ColorType.RGBA_8888,
  alphaType:k.AlphaType.Unpremul,colorSpace:k.ColorSpace.SRGB}));}finally{im.delete()}
}
async function changes(browser,x,y){
 const colors=new Set();
 for(let i=0;i<32&&!(colors.has('[255,0,0,255]')&&colors.has('[0,255,0,255]'));i++){colors.add(JSON.stringify(await pixel(browser,x,y)));await Bun.sleep(60)}
 expect(colors.has('[255,0,0,255]')).toBe(true);
 expect(colors.has('[0,255,0,255]')).toBe(true);
}
test('HTML img and CSS backgrounds animate through screenshot painting; src removal and navigation recover',async()=>{
 const b=await createBrowser({spareRenderer:false});
 try{
  await b.context.navigate('data:text/html,'+encodeURIComponent(`<style>body{margin:0}img{width:20px;height:20px}#bg{width:20px;height:20px;background:url("${gif}")}</style><img id="im" src="${gif}"><div id="bg"></div>`));
  await changes(b,5,5);await changes(b,5,30);
  await b.context.evaluate('im.removeAttribute("src");bg.style.backgroundImage="none"');
  await b.context.navigate('data:text/html,<style>body{margin:0;background:blue}</style>');
  expect(await pixel(b)).toEqual([0,0,255,255]);
  await Bun.sleep(350);expect(await pixel(b)).toEqual([0,0,255,255]);
 }finally{await b.close()}
},20000);
test('QML AnimatedImage plays, pauses and restarts with frame metadata',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'qml-gif-'));const file=join(dir,'main.qml');
 await Bun.write(file,`import QtQuick
import Quickshell
FloatingWindow { width: 100; height: 100
 AnimatedImage { id: animation; width: 40; height: 40; source: "${gif}"
 Component.onCompleted: globalThis.animation = animation }
 Image { x: 50; width: 40; height: 40; source: "${gif}" }
}`);
 const b=await createBrowser({spareRenderer:false});
 try{
  await b.context.navigate(Bun.pathToFileURL(file).href);
  await changes(b,5,5);
  expect(await b.context.evaluate('animation.frameCount')).toBe(2);
  expect(await pixel(b,55,5)).toEqual([255,0,0,255]);
  await b.context.evaluate('animation.paused=true');
  const before=await pixel(b);await Bun.sleep(400);expect(await pixel(b)).toEqual(before);
  await b.context.evaluate('animation.paused=false');await changes(b,5,5);
  await b.context.evaluate('animation.playing=false');await Bun.sleep(50);
  const stopped=await pixel(b);await Bun.sleep(400);expect(await pixel(b)).toEqual(stopped);
  await b.context.evaluate('animation.playing=true');await changes(b,5,5);
 }finally{await b.close();await rm(dir,{recursive:true,force:true})}
},20000);
test('live rendering advances without screenshot polling and releases GIF decoders and frames',async()=>{
 const child=Bun.spawn([process.execPath,Bun.fileURLToPath(new URL('./fixtures/animated-image-lifetime.js',import.meta.url))],{stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect({code,err}).toEqual({code:0,err:''});expect(out).toContain('animated image lifetime passed');
},20000);
