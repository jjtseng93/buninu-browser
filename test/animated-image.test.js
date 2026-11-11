import {test,expect,beforeAll} from 'bun:test';
import {loadGraphics} from '../lib/renderer/page-renderer.js';
import {createAnimatedImage,imageOwner,imageSnapshot} from '../lib/renderer/animated-image.js';
import {createImageResourceLoader} from '../lib/renderer/image-resources.js';
import {animatedGif} from './fixtures/animated-gif.js';
let kit;
beforeAll(async()=>{kit=(await loadGraphics()).CanvasKit});
const pixels=image=>Array.from(image.readPixels(0,0,{width:image.width(),height:image.height(),
 colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB}));
function clock(){
 const jobs=new Map();let id=0;
 return {jobs,setTimeout(fn,ms){jobs.set(++id,{fn,ms});return id},clearTimeout(id){jobs.delete(id)},
 step(){const [key,job]=jobs.entries().next().value; jobs.delete(key);job.fn();return job.ms}};
}
test('GIF frame delays, finite loops, pause, restart and deterministic disposal',()=>{
 const c=clock();let changed=0;
 const a=createAnimatedImage(kit,animatedGif({loop:2}),()=>changed++,c);
 expect(a.frameCount).toBe(2);expect(pixels(a.image)).toEqual([255,0,0,255]);
 a.start();expect(c.jobs.size).toBe(1);
 a.configure({paused:true});expect(c.jobs.size).toBe(0);
 a.configure({paused:false});
 const delays=[],colors=[];
 for(let i=0;i<5;i++){delays.push(c.step());colors.push(pixels(a.image))}
 expect(delays).toEqual([100,200,100,200,100]);
 expect(colors).toEqual([[0,255,0,255],[255,0,0,255],[0,255,0,255],[255,0,0,255],[0,255,0,255]]);
 expect(c.jobs.size).toBe(0);
 a.configure({playing:false});a.configure({playing:true});
 expect(pixels(a.image)).toEqual([255,0,0,255]);expect(c.jobs.size).toBe(1);
 a.delete();a.delete();expect(c.jobs.size).toBe(0);expect(changed).toBe(6);
});
test('partial GIF frames compose transparency and restore previous/background',()=>{
 for(const disposal of [2,3]){
  const c=clock();
  const a=createAnimatedImage(kit,animatedGif({width:2,frames:[
   {pixels:[0,0]}, {pixels:[1],x:0,width:1,disposal},
   {pixels:[2],x:1,width:1,transparent:3}
  ]}),()=>{},c);
  a.start();c.step();expect(pixels(a.image)).toEqual([0,255,0,255,255,0,0,255]);
  c.step();expect(pixels(a.image).slice(4)).toEqual([0,0,255,255]);
  if(disposal===3)expect(pixels(a.image).slice(0,4)).toEqual([255,0,0,255]);
  else expect(pixels(a.image).slice(0,4)).toEqual([0,0,0,0]);
  a.delete();
 }
});
test('invisible GIFs stop timers without overriding playback or pause state',()=>{
 const c=clock();let changed=0;
 const a=createAnimatedImage(kit,animatedGif(),()=>changed++,c);
 a.start();a.setVisible(false);expect(c.jobs.size).toBe(0);
 expect(a.frame).toBe(0);expect(changed).toBe(0);
 a.setVisible(true);expect(c.jobs.size).toBe(1);c.step();expect(a.frame).toBe(1);
 a.configure({paused:true});a.setVisible(false);a.setVisible(true);
 expect(c.jobs.size).toBe(0);
 a.configure({paused:false});expect(c.jobs.size).toBe(1);
 a.setVisible(false);a.delete();a.setVisible(true);expect(c.jobs.size).toBe(0);
});
test('coalesced GIF loads own independent decoders and immutable frame snapshots',async()=>{
 let requests=0;
 const load=createImageResourceLoader(kit,async()=>{requests++;return {ok:true,body:animatedGif()}});
 const doc={};
 const [a,b]=await Promise.all([load(doc,'https://gif.test/a'),load(doc,'https://gif.test/a')]);
 try{
  expect(requests).toBe(1);expect(a.animation).not.toBe(b.animation);
  expect(imageSnapshot(a)).toBe(imageSnapshot(a));
  imageOwner(a).delete();expect(pixels(b.image)).toEqual([255,0,0,255]);
 }finally{imageOwner(a).delete();imageOwner(b).delete()}
});
test('transparent pixels preserve prior content and zero delays are bounded',()=>{
 const c=clock();
 const a=createAnimatedImage(kit,animatedGif({width:2,frames:[
  {pixels:[0,2],delay:0},{pixels:[3,1],transparent:3,delay:1}
 ]}),()=>{},c);
 a.start();expect(c.step()).toBe(100);
 expect(pixels(a.image)).toEqual([255,0,0,255,0,255,0,255]);
 expect(c.step()).toBe(100);a.delete();expect(c.jobs.size).toBe(0);
});

test('animated pixel refresh preserves geometry, hit testing and scroll extents',async()=>{
 const {refreshImageSnapshots}=await import('../lib/paint/display-list.js');
 const c=clock(),animation=createAnimatedImage(kit,animatedGif(),()=>{},c);
 const resource=Object.freeze({width:2,height:1,animation,get image(){return animation.image}});
 const items=Object.freeze([{op:'drawImage',image:0,bounds:{x:0,y:0,width:2,height:1}}]);
 const hits=Object.freeze([{nodeId:7,rect:{x:0,y:0,width:2,height:1}}]);
 const scrollers=new Map([[7,{right:2,bottom:1}]]),extent=Object.freeze({width:2,height:1});
 const list=Object.freeze(Object.defineProperties({items,generation:3},{
  images:{value:Object.freeze([imageSnapshot(resource)])},hits:{value:hits},
  scrollers:{value:scrollers},extent:{value:extent}
 }));
 try{
  expect(refreshImageSnapshots(list)).toBe(list);
  animation.start();c.step();
  const next=refreshImageSnapshots(list);
  expect(next).not.toBe(list);expect(next.items).toBe(items);
  expect(next.hits).toBe(hits);expect(next.scrollers).toBe(scrollers);expect(next.extent).toBe(extent);
  expect(Object.keys(next)).toEqual(Object.keys(list));expect(Object.isFrozen(next)).toBe(true);
  expect(next.images[0]).not.toBe(list.images[0]);expect(pixels(next.images[0].image)).toEqual([0,255,0,255]);
  expect(refreshImageSnapshots(next)).toBe(next);
 }finally{animation.delete()}
});
