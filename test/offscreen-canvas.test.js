import {expect,test} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

test('offscreen drawing copies pixels to a DOM canvas and preserves context identity across resize',async()=>{
  const host=new RendererHost({timeout:20000});
  try {
    await host.start();
    await host.call('loadDocument',{url:'https://canvas.test/',contentType:'text/html',status:200,source:'<canvas></canvas>'});
    await host.call('whenLoaded');
    expect(await host.call('evaluate',`(() => {
      const canvas=new OffscreenCanvas(4,3),ctx=canvas.getContext('2d');
      ctx.fillStyle='red'; ctx.fillRect(0,0,4,3);
      const dest=document.querySelector('canvas').getContext('2d');
      dest.drawImage(canvas,0,0);
      const bitmap=canvas.transferToImageBitmap();
      const cleared=ctx.getImageData(0,0,1,1).data[3];
      ctx.drawImage(bitmap,0,0);
      const transferred=ctx.getImageData(3,2,1,1).data[0];
      bitmap.close();
      canvas.width=2;
      return [cleared,transferred,canvas.width,canvas.height,ctx.canvas===canvas,ctx instanceof OffscreenCanvasRenderingContext2D,
        canvas.getContext('2d')===ctx,...dest.getImageData(3,2,1,1).data,...ctx.getImageData(0,0,1,1).data];
    })()`)).toEqual([0,255,2,3,true,true,true,255,0,0,255,0,0,0,0]);
  } finally {await host.close();}
});

test('transferred placeholder presents offscreen pixels and enforces exclusive ownership',async()=>{
  const host=new RendererHost({timeout:20000});
  try {
    await host.start();
    await host.call('loadDocument',{url:'https://canvas.test/',contentType:'text/html',status:200,source:'<canvas width="3" height="2"></canvas>'});
    await host.call('whenLoaded');
    expect(await host.call('evaluate',`(() => {
      const el=document.querySelector('canvas'), off=el.transferControlToOffscreen(), ctx=off.getContext('2d');
      ctx.fillStyle='blue'; ctx.fillRect(0,0,3,2);
      const target=document.createElement('canvas'), dest=target.getContext('2d');
      dest.drawImage(el,0,0);
      const error=fn=>{try{fn();return null}catch(e){return e.name}};
      off.width=5;
      return [ctx.canvas===off,...dest.getImageData(1,1,1,1).data,el.width,off.height,
        error(()=>el.getContext('2d')),error(()=>el.transferControlToOffscreen()),error(()=>el.width=4),
        error(()=>target.transferControlToOffscreen())];
    })()`)).toEqual([true,0,0,255,255,5,2,...Array(4).fill('InvalidStateError')]);
  } finally {await host.close();}
});

test('dedicated worker draws and reads offscreen pixels',async()=>{
  const host=new RendererHost({timeout:20000});
  try {
    await host.start();
    await host.call('loadDocument',{url:'https://canvas.test/',contentType:'text/html',status:200,source:'<body></body>'});
    await host.call('whenLoaded');
    await host.call('evaluate',`(() => {
      const source="const c=new OffscreenCanvas(2,2),x=c.getContext('2d');x.fillStyle='lime';x.fillRect(0,0,2,2);postMessage([...x.getImageData(1,1,1,1).data])";
      const worker=new Worker(URL.createObjectURL(new Blob([source],{type:'text/javascript'})));
      worker.onmessage=e=>{window.workerPixels=e.data;worker.terminate()};
      worker.onerror=e=>window.workerPixels=e.message;
    })()`);
    let pixels;
    for(let i=0;i<60&&!pixels;i++){
      pixels=await host.call('evaluate','window.workerPixels || null');
      if(!pixels)await Bun.sleep(10);
    }
    expect(pixels).toEqual([0,255,0,255]);
  } finally {await host.close();}
});

test('convertToBlob returns a decodable PNG snapshot',async()=>{
  const host=new RendererHost({timeout:20000});
  try {
    await host.start();
    await host.call('loadDocument',{url:'https://canvas.test/',contentType:'text/html',status:200,source:'<body></body>'});
    await host.call('whenLoaded');
    await host.call('evaluate',`void (async()=>{
      const canvas=new OffscreenCanvas(3,2), x=canvas.getContext('2d');
      x.fillStyle='blue';x.fillRect(0,0,3,2);
      const blob=await canvas.convertToBlob(),bitmap=await createImageBitmap(blob);
      x.clearRect(0,0,3,2);x.drawImage(bitmap,0,0);bitmap.close();
      window.pngResult=[blob.type,...x.getImageData(2,1,1,1).data];
    })().catch(e=>window.pngResult=String(e))`);
    let result;
    for(let i=0;i<60&&!result;i++){
      result=await host.call('evaluate','window.pngResult || null');
      if(!result)await Bun.sleep(10);
    }
    expect(result).toEqual(['image/png',0,0,255,255]);
  } finally {await host.close();}
});
