// Completed-frame timing, not merely asynchronous GPU command submission.
// bun test/manual-webgl-benchmark.js buninu|chromium /path/to/3D素材 [/tmp/output]
// Select a software Vulkan ICD externally for the Chromium CPU comparison.
import{launch}from'../tools/browser-lab.js';
import{resolve,join}from'node:path';
const engine=process.argv[2]??'buninu',assets=process.argv[3];
if(!assets)throw Error('Pass a directory containing floor.jpg and wall.jpg');
const out=resolve(process.argv[4]??'/tmp/threejs-benchmark-'+engine);
const b=await launch(engine,out,engine==='chromium'?['--use-gl=angle','--use-angle=vulkan','--disable-gpu-sandbox','--ignore-gpu-blocklist']:[]);
try{
 const c=b.cdp;await c.send('Page.navigate',{url:'https://drjohnjstest.blogspot.com/2023/11/3dsbsthreejsdemo.html'});
 for(let i=0;i<300;i++){if(await c.evaluate('typeof te!=="undefined"&&!!te.openo'))break;await Bun.sleep(100);}
 const images=await Promise.all(['floor.jpg','wall.jpg'].map(async name=>'data:image/jpeg;base64,'+(await Bun.file(join(assets,name)).bytes()).toBase64()));
 await c.evaluate(`te.selectbg(${JSON.stringify(images[0])},${JSON.stringify(images[1])}).then(()=>true)`,180000);
 for(let i=0;i<100;i++){if(await c.evaluate('te.floor.material.map.image.complete&&te.wallr.material.map.image.complete'))break;await Bun.sleep(50);}
 const result=await c.evaluate(`(()=>{
  const contexts=[te.renderer.getContext(),te.renderer2.getContext()],pixel=new Uint8Array(4);
  const fence=()=>{for(const gl of contexts){gl.finish();if(gl.readPixels)gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);}};
  let start=performance.now();te.add('man');te.rd();fence();const preparationMs=performance.now()-start,frames=[];
  for(let i=0;i<30;i++){start=performance.now();te.obj[0].position.x=6.1*i;te.rd();fence();frames.push(performance.now()-start);}
  return {preparationMs,frames,canvas:[te.cv.width,te.cv.height],errors:contexts.map(g=>g.getError())};
 })()`,300000);
 const sorted=result.frames.slice(3).sort((a,b)=>a-b),median=sorted[Math.floor(sorted.length/2)],p95=sorted[Math.floor(sorted.length*.95)];
 const report={engine,...result,medianMs:median,medianFps:1000/median,p95Ms:p95,p95Fps:1000/p95};
 await Bun.write(join(out,'timing.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 await c.evaluate('te.cv.scrollIntoView()');const shot=await c.send('Page.captureScreenshot',{format:'png'},180000);await Bun.write(join(out,'scene.png'),Buffer.from(shot.data,'base64'));
}finally{await b.stop();}
