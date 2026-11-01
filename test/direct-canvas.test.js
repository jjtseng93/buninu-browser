import {expect,test} from 'bun:test';
test('Land Canvas layers match Skia and safely return to full painting',async()=>{
 const p=Bun.spawn([process.execPath,new URL('./fixtures/direct-canvas.js',import.meta.url).pathname],{stdout:'pipe',stderr:'pipe'});
 const [exit,stderr]=await Promise.all([p.exited,new Response(p.stderr).text()]);
 expect({exit,stderr}).toEqual({exit:0,stderr:''});
},15000);

test('Land adapter preserves RGBA, premultiplied alpha, unaligned inputs and immutable output',async()=>{
 const {CanvasComposer}=await import('../lib/paint/direct-canvas.ts');
 const composer=new CanvasComposer();
 const source=Uint8Array.of(50,0,0,128,99,88,77,255,0,0,0,0);
 const storage=new Uint8Array(source.length+2).fill(9),unaligned=storage.subarray(1,-1);unaligned.set(source);
 try{
  const layer=pixels=>({pixels,width:3,height:1,x:0,y:0,drawWidth:3,drawHeight:1});
  const aligned=composer.compose(3,1,[10,20,30,255],[layer(source)]).slice();
  expect([...aligned]).toEqual([55,10,15,255,99,88,77,255,10,20,30,255]);
  expect([...composer.compose(3,1,[10,20,30,255],[layer(unaligned)])]).toEqual([...aligned]);
  expect([...source]).toEqual([50,0,0,128,99,88,77,255,0,0,0,0]);
  expect(storage[0]).toBe(9);expect(storage.at(-1)).toBe(9);
  const previous=composer.compose(3,1,[10,20,30,255],[layer(source)]);
  composer.compose(3,1,[255,0,0,255],[]);expect([...previous]).toEqual([...aligned]);
 }finally{composer.close();composer.close()}
});

test('the complete vendored Land renderer supports PNG and negotiated raw screenshots',async()=>{
 const {createRenderer}=await import('../vendor/land-renderer/renderer.ts');
 const surface={pixels:{bytes:Uint8Array.of(0,0,255,255,255,0,0,255),width:2,height:1,stride:8,format:0},scale:1,transform:0};
 const scene={width:2,height:1,fastPng:true,input:{x:0,y:0,pointer:false},wm:{renderSurfaces:()=>[surface],origin:()=>({x:0,y:0})}};
 let raw,closed=false;
 const renderer=await createRenderer(scene,{rawFrames:{write(bytes,width,height,format){raw={bytes:[...bytes],width,height,format};return 'raw-frame';},close(){closed=true;}}});
 try{
  const data=await renderer.screenshot({format:'png'});
  const {CanvasKit:kit}=await (await import('../lib/renderer/page-renderer.js')).loadGraphics();
  const image=kit.MakeImageFromEncoded(Buffer.from(data,'base64'));
  try{expect([...image.readPixels(0,0,{width:2,height:1,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB})]).toEqual([255,0,0,255,0,0,255,255]);}finally{image.delete()}
  expect(await renderer.screenshot({format:'rgba'})).toBe('raw-frame');
  expect(raw).toEqual({bytes:[255,0,0,255,0,0,255,255],width:2,height:1,format:'rgba'});
 }finally{renderer.close();expect(closed).toBe(true)}
});
