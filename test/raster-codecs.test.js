import {beforeAll,expect,test} from 'bun:test';
import {loadGraphics} from '../lib/renderer/page-renderer.js';
import {createImageResourceLoader} from '../lib/renderer/image-resources.js';
import {decodeRasterImage,probeRasterImage} from '../lib/renderer/raster-image.js';
import imageSize from '../lib/happy-dom/image-size-adapter.js';
import {rasterFixtures} from './fixtures/raster-codecs.js';
import {createBrowser} from '../lib/headless-shell.js';
let kit;
beforeAll(async()=>{kit=(await loadGraphics()).CanvasKit;});
for(const [name,bytes] of Object.entries(rasterFixtures))test(`raster loader and DOM adapter accept ${name}`,async()=>{
 const load=createImageResourceLoader(kit,async()=>({ok:true,body:bytes}));
 const resource=await load({},'https://image.test/extensionless');
 const size=name==='gif'?[1,1]:[2,3];
 try {
  expect([resource.width,resource.height]).toEqual(size);
  expect(resource.image.readPixels(0,0,{width:1,height:1,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB})).not.toBeNull();
  expect(await imageSize(bytes)).toEqual({width:size[0],height:size[1]});
 } finally {resource.image.delete();}
});
test('allocation guards remain before decoding and invalid Skia handles are released',async()=>{
 let called=0,deleted=0;
 const fake={MakeImageFromEncoded(){called++;return {width:()=>0,height:()=>2,delete(){deleted++;}};}};
 const oversized=Buffer.from(rasterFixtures.bmp8);oversized.writeInt32LE(100000,18);oversized.writeInt32LE(100000,22);
 await expect(decodeRasterImage(fake,oversized)).rejects.toThrow('maxPixels');expect(called).toBe(0);
 const png=Buffer.from(rasterFixtures.png);png.writeUInt32BE(100000,16);png.writeUInt32BE(100000,20);
 await expect(decodeRasterImage(fake,png)).rejects.toThrow('maxPixels');expect(called).toBe(0);
 await expect(decodeRasterImage(fake,rasterFixtures.png)).rejects.toThrow('dimensions');expect(deleted).toBe(1);
 await expect(decodeRasterImage(kit,Buffer.from('not an image'))).rejects.toThrow('decoding');
 await expect(probeRasterImage(Buffer.from([0,0,255,255,255,255,127,1]))).rejects.toThrow('maxPixels');
});
test('PNG JPEG and WebP retain their normal decode path',async()=>{
 for(const format of ['png','jpeg','webp']) {
  const bytes=await new Bun.Image(rasterFixtures.png)[format]().toBuffer();
  expect((await new Bun.Image(bytes).metadata()).format).toBe(format);
  const resource=await decodeRasterImage(kit,bytes);
  try {expect([resource.width,resource.height]).toEqual([2,3]);}finally{resource.image.delete();}
 }
});
test('page img.decode and canvas drawImage accept every tested raster variant',async()=>{
 const browser=await createBrowser({spareRenderer:false});
 try {
  const sources=Object.entries(rasterFixtures).map(([name,bytes])=>[name,'data:application/octet-stream;base64,'+bytes.toString('base64')]);
  await browser.context.navigate('data:text/html,'+encodeURIComponent(`<canvas id="c" width="2" height="3"></canvas><script>
   window.result=null;
   Promise.all(${JSON.stringify(sources)}.map(async ([name,src])=>{
    const image=new Image();document.body.appendChild(image);image.src=src;
    await image.decode();const ctx=c.getContext('2d');ctx.clearRect(0,0,2,3);ctx.drawImage(image,0,0);
    return [name,image.naturalWidth,image.naturalHeight,Array.from(ctx.getImageData(0,0,1,1).data)];
   })).then(rows=>window.result=rows,e=>window.result=String(e));
  </script>`));
  let rows;
  const end=Date.now()+10000;
  while(!(rows=await browser.context.evaluate('window.result')) && Date.now()<end)await Bun.sleep(50);
  expect(Array.isArray(rows)).toBe(true);
  expect(rows.length).toBe(Object.keys(rasterFixtures).length);
  for(const [name,w,h,pixel] of rows){expect([w,h]).toEqual(name==='gif'?[1,1]:[2,3]);expect(pixel.length).toBe(4);if(name.startsWith('bmp'))expect(pixel).toEqual([255,0,0,255]);}
 } finally {await browser.close();}
},30000);

test('unsupported images reject decode, emit error and recover after replacing src',async()=>{
 const browser=await createBrowser({spareRenderer:false});
 try {
  await browser.context.navigate('data:text/html,'+encodeURIComponent('<img id="bad" alt="Unreadable picture"><script>window.errors=0;window.loads=0;bad.onload=()=>loads++;window.rejected=false;bad.onerror=()=>errors++;bad.src="data:image/png;base64,bm90IGFuIGltYWdl";bad.decode().catch(()=>window.rejected=true);</script>'));
  let state;
  for(let i=0;i<100;i++){
    state=await browser.context.evaluate('[window.errors,window.rejected,bad.complete,bad.naturalWidth,bad.alt]');
    if(state[0] && state[1])break;
    await Bun.sleep(30);
  }
  expect(state).toEqual([1,true,true,0,'Unreadable picture']);
  await browser.context.evaluate(`bad.src='data:image/x-icon;base64,${rasterFixtures.ico.toString('base64')}';window.recovered=false;bad.decode().then(()=>window.recovered=true);`);
  for(let i=0;i<100 && !await browser.context.evaluate('window.recovered');i++)await Bun.sleep(30);
  expect(await browser.context.evaluate('[window.recovered,bad.naturalWidth,bad.naturalHeight,window.loads,window.errors]')).toEqual([true,2,3,1,1]);
 }finally{await browser.close();}
},30000);
