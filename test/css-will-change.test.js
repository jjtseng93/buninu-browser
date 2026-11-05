import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine,parseDeclarations,supportsDeclaration} from '../lib/style/computed-style.js';
import {RenderTreeBuilder} from '../lib/render-tree/index.js';
import {layoutText,LayoutEngine} from '../lib/layout/text-layout.js';
import {buildDisplayList} from '../lib/paint/display-list.js';

function fixture(source) {
  const f=parseHTMLDocument(`<!doctype html><body style="margin:0">${source}</body>`);
  const styles=new StyleEngine(),builder=new RenderTreeBuilder();let tree,layout;
  const render=(engine=null)=>{
    tree=builder.build(f.document,styles.compute(f.document));
    const options={x:0,y:0,width:400,viewportHeight:300,measureText:s=>s.length*10};
    layout=engine?engine.layout(tree,options):layoutText(tree,options);
    return layout;
  };
  const e=id=>f.document.getElementById(id),box=id=>layout.boxes.find(b=>tree.nodesById.get(b.nodeId)?.domNode===e(id));
  return {...f,e,box,render,style:id=>styles.get(e(id)),list:offset=>buildDisplayList(layout,tree,null,null,offset),close:()=>f.window.happyDOM.close()};
}

test('will-change validates ident lists consistently and preserves pending declarations and inheritance',()=>{
  const f=fixture('<main id=parent style="will-change:opacity"><div id=box></div></main>'),s=f.e('box').style;
  try {
    for(const [value,expected] of [['auto','auto'],['TRANSFORM, transform','TRANSFORM, transform'],['SCROLL-POSITION, CONTENTS','scroll-position, contents'],['Not-A-Property, --日本','Not-A-Property, --日本'],['\\74 ransform','transform']]) {
      s.willChange=value;expect(s.willChange).toBe(expected);expect(supportsDeclaration('will-change',value)).toBeTrue();f.render();expect(f.style('box').willChange).toBe(expected);
    }
    for(const value of ['','auto, opacity','none','all','will-change','initial, opacity','default','transform opacity','transform,','1','"opacity"','opacity()']) {
      s.setProperty('will-change','opacity','important');s.setProperty('will-change',value);
      if(value===''){expect(s.willChange).toBe('');continue;}
      expect(s.willChange).toBe('opacity');expect(s.getPropertyPriority('will-change')).toBe('important');expect(supportsDeclaration('will-change',value)).toBeFalse();
      expect(parseDeclarations(`will-change:opacity;will-change:${value}`)).toEqual(parseDeclarations('will-change:opacity'));
    }
    s.cssText='--日本:transform;will-change:VAR(--日本)';f.render();expect(f.style('box').willChange).toBe('transform');
    s.setProperty('--日本','none');f.render();expect(f.style('box').willChange).toBe('auto');
    s.cssText='will-change:inherit';f.render();expect(f.style('box').willChange).toBe('opacity');
    f.e('parent').style.willChange='position';f.render();expect(f.style('box').willChange).toBe('position');
    s.cssText='will-change:transform;all:initial';f.render();expect(f.style('box').willChange).toBe('auto');
  }finally{f.close();}
});

test('will-change separates absolute and fixed containing blocks with padding-box geometry',()=>{
  for(const [hint,capturesAbs,capturesFixed] of [['transform',true,true],['TRANSFORM',true,true],['translate',true,true],['position',true,false],['opacity',false,false],['height',false,false],['--transform',false,false]]) {
    const f=fixture(`<main id=parent style="will-change:${hint};margin:40px 60px;width:200px;height:100px;border:5px solid black;padding:10px"><div id=a style="position:absolute;left:0;top:0;width:10px;height:10px"></div><div id=b style="position:fixed;left:0;top:0;width:10px;height:10px"></div></main>`);
    try {f.render();expect(f.box('a')).toMatchObject({x:capturesAbs?65:0,y:capturesAbs?45:0});expect(f.box('b')).toMatchObject({x:capturesFixed?65:0,y:capturesFixed?45:0});}finally{f.close();}
  }
  const f=fixture('<main style="will-change:transform;margin:40px 60px;width:200px;height:100px"><section style="position:relative;margin:10px;width:100px;height:50px"><div id=a style="position:absolute;left:0;top:0;width:10px;height:10px"></div><div id=b style="position:fixed;left:0;top:0;width:10px;height:10px"></div></section></main>');
  try {f.render();expect(f.box('a')).toMatchObject({x:70,y:40});expect(f.box('b')).toMatchObject({x:60,y:40});}finally{f.close();}
});

test('non-transformable inline and contents do not capture fixed boxes; actual transforms still do',()=>{
  for(const display of ['inline','contents']) {
    const f=fixture(`<main style="padding:50px"><span style="display:${display};will-change:transform"><div id=box style="position:fixed;left:0;top:0;width:10px;height:10px"></div></span></main>`);
    try {f.render();expect(f.box('box')).toMatchObject({x:0,y:0});}finally{f.close();}
  }
  for(const declaration of ['transform:translate(10px, 20px)','translate:10px 20px','will-change:transform']) {
    const f=fixture(`<main style="${declaration};margin:40px 60px;width:100px;height:100px"><div id=box style="position:fixed;left:0;top:0;width:10px;height:10px"></div></main>`);
    try {f.render();expect(f.box('box')).toMatchObject({x:declaration.startsWith('will')?60:70,y:declaration.startsWith('will')?40:60});expect(f.list().hits.find(h=>h.nodeId===f.box('box').nodeId).fixed).toBeFalse();}finally{f.close();}
  }
});

test('stacking owners survive deferred absolute placement and retained layout replay',()=>{
  const f=fixture('<main id=parent style="will-change:opacity;width:100px;height:100px;background:red"><div id=child style="position:absolute;left:0;top:0;width:100px;height:100px;z-index:-1;background:green"></div></main>');
  const engine=new LayoutEngine({measureText:s=>s.length*10});
  try {
    for(let i=0;i<3;i++) {
      f.render(engine);const parent=f.box('parent'),child=f.box('child'),list=f.list();
      expect(child.layer.parent.nodeId).toBe(parent.nodeId);expect(parent.layer.context).toBeTrue();expect(f.style('parent').opacity).toBe(1);
      expect(list.items.filter(i=>i.op==='fillRect').map(i=>i.nodeId)).toEqual([parent.nodeId,child.nodeId]);
    }
    f.e('parent').style.willChange='height';f.render(engine);expect(f.box('child').layer.parent.order).toBe(0);
    expect(f.list().items.filter(i=>i.op==='fillRect').map(i=>i.nodeId)).toEqual([f.box('child').nodeId,f.box('parent').nodeId]);
    f.e('parent').style.willChange='opacity';f.render(engine);expect(f.box('child').layer.parent.nodeId).toBe(f.box('parent').nodeId);
  }finally{f.close();}
});

test('out-of-flow stacking ancestors are registered before viewport-fixed descendants',()=>{
  for(const position of ['absolute','fixed']) {
    const f=fixture(`<main id=parent style="position:${position};will-change:opacity;left:0;top:0;width:100px;height:100px;background:red"><div id=child style="position:fixed;left:0;top:0;width:100px;height:100px;z-index:-1;background:green"></div></main>`);
    const engine=new LayoutEngine({measureText:s=>s.length*10});
    try {
      for(let i=0;i<3;i++) {
        f.render(engine);expect(f.box('child').layer.parent.nodeId).toBe(f.box('parent').nodeId);
        expect(f.list().items.filter(i=>i.op==='fillRect').map(i=>i.nodeId)).toEqual([f.box('parent').nodeId,f.box('child').nodeId]);
      }
    }finally{f.close();}
  }
});

test('captured fixed descendants scroll and clip with their holder, and return to viewport after removal',()=>{
  const f=fixture('<main id=parent style="will-change:transform;margin:40px 60px;width:100px;height:100px;overflow:auto"><div id=child style="position:fixed;left:0;top:0;width:20px;height:30px;background:green"></div><div style="height:300px"></div></main>');
  const engine=new LayoutEngine({measureText:s=>s.length*10}),offset=e=>e===f.e('parent')?{x:0,y:20}:null;
  try {
    f.render(engine);let hit=f.list(offset).hits.find(h=>h.nodeId===f.box('child').nodeId);
    expect(hit).toMatchObject({fixed:false,rect:{x:60,y:20,width:20,height:30},clipRect:{x:60,y:40,width:100,height:100}});
    f.e('parent').style.willChange='auto';f.render(engine);hit=f.list(offset).hits.find(h=>h.nodeId===f.box('child').nodeId);
    expect(hit).toMatchObject({fixed:true,rect:{x:0,y:0,width:20,height:30},clipRect:null});
    f.e('parent').style.willChange='transform';f.render(engine);hit=f.list(offset).hits.find(h=>h.nodeId===f.box('child').nodeId);
    expect(hit.rect.y).toBe(20);expect(hit.fixed).toBeFalse();
  }finally{f.close();}
});

test('blockified flex and grid items honor stacking hints while static z-index remains inert',()=>{
  for(const display of ['flex','grid']) {
    const f=fixture(`<main style="display:${display};margin:40px 60px;width:100px;height:100px"><span id=parent style="will-change:transform;z-index:3"><div id=child style="position:fixed;left:0;top:0;width:20px;height:20px"></div></span></main>`);
    try {f.render();expect(f.box('child')).toMatchObject({x:60,y:40});expect(f.box('parent').layer.z).toBe(3);}finally{f.close();}
  }
  const f=fixture('<div id=parent style="will-change:opacity;z-index:7;width:100px;height:100px"></div>');
  try {f.render();expect(f.box('parent').layer.z).toBe(0);}finally{f.close();}
});

test('will-change renderer paints stacking and fixed scroll capture, then restores viewport geometry',async()=>{
  const {loadGraphics}=await import('../lib/renderer/page-renderer.js');
  const {RendererHost}=await import('../lib/renderer/host.js');
  const {CanvasKit:kit}=await loadGraphics(),host=new RendererHost({timeout:20000});let image;
  try {
    await host.start();await host.call('resize',240,200,1);
    await host.call('loadDocument',{url:'https://will-change.test/',contentType:'text/html',source:'<!doctype html><style>body{margin:0;background:white}#holder{will-change:transform;margin:40px 60px;width:100px;height:100px;overflow:auto;background:red}#fixed{position:fixed;left:0;top:0;width:20px;height:30px;background:green}#tall{height:300px}</style><main id=holder><div id=fixed></div><div id=tall></div></main>'});
    await host.call('whenLoaded');
    const run=code=>host.call('evaluate',code);
    const pixel=async(x,y)=>{
      image?.delete();image=kit.MakeImageFromEncoded(Buffer.from(await host.call('screenshot',{format:'png'}),'base64'));
      const p=image.readPixels(0,0,{width:240,height:200,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB});
      return [...p.subarray((y*240+x)*4,(y*240+x)*4+4)];
    };
    const rect=()=>run(`(()=>{const r=document.getElementById('fixed').getBoundingClientRect();return [r.x,r.y]})()`);
    expect(await run(`getComputedStyle(document.getElementById('holder')).willChange`)).toBe('transform');
    expect(await rect()).toEqual([60,40]);expect(await pixel(65,45)).toEqual([0,128,0,255]);
    await run(`document.getElementById('holder').scrollTop=20`);
    expect(await rect()).toEqual([60,20]);expect(await pixel(65,35)).toEqual([255,255,255,255]);expect(await pixel(65,45)).toEqual([0,128,0,255]);expect(await pixel(65,55)).toEqual([255,0,0,255]);
    await run(`document.getElementById('holder').style.willChange='auto'`);
    expect(await rect()).toEqual([0,0]);expect(await pixel(5,5)).toEqual([0,128,0,255]);expect(await pixel(65,45)).toEqual([255,0,0,255]);
    await run(`document.getElementById('holder').style.willChange='transform'`);
    expect(await rect()).toEqual([60,20]);expect(await pixel(5,5)).toEqual([255,255,255,255]);
    await run(`document.getElementById('holder').style.cssText='will-change:opacity;margin:0;width:100px;height:100px;overflow:visible;background:red';document.getElementById('fixed').style.cssText='position:absolute;left:0;top:0;z-index:-1;width:100px;height:100px;background:green';document.getElementById('tall').remove()`);
    expect(await pixel(5,5)).toEqual([0,128,0,255]);
    await run(`document.getElementById('holder').style.willChange='height'`);
    expect(await run(`getComputedStyle(document.getElementById('holder')).willChange`)).toBe('height');
    expect(await pixel(5,5)).toEqual([255,0,0,255]);
  }finally{image?.delete();await host.close();}
},30000);
