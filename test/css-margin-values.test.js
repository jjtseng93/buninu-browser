import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine,parseDeclarations,supportsDeclaration} from '../lib/style/computed-style.js';
import {RenderTreeBuilder} from '../lib/render-tree/index.js';
import {layoutText,LayoutEngine} from '../lib/layout/text-layout.js';

function fixture(source,width=400) {
  const f=parseHTMLDocument(`<!doctype html><body style="margin:0">${source}</body>`);
  const styles=new StyleEngine(),builder=new RenderTreeBuilder();let tree,layout;
  const render=(engine=null)=>{
    tree=builder.build(f.document,styles.compute(f.document));
    layout=engine?engine.layout(tree,{x:0,y:0,width,viewportHeight:300}):layoutText(tree,{x:0,y:0,width,viewportHeight:300,measureText:s=>s.length*10});
    return layout;
  };
  const e=id=>f.document.getElementById(id),box=id=>layout.boxes.find(b=>tree.nodesById.get(b.nodeId)?.domNode===e(id));
  return {...f,e,box,render,style:id=>styles.get(e(id)),close:()=>f.window.happyDOM.close()};
}

test('margin CSSOM and stylesheet share signed typed grammar, logical expansion and pending sources',()=>{
  const f=fixture('<main id=parent style="font-size:20px"><div id=box></div></main>'),s=f.e('box').style;
  try {
    for(const [name,value,expected] of [['margin','0 -10% auto calc(1em + 2px)','0px -10% auto calc(1em + 2px)'],['margin-inline','auto auto','auto'],['margin-block','calc(2em + 3ex)','calc(2em + 3ex)']]) {
      s.setProperty(name,value);expect(s.getPropertyValue(name)).toBe(expected);expect(supportsDeclaration(name,value)).toBeTrue();
    }
    for(const name of ['margin','margin-inline','margin-block','margin-top','margin-inline-end'])for(const value of ['1','1px, 2px','calc(1px+2px)','calc(1px + 2)','1px 2px 3px 4px 5px']) {
      s.setProperty(name,'3px','important');s.setProperty(name,value);
      expect(s.getPropertyValue(name)).toBe('3px');expect(s.getPropertyPriority(name)).toBe('important');expect(supportsDeclaration(name,value)).toBeFalse();
      expect(parseDeclarations(`${name}:3px;${name}:${value}`)).toEqual(parseDeclarations(`${name}:3px`));
    }
    s.cssText='--日本:10% 2px; margin:VAR(--日本);margin-left:7px';
    expect(s.margin).toBe('');expect(s.marginTop).toBe('');f.render();expect(f.style('box').margin).toEqual([{unit:'%',value:10},2,{unit:'%',value:10},7]);
    s.setProperty('--日本','bad');f.render();expect(f.style('box').margin).toEqual([0,0,0,7]);
    s.cssText='direction:rtl;--m:10% 2px;margin-inline:var(--m);margin-inline-end:7px';f.render();expect(f.style('box').margin).toEqual([0,{unit:'%',value:10},0,7]);
    s.cssText='margin:1px!important;margin-left:2px';expect(s.margin).toBe('1px');f.render();expect(f.style('box').margin).toEqual([1,1,1,1]);
    s.cssText='margin:1px;all:initial;margin-right:2px';const copy=s.cssText;s.cssText=copy;f.render();expect(f.style('box').margin).toEqual([0,2,0,0]);
    s.cssText='--b:2px solid red;--m:10% 2px;--o:auto hidden;border:var(--b);overflow:var(--o);margin:var(--m);margin-left:7px;overflow-x:scroll;border-left-width:9px';f.render();
    expect(f.style('box').margin).toEqual([{unit:'%',value:10},2,{unit:'%',value:10},7]);expect(f.style('box').borderWidths).toEqual([2,2,2,9]);expect(f.style('box').overflowValueX).toBe('scroll');
    s.removeProperty('margin');f.render();expect(f.style('box').margin).toEqual([0,0,0,0]);expect(f.style('box').borderWidths).toEqual([2,2,2,9]);
    s.cssText='margin-inline:var(--missing, 2px 3px)';s.removeProperty('margin-inline-end');expect(s.marginInline).toBe('');f.render();expect(f.style('box').margin).toEqual([0,0,0,2]);
  } finally {f.close();}
});

test('percentage margins resolve through block collapse, flex, grid and positioned containing blocks',()=>{
  for(const display of ['block','flex','flex;flex-direction:column','grid;grid-template-columns:100px 100px']) {
    const f=fixture(`<main id=parent style="display:${display};width:200px;border:1px solid black"><div id=a style="width:40px;height:10px;flex-shrink:0;margin:10%"></div><div id=b style="width:40px;height:10px;flex-shrink:0;margin:10%"></div></main>`);
    try {
      f.render();const margin=display.startsWith('grid')?10:20;
      expect(f.box('a')).toMatchObject({x:1+margin,y:1+margin,width:40,height:10});expect(f.box('a').style.margin).toEqual([margin,margin,margin,margin]);
      if(display==='flex')expect(f.box('b').x).toBe(101);
      if(display.startsWith('grid'))expect(f.box('b').x).toBe(111);
      if(display==='flex;flex-direction:column')expect(f.box('b').y).toBe(71);
    } finally {f.close();}
  }
  const f=fixture('<main id=parent style="width:200px"><div id=inner style="width:100px"><div id=box style="height:10px;margin:10%"></div></div></main>');
  try {f.render();expect(f.box('box')).toMatchObject({x:10,y:10,width:80,height:10});expect(f.box('parent').y).toBe(10);expect(f.box('inner').y).toBe(10);}finally{f.close();}
  for(const position of ['absolute','fixed']) {
    const f=fixture(`<main style="position:relative;width:200px;height:100px"><div id=box style="position:${position};top:0;left:0;width:40px;height:10px;margin:calc(10% - 5px)"></div></main>`);
    try {f.render();const m=position==='fixed'?35:15;expect(f.box('box')).toMatchObject({x:m,y:m,width:40,height:10});expect(f.box('box').style.margin).toEqual([m,m,m,m]);}finally{f.close();}
  }
});

test('signed percentages, intrinsic sizing and inline cache use the correct margin basis',()=>{
  const f=fixture('<main id=parent style="width:200px;display:flow-root"><span id=inline style="margin:0 10%;background:red">X</span>Y<img id=image width=20 height=10 style="margin:10%"><div id=negative style="height:10px;margin:calc(5% - 20px)"></div></main>');
  try {
    let l=f.render();expect(f.box('inline').x).toBe(20);expect(f.box('image').style.margin).toEqual([20,20,20,20]);expect(f.box('negative').style.margin).toEqual([-10,-10,-10,-10]);
    expect(l.fragments.flatMap(x=>x.runs).find(run=>run.text==='Y').x).toBe(50);
    const engine=new LayoutEngine({measureText:s=>s.length*10});f.render(engine);expect(f.box('inline').x).toBe(20);
    f.e('parent').style.width='300px';f.render(engine);expect(f.box('inline').x).toBe(30);expect(f.box('image').style.margin).toEqual([30,30,30,30]);
    f.e('parent').style.width='200px';f.render(engine);expect(f.box('inline').x).toBe(20);
  }finally{f.close();}
  const intrinsic=fixture('<span id=parent style="display:inline-block"><div id=box style="width:20px;height:10px;margin:calc(10% + 5px)"></div></span>');
  try {intrinsic.render();expect(intrinsic.box('parent').width).toBe(30);expect(intrinsic.box('box').style.margin).toEqual([8,8,8,8]);}finally{intrinsic.close();}
});

test('table captions and floats resolve margins while auto alignment remains unchanged',()=>{
  const f=fixture('<table style="width:200px;border-spacing:0"><caption id=caption style="margin:10%;height:10px">X</caption><tr><td style="height:10px;padding:0">Y</td></tr></table><main style="width:200px"><div id=auto style="width:40px;height:10px;margin:10% auto"></div><span id=float style="float:left;width:20px;height:10px;margin:10%"></span></main>');
  try {
    f.render();expect(f.box('caption')).toMatchObject({x:20,y:20,width:160,height:10});expect(f.box('caption').style.margin).toEqual([20,20,20,20]);
    expect(f.box('auto').x).toBe(80);expect(f.box('auto').style.margin).toEqual([20,'auto',20,'auto']);
    expect(f.box('float').x).toBe(20);expect(f.box('float').style.margin).toEqual([20,20,20,20]);
  }finally{f.close();}
});

test('margin renderer paints deferred geometry and updates used CSSOM values after container resize and rule changes',async()=>{
  const {loadGraphics}=await import('../lib/renderer/page-renderer.js');
  const {RendererHost}=await import('../lib/renderer/host.js');
  const {CanvasKit:kit}=await loadGraphics(),host=new RendererHost({timeout:20000});let image;
  try {
    await host.start();await host.call('resize',200,100,1);
    await host.call('loadDocument',{url:'https://margin.test/',contentType:'text/html',source:'<!doctype html><style>body{margin:0;background:white}main{width:50%;display:flow-root}#box{--a:10%;--b:20%;width:20px;height:10px;background:red;margin:var(--a);margin-left:calc(10% + 5px)}</style><main><div id=box></div></main>'});
    await host.call('whenLoaded');
    const run=code=>host.call('evaluate',code);
    const pixel=async(x,y,width=200)=>{
      image?.delete();image=kit.MakeImageFromEncoded(Buffer.from(await host.call('screenshot',{format:'png'}),'base64'));
      const p=image.readPixels(0,0,{width,height:100,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB});
      return [...p.subarray((y*width+x)*4,(y*width+x)*4+4)];
    };
    expect(await run(`getComputedStyle(document.getElementById('box')).margin`)).toBe('10px 10px 10px 15px');
    expect(await pixel(15,10)).toEqual([255,0,0,255]);expect(await pixel(14,10)).toEqual([255,255,255,255]);
    await host.call('resize',300,100,1);
    expect(await run(`getComputedStyle(document.getElementById('box')).marginInline`)).toBe('20px 15px');
    expect(await pixel(20,15,300)).toEqual([255,0,0,255]);expect(await pixel(19,15,300)).toEqual([255,255,255,255]);
    // The pending source changes even though partial-shorthand cssText is lossy.
    await run(`document.styleSheets[0].cssRules[2].style.cssText='--a:10%;--b:20%;width:20px;height:10px;background:red;margin:var(--b);margin-left:calc(10% + 5px)'`);
    expect(await run(`getComputedStyle(document.getElementById('box')).marginBlock`)).toBe('30px');
    expect(await pixel(20,30,300)).toEqual([255,0,0,255]);expect(await pixel(20,15,300)).toEqual([255,255,255,255]);
    await run(`document.getElementById('box').style.margin='min(10%, 12px) clamp(-10px, calc(5% - 20px), 0px)'`);
    expect(await run(`getComputedStyle(document.getElementById('box')).margin`)).toBe('12px -10px');
  }finally{image?.delete();await host.close();}
});
