import {expect, test} from 'bun:test';
import {videoLayerGeometry} from '../lib/renderer/video-mask.js';

test('video replay rejects nonfinite painter and final compositor coordinates', () => {
  const item = {rect:{x:12,y:14,width:640,height:360}};
  expect(videoLayerGeometry(item,{x:0,y:0},1.25)).toEqual({
    rect:{x:15,y:18,width:800,height:450},replayable:true,
  });
  for (const changed of [
    {...item,fixed:true}, {...item,rect:{...item.rect,width:0}},
    {...item,rect:{...item.rect,x:NaN}}, {...item,rect:{...item.rect,height:Infinity}},
    {...item,transform:{a:1,b:.1,c:0,d:1,e:0,f:0}},
    {...item,transform:{a:-1,b:0,c:0,d:1,e:0,f:0}},
    {...item,transform:{a:1e308,b:0,c:0,d:1,e:0,f:0}},
  ]) expect(videoLayerGeometry(changed,{x:0,y:0},1.25).replayable).toBe(false);
  expect(videoLayerGeometry(item,{x:0,y:0},1e308).replayable).toBe(false);
  // The painter's reordered expression remains finite here; the compositor's
  // actual subtraction overflows before its tiny scale can reduce the value.
  const overflow = videoLayerGeometry({rect:{x:0,y:0,width:1e308,height:1e308},
    transform:{a:1,b:0,c:0,d:1,e:-1e308,f:0}}, {x:1e308,y:0},1e-308);
  expect(overflow.rect.x).toBe(-Infinity);
  expect(overflow.replayable).toBe(false);
});

test('opaque shared video reuses black raster with compositor pixels and conservative fallbacks', async () => {
  const child = Bun.spawn([process.execPath,new URL('./fixtures/video-black-replay.js',import.meta.url).pathname],{
    stdout:'pipe',stderr:'pipe',
  });
  const [out,error,code] = await Promise.all([
    new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited,
  ]);
  expect({code,error}).toEqual({code:0,error:''});
  expect(out).toContain('video black replay integration passed');
},30_000);
