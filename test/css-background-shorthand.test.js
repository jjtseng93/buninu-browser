import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine,parseDeclarations,supportsDeclaration} from '../lib/style/computed-style.js';
import {expandBackgroundValue} from '../lib/style/background-values.js';
import {parseCSSOMRules,renderStyleSheet} from '../lib/renderer/stylesheet-parser.js';
import {RenderTreeBuilder} from '../lib/render-tree/index.js';
import {layoutText} from '../lib/layout/text-layout.js';
import {buildDisplayList} from '../lib/paint/display-list.js';

const fixture=()=>{
 const result=parseHTMLDocument('<body style="margin:0"><div id=box></div></body>'),e=result.document.getElementById('box');
 return {...result,e,s:e.style,read:(sheets=[])=>new StyleEngine().compute(result.document,sheets).get(e)};
};
const projection=s=>[s.backgroundImage,s.backgroundPositionX,s.backgroundPositionY,s.backgroundSizeValues,s.backgroundRepeat,s.backgroundColor,s.backgroundOrigin,s.backgroundClip,s.backgroundAttachment];

test('background grammar preserves layers, size slash, defaults and final color',()=>{
 const f=fixture();try {
  const value='url("a.png") 1px 2px / 3px 4px space round local padding-box content-box, rgb(5, 6, 7) url("b.png") right 2px bottom 3px / contain no-repeat border-box';
  f.s.background=value;
  expect(f.s.backgroundImage).toBe('url("a.png"), url("b.png")');
  expect(f.s.backgroundPosition).toBe('1px 2px, right 2px bottom 3px');
  expect(f.s.backgroundSize).toBe('3px 4px, contain');
  expect(f.s.backgroundRepeat).toBe('space round, no-repeat');
  expect(f.s.backgroundColor).toBe('rgb(5, 6, 7)');
  expect(f.s.backgroundOrigin).toBe('padding-box, border-box');
  expect(f.s.backgroundClip).toBe('content-box, border-box');
  const expected=projection(f.read()),text=f.s.cssText;f.s.cssText=text;expect(projection(f.read())).toEqual(expected);expect(f.s.cssText).toBe(text);
  f.s.background='none';expect([f.s.backgroundImage,f.s.backgroundPosition,f.s.backgroundSize,f.s.backgroundRepeat,f.s.backgroundAttachment,f.s.backgroundOrigin,f.s.backgroundClip,f.s.backgroundColor]).toEqual(['none','0% 0%','auto','repeat','scroll','padding-box','border-box','transparent']);
  for(const invalid of ['red,blue','black 0 url(x) / cover','url(x) / cover','0 0 / -1px','0 0 / 1px 2px 3px','center /','url(a) url(b)','url("a" "b")','repeat no-repeat repeat','fixed scroll','left right','top bottom','top 10px','10px left','padding-box content-box border-box']) {
   f.s.background='red';f.s.background=invalid;expect(f.s.background).toBe('red');expect(expandBackgroundValue('background',invalid)).toBeNull();
   expect(parseDeclarations(`background:red;background:${invalid}`)).toEqual(parseDeclarations('background:red'));
  }
  for(const value of ['url()','url("")',String.raw`url(a\ b.png)`,String.raw`url(a\20 b.png)`,'url("a\\\nb")','padding-box text','content-box border-area','padding-box red content-box','conic-gradient(red,blue)']) {
   f.s.background=value;expect(f.s.background).not.toBe('red');const before=f.s.cssText;f.s.cssText=before;expect(f.s.cssText).toBe(before);
  }
  f.s.cssText='background:light-dark(red,blue);color-scheme:dark';expect(f.read().backgroundColor).toBe('rgba(0, 0, 255, 1)');
  f.s.cssText='background:currentcolor;color:blue';expect(f.read().backgroundColor).toBe('rgba(0, 0, 255, 1)');
 }finally{f.window.happyDOM.close();}
});

test('background shorthand CSSOM updates retain real software image placement and live pending sources',async()=>{
 const {loadGraphics}=await import('../lib/renderer/page-renderer.js');
 const {RendererHost}=await import('../lib/renderer/host.js');
 const {CanvasKit:kit}=await loadGraphics(),host=new RendererHost({timeout:20000});let image;
 try {
  const surface=kit.MakeSurface(40,20);surface.getCanvas().clear(kit.Color(255,0,0,1));
  const snapshot=surface.makeImageSnapshot(),url='data:image/png;base64,'+Buffer.from(snapshot.encodeToBytes()).toString('base64');snapshot.delete();surface.delete();
  await host.start();await host.call('resize',80,40,1);
  const source=`--a:url("${url}") left top / 20px 10px no-repeat;--b:url("${url}") right bottom / 20px 10px no-repeat;background:var(--a);background-color:white`;
  await host.call('loadDocument',{url:'https://background-shorthand.test/',contentType:'text/html',source:`<!doctype html><style>body{margin:0;background:white}#box{width:80px;height:40px;${source}}</style><div id=box></div>`});
  await host.call('whenLoaded');
  const pixels=async()=>{
   image?.delete();image=kit.MakeImageFromEncoded(Buffer.from(await host.call('screenshot',{format:'png'}),'base64'));
   const bytes=image.readPixels(0,0,{width:80,height:40,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB});
   return (x,y)=>[...bytes.subarray((y*80+x)*4,(y*80+x)*4+4)];
  };
  let pixel=await pixels();expect(pixel(5,5)).toEqual([255,0,0,255]);expect(pixel(75,35)).toEqual([255,255,255,255]);
  await host.call('evaluate',`document.styleSheets[0].cssRules[1].style.cssText=${JSON.stringify('width:80px;height:40px;'+source.replace('background:var(--a)','background:var(--b)'))}`);
  pixel=await pixels();expect(pixel(5,5)).toEqual([255,255,255,255]);expect(pixel(75,35)).toEqual([255,0,0,255]);
  await host.call('evaluate',`document.getElementById('box').style.cssText=${JSON.stringify(`background:url("${url}") right 5px bottom 5px no-repeat;background-size:30px 10px`)}`);
  pixel=await pixels();expect(pixel(50,30)).toEqual([255,0,0,255]);expect(pixel(40,30)).toEqual([255,255,255,255]);
  expect(await host.call('evaluate',`getComputedStyle(document.getElementById('box')).background`)).toContain('30px 10px');
  await host.call('evaluate',`document.getElementById('box').style.backgroundPositionX='10%'`);
  pixel=await pixels();expect(pixel(10,30)).toEqual([255,0,0,255]);expect(pixel(50,30)).toEqual([255,255,255,255]);
  expect(await host.call('evaluate',`getComputedStyle(document.getElementById('box')).backgroundPosition`)).toBe('10% calc(100% - 5px)');
  await host.call('evaluate',`document.getElementById('box').style.cssText=document.getElementById('box').style.cssText`);
  pixel=await pixels();expect(pixel(10,30)).toEqual([255,0,0,255]);expect(pixel(50,30)).toEqual([255,255,255,255]);
 } finally {image?.delete();await host.close();}
});

test('background CSSOM serialization keeps size, list lengths, priorities and source order',()=>{
 const f=fixture();try {
  for(const text of [
   'background:url(x);background-size:20px',
   'background:url(x);background-size:20px 30px',
   'background:url(x);background-size:20px,30px',
   'background:url(x);background-position:20% 30%;background-size:20px',
   'background:url(x);background-size:20px;all:initial;background-size:30px',
   'background:red!important;background-size:20px!important',
   'background:red;background-size:20px!important',
   'background:red;color:blue;all:initial;background-image:url(x);background-size:20px',
  ]) {
   f.e.setAttribute('style',text);const raw=projection(f.read());f.s.cssText=text;expect(projection(f.read())).toEqual(raw);
   const serialized=f.s.cssText;f.s.cssText=serialized;expect(projection(f.read())).toEqual(raw);
  }
  f.s.cssText='background:red;background-size:20px!important';expect(f.s.background).toBe('');expect(f.s.getPropertyPriority('background-size')).toBe('important');
  f.s.cssText='background:url(x);background-size:20px,30px';expect(f.s.background).toBe('');expect(f.s.cssText).toContain('background-size: 20px auto, 30px auto');
  f.s.background='inherit';expect(f.s.background).toBe('inherit');f.s.backgroundSize='10px';expect(f.s.background).toBe('');
  f.e.parentElement.style.backgroundImage='url(parent)';f.s.cssText='all:inherit;background:none,none';
  expect(f.read().backgroundImage).toBe('none, none');
 }finally{f.window.happyDOM.close();}
});

test('pending backgrounds share per-longhand metadata and live stylesheet publication',()=>{
 const f=fixture();try {
  for(const value of ['VAR(--日本)','var(--x)/**/','env(unknown, red)'])expect(supportsDeclaration('background',value)).toBeTrue();
  f.s.cssText='--a:url(a) right bottom / 40px 20px red;background:VAR(--a);background-size:10px 5px';
  expect(f.s.background).toBe('');expect(f.s.backgroundImage).toBe('');expect(f.read().backgroundImage).toBe('url("a")');expect(f.read().backgroundSizeValues).toEqual([[10,5]]);
  f.s.setProperty('--a','url(b) center / 60px 30px blue');expect(f.read().backgroundImage).toBe('url("b")');expect(f.read().backgroundColor).toBe('rgba(0, 0, 255, 1)');
  f.s.removeProperty('background-image');expect(f.read().backgroundImage).toBeNull();expect(f.read().backgroundSizeValues).toEqual([[10,5]]);
  f.s.cssText='--日本:url(x) 20% 30% / 40px 50px;background:var(--日本)!important;background-size:5px';expect(f.s.background).toBe('var(--日本)');expect(f.read().backgroundSizeValues).toEqual([[40,50]]);
  f.s.backgroundSize='5px';expect(f.s.background).toBe('');expect(f.read().backgroundSizeValues).toEqual([[5,'auto']]);
  f.s.setProperty('--日本','invalid');expect(f.read().backgroundImage).toBeNull();expect(f.read().backgroundSizeValues).toEqual([[5,'auto']]);
  f.s.cssText='--bg:url(x) red;--b:2px solid blue;--o:auto hidden;background:var(--bg);background-size:10px;border:var(--b);border-left-width:5px;overflow:var(--o);overflow-x:scroll;all:initial;background-position:20% 30%';
  const s=f.read();expect(s.backgroundImage).toBeNull();expect(s.backgroundSizeValues).toEqual([['auto','auto']]);expect([s.backgroundPositionX,s.backgroundPositionY]).toEqual(['20%','30%']);expect(s.borderWidths).toEqual([0,0,0,0]);
  f.e.removeAttribute('style');const source='--a:url(a) 10% 20% / 40px red;--b:url(b) 30% 40% / 50px blue;background:var(--a);background-size:10px';
  const rules=parseCSSOMRules(f.window,`#box{${source}}`,null),sheet=()=>[renderStyleSheet(rules)];expect(f.read(sheet()).backgroundImage).toBe('url("a")');
  rules[0].style.cssText=source.replace('background:var(--a)','background:var(--b)');expect(f.read(sheet()).backgroundImage).toBe('url("b")');expect(f.read(sheet()).backgroundSizeValues).toEqual([[10,'auto']]);
  f.e.setAttribute('style','font-size:clamp(10px,20px,30px);--b:url(a);background:var(--b);background-size:10px');const before=f.read();void f.s.cssText;expect(projection(f.read())).toEqual(projection(before));expect(f.read().fontSize).toBe(20);
 }finally{f.window.happyDOM.close();}
});

test('background CSSOM position axes and shorthand sizing reach actual image tiles',()=>{
 const f=fixture();try {
  f.s.cssText='width:100px;height:60px;background:url(x) right 5px bottom 10px / 20px 10px no-repeat';
  const tile=()=>{const tree=new RenderTreeBuilder().build(f.document,new StyleEngine().compute(f.document));return buildDisplayList(layoutText(tree,{x:0,y:0,width:200}),tree,null,()=>({width:40,height:20,image:{}})).items.find(item=>item.op==='drawBackgroundImage');};
  expect(tile().tile).toEqual({x:75,y:40,width:20,height:10});
  f.s.backgroundPositionX='20%';expect(tile().tile).toEqual({x:16,y:40,width:20,height:10});
  f.s.backgroundPositionY='calc(50% - 5px)';expect(tile().tile).toEqual({x:16,y:20,width:20,height:10});
  f.s.backgroundSize='40px auto';expect(tile().tile).toEqual({x:12,y:15,width:40,height:20});
  f.s.cssText=f.s.cssText;expect(tile().tile).toEqual({x:12,y:15,width:40,height:20});
 }finally{f.window.happyDOM.close();}
});
