import {expect,test} from 'bun:test';
import CanvasKitInit from '../usr/lib/canvaskit/canvaskit.js';
import {makeRasterSurface} from '../lib/renderer/raster-surface.js';
import {webGLWorkerAssets} from '../lib/renderer/webgl/worker-assets.js';
import {createWorkerGL,setWebGLWorkerAssets,glSubmission,waitForGLWrites} from '../lib/renderer/webgl/worker-context.js';

test('WebGL worker preserves readback, handle identity and the newest canvas bitmap',async()=>{
  const {source,wasm}=await webGLWorkerAssets();
  const kit=await CanvasKitInit({wasmBinary:wasm});
  setWebGLWorkerAssets(()=>({source,wasm:wasm.slice()}));
  const raster=makeRasterSurface(kit,2,2),document={},node={ownerDocument:document};
  const state={width:2,height:2,surface:raster,raster,node:new WeakRef(node)};
  let context, asyncFrame;
  function pixel(){
    return [...raster.getCanvas().readPixels(0,0,{width:1,height:1,colorType:kit.ColorType.RGBA_8888,
      alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB})];
  }
  try{
    const sourceImage={width:1,height:1,image:{readPixels:()=>Uint8Array.of(12,34,56,255)}};
    const allowed={},tainted={};
    const resolveImage=element=>element===allowed?sourceImage:element===tainted?{...sourceImage,originClean:false}:null;
    context=createWorkerGL(kit,state,(_state,presented)=>{asyncFrame=presented;},{canvas:node,depth:false,resolveImage},true);
    expect(context.asyncPresentation).toBe(true);
    const gl=context.proxy,framebuffer=gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
    expect(gl.getParameter(gl.FRAMEBUFFER_BINDING)).toBe(framebuffer);
    const texture=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS,3);
    const upload=source=>gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
    expect(()=>upload(tainted)).toThrow('Cross-origin texture');
    upload(allowed);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    const texel=new Uint8Array(4);
    gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,texel);
    expect([...texel]).toEqual([12,34,56,255]);
    expect(gl.getError()).toBe(gl.NO_ERROR);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    const before=glSubmission();
    gl.clearColor(1,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
    const red=waitForGLWrites(document,before);
    expect(red).toBeInstanceOf(Promise);
    await red;
    expect(asyncFrame).toBe(true);
    expect(pixel()).toEqual([255,0,0,255]);
    const blueStart=glSubmission();
    gl.clearColor(0,0,1,1);gl.clear(gl.COLOR_BUFFER_BIT);
    // Submit a bitmap, then supersede it before handling its asynchronous reply.
    await Promise.resolve();
    gl.clearColor(0,1,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
    gl.finish();
    expect(asyncFrame).toBeUndefined();
    expect(pixel()).toEqual([0,255,0,255]);
    await Bun.sleep(20);
    expect(pixel()).toEqual([0,255,0,255]);
    expect(waitForGLWrites(document,blueStart)).toBeUndefined();
    const dest=new Uint8Array(8).fill(123);
    Object.defineProperty(dest,'constructor',{get(){throw Error('page constructor');}});
    gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,dest,4);
    expect([...dest]).toEqual([123,123,123,123,0,255,0,255]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const release=waitForGLWrites(document,blueStart);
    context.dispose();
    await release;
    expect(gl.isContextLost()).toBe(true);
  }finally{
    context?.dispose();
    setWebGLWorkerAssets(null);
    raster.dispose();
  }
},20000);
