import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
const url=new URL('./qml-shader/main.qml',import.meta.url).href;
const errors=[];
const r=await createPageRenderer({reportError:e=>errors.push(String(e)),fetchResource:async url=>({ok:true,status:200,url,body:await Bun.file(new URL(url)).bytes()})});
r.resize(640,420,1);r.setScripting('host');
try{
 await r.loadDocument({url,contentType:'text/x-qml',source:await Bun.file(new URL(url)).text()});await r.whenLoaded();
 await Bun.sleep(100);
 process.stdout.write(String(await r.evaluate('JSON.stringify({status:testShader.status,log:testShader.log,canvases:document.querySelectorAll("canvas").length})'))+'\n'+JSON.stringify(errors)+'\n');
 const pixel=()=>r.evaluate('Array.from(document.querySelector("canvas").getContext("2d").getImageData(300,160,1,1).data)');
 assert.deepEqual(await pixel(),[128,128,51,255]);
 await r.evaluate('testShader.phase=0.9');await Bun.sleep(100);
 assert.deepEqual(await pixel(),[128,128,230,255]);
 assert.deepEqual(errors,[]);
 console.log('shader reactive pixels OK');
}finally{r.dispose();}
