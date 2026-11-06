import {test,expect} from 'bun:test';
import {createBrowser} from '../lib/headless-shell.js';
import {loadGraphics} from '../lib/renderer/page-renderer.js';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const source='<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><defs><linearGradient id="g"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect width="40" height="20" fill="url(#g)"/></svg>';
test('SVG images share load/decode, CSS background, canvas and QML paths',async()=>{
 const server=Bun.serve({port:0,fetch(request){return new Response(source,{headers:{'content-type':'image/svg+xml'}});}});
 const url=`http://127.0.0.1:${server.port}/asset`,dir=mkdtempSync(join(tmpdir(),'svg-integration-'));
 const browser=await createBrowser({spareRenderer:false});
 const {CanvasKit:kit}=await loadGraphics();
 async function pixel(x,y){const image=kit.MakeImageFromEncoded(Buffer.from(await browser.context.screenshot({format:'png'}),'base64'));try{return Array.from(image.readPixels(x,y,{width:1,height:1,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB}));}finally{image.delete();}}
 async function until(code){const end=Date.now()+5000;while(Date.now()<end){if(await browser.context.evaluate(code))return;await Bun.sleep(30);}throw Error('SVG readiness timed out: '+code);}
 try{
  await browser.context.navigate('data:text/html,'+encodeURIComponent(`<style>body{margin:0}#bg{position:absolute;left:50px;top:0;width:40px;height:20px;background-image:url(${url})}canvas{position:absolute;left:100px;top:0}</style><img id="img" src="${url}"><div id="bg"></div><canvas id="cv" width="40" height="20"></canvas><script>window.ready=false;img.decode().then(()=>{cv.getContext('2d').drawImage(img,0,0);window.ready=true}).catch(e=>window.failure=String(e));</script>`));
  await until('window.ready');
  for(const x of [2,52,102])expect((await pixel(x,10))[0]).toBeGreaterThan(200);
  const svg=join(dir,'image.svg'),qml=join(dir,'main.qml');writeFileSync(svg,source);
  writeFileSync(qml,`import QtQuick\nRectangle {width:100;height:50;color:"white"\n Image {id:icon;width:80;height:40;source:"image.svg"}\n Text {id:status;y:40;text:String(icon.status)}\n}`);
  await browser.context.navigate(Bun.pathToFileURL(qml).href);
  await until('document.getElementById("status")?.textContent === "1"');
  expect((await pixel(4,10))[0]).toBeGreaterThan(200);
  expect((await pixel(74,10))[2]).toBeGreaterThan(200);
  const shape=join(dir,'shape.qml');
  writeFileSync(shape,`import QtQuick
import QtQuick.Shapes
Rectangle {width:100;height:50;color:"white"
 Shape {width:80;height:40
  ShapePath {strokeWidth:0;fillGradient:LinearGradient {x1:0;y1:0;x2:80;y2:0;GradientStop {position:0;color:"red"} GradientStop {position:1;color:"blue"}}
   PathSvg {path:"M0 0H80V40H0Z"}
  }
 }
}`);
  await browser.context.navigate(Bun.pathToFileURL(shape).href);
  expect((await pixel(4,10))[0]).toBeGreaterThan(200);
  expect((await pixel(74,10))[2]).toBeGreaterThan(200);
  expect(await browser.context.evaluate('document.querySelectorAll("[data-qml-gradient]").length')).toBe(0);

 }finally{await browser.close();server.stop(true);rmSync(dir,{recursive:true,force:true});}
},30000);
