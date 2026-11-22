import {expect,test} from 'bun:test';
import {makeRasterSurface,copyRasterSurfacePixels} from '../lib/renderer/raster-surface.js';

test('owned raster pixels follow WASM memory growth, crop stride and disposal',()=>{
 const wasm=new WebAssembly.Memory({initial:1,maximum:2});let deleted=0,freed=0;
 const kit={HEAPU8:new Uint8Array(wasm.buffer),ColorType:{RGBA_8888:1},AlphaType:{Premul:2},ColorSpace:{SRGB:3},TRANSPARENT:[0,0,0,0],
  Malloc(_type,length){return {byteOffset:16,length}},Free(){freed++},
  MakeRasterDirectSurface(info,memory,stride){
   expect(info).toEqual({width:4,height:3,colorType:1,alphaType:2,colorSpace:3});expect(stride).toBe(16);
   return {getCanvas:()=>({clear:()=>{}}),delete(){deleted++}};
  }};
 const surface=makeRasterSurface(kit,4,3);
 const original=kit.HEAPU8;
 for(let i=0;i<12;i++)kit.HEAPU8.set([i,33+i,99+i,255],16+i*4);
 const expected=kit.HEAPU8.slice(16,64);
 wasm.grow(1);kit.HEAPU8=new Uint8Array(wasm.buffer);
 expect(original.byteLength).toBe(0);
 const full=new Uint8Array(48);
 expect(copyRasterSurfacePixels(surface,full,{width:4,height:3})).toBe(true);expect(full).toEqual(expected);
 const cropped=new Uint8Array(32).fill(17);
 expect(copyRasterSurfacePixels(surface,cropped,{x:1,y:1,width:2,height:2,offset:4,stride:12})).toBe(true);
 expect(cropped.subarray(4,12)).toEqual(expected.subarray(20,28));expect(cropped.subarray(16,24)).toEqual(expected.subarray(36,44));
 expect([...cropped.subarray(12,16)]).toEqual([17,17,17,17]);
 // Refusal never partially changes the destination, even if the last pixel
 // is translucent. Premultiplied consumers can still copy those exact bytes.
 kit.HEAPU8[63]=128;full.fill(19);
 expect(copyRasterSurfacePixels(surface,full,{width:4,height:3})).toBe(false);expect(full.every(x=>x===19)).toBe(true);
 expect(copyRasterSurfacePixels(surface,full,{width:4,height:3,premultiplied:true})).toBe(true);expect(full[47]).toBe(128);
 for(const rect of [{x:-1,y:0,width:2,height:2},{x:3,y:0,width:2,height:1},{x:0,y:0,width:0,height:1},{x:.5,y:0,width:2,height:1},{width:4,height:3,stride:15},{width:4,height:3,offset:1}])
  expect(copyRasterSurfacePixels(surface,new Uint8Array(48),rect)).toBe(false);
 expect(copyRasterSurfacePixels({},full,{width:4,height:3})).toBe(false);
 expect(copyRasterSurfacePixels(surface,kit.HEAPU8.subarray(16,64),{width:4,height:3,premultiplied:true})).toBe(false);
 surface.dispose();surface.dispose();
 expect(deleted).toBe(1);expect(freed).toBe(1);expect(copyRasterSurfacePixels(surface,full,{width:4,height:3})).toBe(false);
});

test('opaque readback checks every alpha in a cropped row, including the tail', () => {
  const width = 16, height = 3;
  const pixels = new Uint8Array(width * height * 4);
  const kit = {
    HEAPU8: pixels, ColorType: {}, AlphaType: {}, ColorSpace: {},
    Malloc: () => ({byteOffset: 0}), Free() {},
    MakeRasterDirectSurface: () => ({getCanvas: () => ({clear() {}}), delete() {}}),
  };
  const surface = makeRasterSurface(kit, width, height);
  const area = {x: 2, y: 1, width: 11, height: 1};
  const start = (area.y * width + area.x) * 4;
  const result = new Uint8Array(area.width * 4);
  try {
    for (let i = 0; i < result.length; i++) pixels[start + i] = i % 4 === 3 ? 255 : i;
    expect(copyRasterSurfacePixels(surface, result, area)).toBe(true);
    expect(result).toEqual(pixels.slice(start, start + result.length));
    for (let i = start + 3; i < start + result.length; i += 4) {
      pixels[i] = 254;
      expect(copyRasterSurfacePixels(surface, result, area)).toBe(false);
      pixels[i] = 255;
    }
  } finally { surface.dispose(); }
});
