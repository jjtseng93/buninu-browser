import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
const texture=process.argv[2]==='texture';
const grab=process.argv[2]==='grab'||texture;
const url=new URL(texture?'./qml-shader/texture-grab.qml':grab?'./qml-shader/grab.qml':'./qml-shader/main.qml',import.meta.url).href;
const errors=[];
const r=await createPageRenderer({reportError:e=>errors.push(String(e.stack||e)),fetchResource:async url=>({ok:true,status:200,url,body:url.startsWith('data:')?Buffer.from(url.slice(url.indexOf(',')+1),'base64'):await Bun.file(new URL(url)).bytes()})});
r.resize(640,420,1);r.setScripting('host');
try{
 await r.loadDocument({url,contentType:'text/x-qml',source:await Bun.file(new URL(url)).text()});await r.whenLoaded();
 await Bun.sleep(100);
 if(!grab){
 const pixel=()=>r.evaluate('Array.from(document.querySelector("canvas").getContext("2d").getImageData(300,160,1,1).data)');
 assert.deepEqual(await pixel(),[128,128,51,255]);
 await r.evaluate('testShader.phase=0.9');await Bun.sleep(100);
 assert.deepEqual(await pixel(),[128,128,230,255]);
 }else{
 for(let i=0;i<100;i++){if(await r.evaluate('!!globalThis.grabPixels'))break;await Bun.sleep(10);}
 assert.deepEqual(await r.evaluate('globalThis.grabPixels'),texture?[0,255,0,255]:[255,0,0,255]);
 assert.equal(await r.evaluate('globalThis.unloaded'),true);
 }
 assert.deepEqual(errors,[]);
 console.log('shader reactive pixels OK');
}finally{r.dispose();}
