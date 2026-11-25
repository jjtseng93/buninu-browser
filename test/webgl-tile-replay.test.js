import {expect,test} from 'bun:test';
import {TileReplay} from '../lib/renderer/webgl/tile-replay.js';
import {fragmentWriter,writeFragment} from '../lib/renderer/webgl/color-buffer.js';

test('tile reuse checks the destination, ordered vertex values, uniforms and immutable sampler state',()=>{
  const cache=new TileReplay();
  const program={vertex:{},fragment:{uniforms:[{name:'u'}]},values:new Map([['u',1]])};
  const sampler={version:1,width:1,height:1};
  const mesh=new Float32Array([0,1,2,3,0,1,2,3]);
  const target=new Uint32Array(8);
  let draws=0;
  function paint(ids,active=sampler){
    const run=cache.begin(program,[active],[],mesh.slice(),1);
    const draw=()=>{draws++;target[1]++;target[5]++;};
    if(run)run(0,[{ids}],[1,0,2,2],target,4,draw);
    else draw();
  }
  const reset=()=>target.fill(0);
  paint([0,1,2]);reset();paint([0,1,2]);reset();
  target[3]=9; // outside the tile
  paint([4,5,6]);
  expect(draws).toBe(2);
  expect([...target]).toEqual([0,1,0,9,0,1,0,0]);
  // The previous result itself is a different blend destination.
  paint([4,5,6]);expect(draws).toBe(3);expect(target[1]).toBe(2);
  reset();paint([6,5,4]);expect(draws).toBe(4);
  target.fill(0);mesh[6]=8;paint([6,5,4]);expect(draws).toBe(5);
  target.fill(0);program.values.set('u',2);paint([6,5,4]);expect(draws).toBe(6);
  reset();paint([6,5,4]);reset();paint([6,5,4]);expect(draws).toBe(7);
  reset();paint([6,5,4],{...sampler,version:2});expect(draws).toBe(8);
  expect(cache.begin(program,[{...sampler,topDown:true}],[],mesh,1)).toBeNull();
});

test('RGBA8 source-alpha fast path preserves the general blend equation',()=>{
  const blend={mask:[true,true,true,true],factors:[770,771,770,771],equations:[32774,32774],color:[0,0,0,0]};
  const src=new Float64Array(4),dst=new Uint8Array(4);
  const write=fragmentWriter(src,dst,blend,true);
  for(const alpha of [0,1,.5,1/255,128/255,-.25,2,NaN]){
    for(const red of [0,.25,1,2,Infinity,NaN]){
      src.set([red,.712,-.3,alpha]);dst.set([77,54,123,201]);
      const expected=dst.slice();
      writeFragment(src,0,expected,0,blend,true);write(0);
      expect(dst).toEqual(expected);
    }
  }
});
