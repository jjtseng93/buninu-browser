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
