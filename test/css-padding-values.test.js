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
    const options={x:0,y:0,width,viewportHeight:300,measureText:s=>s.length*10};
    layout=engine?engine.layout(tree,options):layoutText(tree,options);return layout;
  };
  const e=id=>f.document.getElementById(id),box=id=>layout.boxes.find(b=>tree.nodesById.get(b.nodeId)?.domNode===e(id));
  return {...f,e,box,render,style:id=>styles.get(e(id)),close:()=>f.window.happyDOM.close()};
}

test('padding grammar shares physical/logical validation, priority and canonical math',()=>{
  const f=fixture('<div id=box></div>'),s=f.e('box').style;
  try {
    for(const [name,value,expected] of [['padding','10px 20% 30% 40px','10px 20% 30% 40px'],['padding','0','0px'],['padding-inline','2px 2px','2px'],['padding-block-start','calc(2em + 3%)','calc(3% + 2em)'],['padding-right','calc(0% + 10px)','calc(0% + 10px)']]) {
      s.setProperty(name,value);expect(s.getPropertyValue(name)).toBe(expected);expect(supportsDeclaration(name,value)).toBeTrue();
    }
    for(const value of ['3ex','calc(2em + 3ex)','max(2px, 1lh)']) {
      s.padding=value;expect(s.padding).toBe(value);expect(supportsDeclaration('padding',value)).toBeFalse();
    }
    expect(supportsDeclaration('padding','var(--unknown, 3ex)')).toBeTrue();
    for(const name of ['padding','padding-top','padding-block','padding-inline-start'])for(const value of ['auto','-1px','-1%','1','1px, 2px','calc(1px+2px)','calc(1px + 2)','1px 2px 3px 4px 5px']) {
      s.setProperty(name,'3px','important');s.setProperty(name,value);
      expect(s.getPropertyValue(name)).toBe('3px');expect(s.getPropertyPriority(name)).toBe('important');expect(supportsDeclaration(name,value)).toBeFalse();
      expect(parseDeclarations(`${name}:3px;${name}:${value}`)).toEqual(parseDeclarations(`${name}:3px`));
    }
    s.cssText='padding:9px;padding:calc(-10px)';f.render();expect(f.style('box').padding).toEqual([0,0,0,0]);
    s.cssText='padding:9px;padding:var(--bad);--bad:auto';f.render();expect(f.style('box').padding).toEqual([0,0,0,0]);
    s.cssText='PADDING:2px;padding-left:bad';f.render();expect(f.style('box').padding).toEqual([2,2,2,2]);
  }finally{f.close();}
});

test('padding pending sources share cascade order with margin, border, overflow and all',()=>{
  const f=fixture('<main id=parent style="padding:3px"><div id=box></div></main>'),s=f.e('box').style;
  try {
    s.cssText='--日本:10px 20px;padding:VAR(--日本);padding-left:7px';
    expect(s.padding).toBe('');expect(s.paddingTop).toBe('');f.render();expect(f.style('box').padding).toEqual([10,20,10,7]);
    s.setProperty('--日本','5px');f.render();expect(f.style('box').padding).toEqual([5,5,5,7]);
    s.setProperty('--日本','bad');f.render();expect(f.style('box').padding).toEqual([0,0,0,7]);
    s.cssText='direction:rtl;--p:10px 20px;padding-inline:var(--p);padding-inline-end:7px';f.render();expect(f.style('box').padding).toEqual([0,10,0,7]);
    s.removeProperty('padding-inline-start');expect(s.paddingInline).toBe('');f.render();expect(f.style('box').padding).toEqual([0,0,0,7]);
    s.cssText='padding:2px!important;padding-left:7px';expect(s.padding).toBe('2px');f.render();expect(f.style('box').padding).toEqual([2,2,2,2]);
    s.cssText='--p:2px;--m:3px;--b:1px solid red;--o:hidden auto;padding:var(--p);margin:var(--m);border:var(--b);overflow:var(--o);padding-left:7px;border-left-width:9px;overflow-x:scroll;margin-left:4px';f.render();
    expect(f.style('box').padding).toEqual([2,2,2,7]);expect(f.style('box').margin).toEqual([3,3,3,4]);expect(f.style('box').borderWidths).toEqual([1,1,1,9]);expect(f.style('box').overflowValueX).toBe('scroll');
    s.removeProperty('padding');f.render();expect(f.style('box').padding).toEqual([0,0,0,0]);expect(f.style('box').margin).toEqual([3,3,3,4]);
    for(const source of ['padding:1px;all:initial;padding-left:7px','padding:inherit','padding:2px!important;padding-left:7px!important','direction:rtl;padding:1px;padding-inline-end:9px']) {
      s.cssText=source;f.render();const before=f.style('box').padding;s.cssText=s.cssText;f.render();expect(f.style('box').padding).toEqual(before);
    }
  }finally{f.close();}
});

test('padding percentages and math use the containing width across block, flex, grid and positioned boxes',()=>{
  for(const display of ['block','flex','grid;grid-template-columns:200px']) {
    const f=fixture(`<main style="display:${display};width:200px"><div id=box style="width:40px;height:10px;padding:calc(10% - 5px);flex-shrink:0"><div id=inner style="width:5px;height:5px"></div></div></main>`);
    try {f.render();expect(f.box('box')).toMatchObject({width:70,height:40});expect(f.box('box').style.padding).toEqual([15,15,15,15]);expect(f.box('inner')).toMatchObject({x:15,y:15});}finally{f.close();}
  }
  const f=fixture('<main id=parent style="will-change:transform;width:200px;height:100px"><section style="width:0"><div id=box style="position:absolute;left:0;top:0;width:10px;height:10px;padding:calc(10% - 40px) calc(10% + 5px)"></div></section></main>');
  try {
    const engine=new LayoutEngine({measureText:s=>s.length*10});f.render(engine);expect(f.box('box').style.padding).toEqual([0,25,0,25]);expect(f.box('box')).toMatchObject({width:60,height:10});
    f.e('parent').style.width='500px';f.render(engine);expect(f.box('box').style.padding).toEqual([10,55,10,55]);expect(f.box('box')).toMatchObject({width:120,height:30});
    f.e('parent').style.width='200px';f.render(engine);expect(f.box('box').style.padding).toEqual([0,25,0,25]);
  }finally{f.close();}
});

test('inline text/image padding preserves its containing basis through line caches and resize',()=>{
  const f=fixture('<main id=parent style="width:200px"><span id=text style="padding:10%;background:red">X</span>Y<img id=image width=20 height=10 style="padding:10%;background:blue"></main>');
  try {
    const engine=new LayoutEngine({measureText:s=>s.length*10});
    for(const width of [200,300,200]) {
      f.e('parent').style.width=width+'px';const layout=f.render(engine),padding=width/10,runs=layout.fragments.flatMap(f=>f.runs);
      expect(runs.find(r=>r.text==='X').x).toBe(padding);expect(runs.find(r=>r.text==='Y').x).toBe(padding*2+10);
      expect(f.box('image').style.padding).toEqual([padding,padding,padding,padding]);expect(f.box('image')).toMatchObject({width:20+padding*2,height:10+padding*2});
    }
  }finally{f.close();}
  const table=fixture('<table style="width:200px;border-spacing:0;table-layout:fixed"><tr><td id=box style="padding:10%;height:10px"><div id=inner style="width:5px;height:5px"></div></td></tr></table>');
  try {table.render();expect(table.box('box').style.padding).toEqual([20,20,20,20]);expect(table.box('inner')).toMatchObject({x:20,y:20});}finally{table.close();}
});

test('padding renderer paints used geometry, updates pending rules and retains scroll end padding',async()=>{
  const {loadGraphics}=await import('../lib/renderer/page-renderer.js');
  const {RendererHost}=await import('../lib/renderer/host.js');
  const {CanvasKit:kit}=await loadGraphics(),host=new RendererHost({timeout:20000});let image;
  try {
    await host.start();await host.call('resize',200,120,1);
    await host.call('loadDocument',{url:'https://padding.test/',contentType:'text/html',source:'<!doctype html><style>body{margin:0;background:white}main{width:50%}#box{--a:calc(10% - 5px);--b:20%;width:20px;height:10px;background:green;padding:var(--a);padding-left:calc(10% - 5px)}#inner{width:10px;height:10px;background:red}</style><main><div id=box><div id=inner></div></div></main>'});
    await host.call('whenLoaded');
    const run=code=>host.call('evaluate',code);
    const pixel=async(x,y,width=200)=>{
      image?.delete();image=kit.MakeImageFromEncoded(Buffer.from(await host.call('screenshot',{format:'png'}),'base64'));
      const p=image.readPixels(0,0,{width,height:120,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB});
      return [...p.subarray((y*width+x)*4,(y*width+x)*4+4)];
    };
    expect(await run(`getComputedStyle(document.getElementById('box')).padding`)).toBe('5px');
    expect(await pixel(4,5)).toEqual([0,128,0,255]);expect(await pixel(5,5)).toEqual([255,0,0,255]);expect(await pixel(30,5)).toEqual([255,255,255,255]);
    await host.call('resize',400,120,1);
    expect(await run(`getComputedStyle(document.getElementById('box')).paddingInline`)).toBe('15px');
    expect(await pixel(14,15,400)).toEqual([0,128,0,255]);expect(await pixel(15,15,400)).toEqual([255,0,0,255]);
    // Change a pending source while partial-shorthand cssText stays lossy.
    await run(`document.styleSheets[0].cssRules[2].style.cssText='--a:calc(10% - 5px);--b:20%;width:20px;height:10px;background:green;padding:var(--b);padding-left:calc(10% - 5px)'`);
    expect(await run(`getComputedStyle(document.getElementById('box')).paddingBlock`)).toBe('40px');
    expect(await pixel(15,40,400)).toEqual([255,0,0,255]);expect(await pixel(15,15,400)).toEqual([0,128,0,255]);
    await run(`document.getElementById('box').style.padding='calc(10% - 40px)'`);
    expect(await run(`getComputedStyle(document.getElementById('box')).padding`)).toBe('0px');
    expect(await pixel(0,0,400)).toEqual([255,0,0,255]);
    await host.call('resize',1000,120,1);
    expect(await run(`getComputedStyle(document.getElementById('box')).padding`)).toBe('10px');
    expect(await pixel(10,10,1000)).toEqual([255,0,0,255]);
    await host.call('loadDocument',{url:'https://padding.test/scroll',contentType:'text/html',source:'<!doctype html><body style="margin:0"><main style="width:200px"><div id=scroller style="width:100px;height:50px;overflow:auto;padding:10%"><div style="width:180px;height:120px;background:red"></div></div></main></body>'});
    await host.call('whenLoaded');
    expect(await run(`(()=>{const s=document.getElementById('scroller');s.scrollTop=100;s.scrollLeft=100;return [s.clientWidth,s.clientHeight,s.scrollWidth,s.scrollHeight,s.scrollLeft,s.scrollTop]})()`)).toEqual([140,90,220,160,80,70]);
  }finally{image?.delete();await host.close();}
});
