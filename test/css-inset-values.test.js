import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine,parseDeclarations,supportsDeclaration} from '../lib/style/computed-style.js';
import {RenderTreeBuilder} from '../lib/render-tree/index.js';
import {layoutText,LayoutEngine} from '../lib/layout/text-layout.js';

function fixture(source,width=400,height=300) {
  const f=parseHTMLDocument(`<!doctype html><body style="margin:0">${source}</body>`),styles=new StyleEngine(),builder=new RenderTreeBuilder();let tree,layout;
  const render=(engine=null)=>{tree=builder.build(f.document,styles.compute(f.document));const options={x:0,y:0,width,viewportHeight:height,measureText:s=>s.length*10};layout=engine?engine.layout(tree,options):layoutText(tree,options);return layout;};
  const e=id=>f.document.getElementById(id),box=id=>layout.boxes.find(b=>tree.nodesById.get(b.nodeId)?.domNode===e(id));
  return {...f,e,box,render,style:id=>styles.get(e(id)),close:()=>f.window.happyDOM.close()};
}

test('inset grammar shares signed auto lengths and invalid retention across CSSOM and stylesheets',()=>{
  const f=fixture('<div id=box></div>'),s=f.e('box').style;
  try {
    for(const [name,value,expected] of [['inset','0','0px'],['inset','10% -5px auto calc(1em + 2px)','10% -5px auto calc(1em + 2px)'],['inset-inline','auto auto','auto'],['inset-block-end','-10%','-10%'],['top','calc(2em + 3%)','calc(3% + 2em)']]) {
      s.setProperty(name,value);expect(s.getPropertyValue(name)).toBe(expected);expect(supportsDeclaration(name,value)).toBeTrue();
    }
    for(const name of ['inset','inset-inline','inset-block-start','top','left'])for(const value of ['min-content','0deg','10','calc(20deg)','calc(1px+2px)','inherit auto','1px, 2px','1px 2px 3px 4px 5px']) {
      s.setProperty(name,'3px','important');s.setProperty(name,value);expect(s.getPropertyValue(name)).toBe('3px');expect(s.getPropertyPriority(name)).toBe('important');expect(supportsDeclaration(name,value)).toBeFalse();
      expect(parseDeclarations(`${name}:3px;${name}:${value}`)).toEqual(parseDeclarations(`${name}:3px`));
    }
    s.cssText='inset:9px;inset:calc(-10px)';f.render();expect(f.style('box').inset).toEqual([-10,-10,-10,-10]);
    s.cssText='inset:9px;inset:var(--bad);--bad:min-content';f.render();expect(f.style('box').inset).toEqual(['auto','auto','auto','auto']);
    s.cssText='INSET:1px 2px;LEFT:3px';f.render();expect(f.style('box').inset).toEqual([1,2,1,3]);
    s.top='calc(2em + 3ex)';expect(s.top).toBe('calc(2em + 3ex)');expect(supportsDeclaration('top',s.top)).toBeFalse();
    for(const value of ['abs(-10px)','round(12px, 5px)']) {
      s.top=value;expect(s.top).toBe(value);expect(supportsDeclaration('top',value)).toBeFalse();
    }
  }finally{f.close();}
});

test('pending inset sources preserve individual sides, logical order, priority and other shorthand metadata',()=>{
  const f=fixture('<main style="inset:1px 2px"><div id=box></div></main>'),s=f.e('box').style;
  try {
    s.cssText='--日本:10px 20px;inset:VAR(--日本);left:7px';expect(s.inset).toBe('');expect(s.top).toBe('');f.render();expect(f.style('box').inset).toEqual([10,20,10,7]);
    s.setProperty('--日本','5px');f.render();expect(f.style('box').inset).toEqual([5,5,5,7]);
    s.setProperty('--日本','bad');f.render();expect(f.style('box').inset).toEqual(['auto','auto','auto',7]);
    s.cssText='direction:rtl;--i:10px 20px;inset-inline:var(--i);inset-inline-end:7px';f.render();expect(f.style('box').inset).toEqual(['auto',10,'auto',7]);
    s.removeProperty('inset-inline-start');expect(s.insetInline).toBe('');f.render();expect(f.style('box').inset).toEqual(['auto','auto','auto',7]);
    s.cssText='inset:2px!important;left:7px';expect(s.inset).toBe('2px');f.render();expect(f.style('box').inset).toEqual([2,2,2,2]);
    s.cssText='--i:2px;--p:3px;--b:1px solid red;--o:hidden auto;inset:var(--i);padding:var(--p);border:var(--b);overflow:var(--o);left:7px;border-left-width:9px;overflow-x:scroll;padding-left:4px';f.render();
    expect(f.style('box').inset).toEqual([2,2,2,7]);expect(f.style('box').padding).toEqual([3,3,3,4]);expect(f.style('box').borderWidths).toEqual([1,1,1,9]);expect(f.style('box').overflowValueX).toBe('scroll');
    s.removeProperty('inset');f.render();expect(f.style('box').inset).toEqual(['auto','auto','auto','auto']);expect(f.style('box').padding).toEqual([3,3,3,4]);
    for(const source of ['inset:1px;all:initial;left:7px','inset:inherit','inset:2px!important;left:7px!important','direction:rtl;inset:1px;inset-inline-end:9px']) {s.cssText=source;f.render();const before=f.style('box').inset;s.cssText=s.cssText;f.render();expect(f.style('box').inset).toEqual(before);}
  }finally{f.close();}
});

test('inset physical and logical percentages use real positioned containing blocks through resize',()=>{
  for(const [position,trigger,expected] of [['absolute','position:relative',[20,10]],['fixed','position:relative',[40,30]],['fixed','will-change:transform',[20,10]]]) {
    const f=fixture(`<main style="${trigger};width:200px;height:100px"><div id=box style="position:${position};width:20px;height:10px;inset-block:10% auto;inset-inline:10% auto"></div></main>`);
    try {f.render();expect(f.box('box')).toMatchObject({x:expected[0],y:expected[1],width:20,height:10});}finally{f.close();}
  }
  const f=fixture('<main id=parent style="position:relative;width:200px;height:100px"><div id=box style="position:absolute;direction:rtl;inset-inline:10% auto;inset-block:calc(10% - 5px) auto;width:20px;height:10px"></div></main>');
  try {
    const engine=new LayoutEngine({measureText:s=>s.length*10});f.render(engine);expect(f.box('box')).toMatchObject({x:160,y:5});
    f.e('parent').style.cssText='position:relative;width:300px;height:200px';f.render(engine);expect(f.box('box')).toMatchObject({x:250,y:15});
    f.e('box').style.insetInline='-10% auto';f.render(engine);expect(f.box('box').x).toBe(310);
    f.e('parent').style.cssText='position:relative;width:200px;height:100px';f.e('box').style.insetInline='10% auto';f.render(engine);expect(f.box('box')).toMatchObject({x:160,y:5});
  }finally{f.close();}
});

test('relative insets shift boxes without changing flow and auto opposing sides retain the offset',()=>{
  const f=fixture('<main style="width:200px;height:100px"><div id=box style="position:relative;inset:calc(10% - 5px) auto auto calc(10% - 5px);width:20px;height:10px;background:red"></div><div id=next style="width:20px;height:10px"></div></main>');
  try {f.render();expect(f.box('box')).toMatchObject({x:15,y:5});expect(f.box('next')).toMatchObject({x:0,y:10});
    f.e('box').style.inset='auto 10px 20px auto';f.render();expect(f.box('box')).toMatchObject({x:-10,y:-20});expect(f.box('next').y).toBe(10);
  }finally{f.close();}
});

test('inset renderer positions pending rules, updates direction and keeps static computed values',async()=>{
  const {loadGraphics}=await import('../lib/renderer/page-renderer.js');
  const {RendererHost}=await import('../lib/renderer/host.js');
  const {CanvasKit:kit}=await loadGraphics(),host=new RendererHost({timeout:20000});let image;
  try {
    await host.start();await host.call('resize',200,120,1);
    await host.call('loadDocument',{url:'https://inset.test/',contentType:'text/html',source:'<!doctype html><style>body{margin:0;background:white}main{position:relative;width:50%;height:100px}#box{--a:10%;--b:20%;position:absolute;width:20px;height:10px;background:red;inset:var(--a);right:auto;bottom:auto}</style><main><div id=box></div></main><div id=static style="inset-inline:10% auto"></div>'});
    await host.call('whenLoaded');const run=code=>host.call('evaluate',code);
    const pixel=async(x,y,width=200)=>{
      image?.delete();image=kit.MakeImageFromEncoded(Buffer.from(await host.call('screenshot',{format:'png'}),'base64'));
      const p=image.readPixels(0,0,{width,height:120,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB});
      return [...p.subarray((y*width+x)*4,(y*width+x)*4+4)];
    };
    expect(await pixel(10,10)).toEqual([255,0,0,255]);expect(await pixel(9,10)).toEqual([255,255,255,255]);
    expect(await run(`getComputedStyle(document.getElementById('static')).insetInline`)).toBe('10% auto');
    await host.call('resize',400,120,1);
    expect(await pixel(20,10,400)).toEqual([255,0,0,255]);expect(await pixel(19,10,400)).toEqual([255,255,255,255]);
    await run(`document.styleSheets[0].cssRules[2].style.cssText='--a:10%;--b:20%;position:absolute;width:20px;height:10px;background:red;inset:var(--b);right:auto;bottom:auto'`);
    expect(await pixel(40,20,400)).toEqual([255,0,0,255]);expect(await pixel(20,10,400)).toEqual([255,255,255,255]);
    await run(`document.getElementById('box').style.cssText='direction:rtl;inset-inline:10% auto;inset-block:10px auto'`);
    expect(await pixel(160,10,400)).toEqual([255,0,0,255]);expect(await pixel(159,10,400)).toEqual([255,255,255,255]);
    expect(await run(`getComputedStyle(document.getElementById('box')).insetBlockStart`)).toBe('10px');
    await run(`document.getElementById('box').style.insetInline='auto -5px'`);
    expect(await pixel(0,10,400)).toEqual([255,0,0,255]);expect(await pixel(15,10,400)).toEqual([255,255,255,255]);
  }finally{image?.delete();await host.close();}
});
