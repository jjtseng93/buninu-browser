import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine,parseDeclarations,supportsDeclaration} from '../lib/style/computed-style.js';
import {normalizeGap} from '../lib/style/gap-values.js';
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
const items='<i id=a style="display:block;width:20px;height:20px;flex:none"></i><i id=b style="display:block;width:20px;height:20px;flex:none"></i>';

test('gap grammar, CSSOM aliases and shorthand priority share one declaration store',()=>{
  const f=fixture('<div id=box></div>'),s=f.e('box').style;
  try {
    for(const [value,expected] of [['0','0px'],['normal normal','normal'],['10px 20%','10px 20%'],['calc(2em + 3%)','calc(3% + 2em)']]) {
      s.gap=value;expect(s.gap).toBe(expected);expect(s.gridGap).toBe(expected);expect(supportsDeclaration('gap',value)).toBeTrue();
    }
    for(const name of ['gap','row-gap','column-gap','grid-gap','grid-row-gap','grid-column-gap']) {
      for(const value of ['auto','-1px','-1%','1','1px, 2px','1px 2px 3px','calc(1px+2px)','calc(1px + 2)','\u00a010px','10px\u00a0']) {
        s.cssText='';s.setProperty(name,'3px','important');s.setProperty(name,value);
        expect(s.getPropertyValue(name)).toBe('3px');expect(s.getPropertyPriority(name)).toBe('important');expect(normalizeGap(name,value)).toBeNull();expect(supportsDeclaration(name,value)).toBeFalse();
        expect(parseDeclarations(`${name}:3px;${name}:${value}`)).toEqual(parseDeclarations(`${name}:3px`));
      }
    }
    s.cssText='grid-gap:2px 3px;row-gap:5px';expect(s.gap).toBe('5px 3px');expect([...Array(s.length)].map((_,i)=>s.item(i))).toEqual(['column-gap','row-gap']);
    s.gridColumnGap='7px';expect(s.columnGap).toBe('7px');expect(s.removeProperty('grid-row-gap')).toBe('5px');expect(s.rowGap).toBe('');
    s.cssText='gap:2px!important;column-gap:7px';expect(s.gap).toBe('2px');s.setProperty('column-gap','7px','important');expect(s.gap).toBe('2px 7px');
    s.removeProperty('grid-gap');expect(s.length).toBe(0);
  }finally{f.close();}
});

test('gap pending values retain partial overrides, invalid-at-computed-time resets and source order',()=>{
  const f=fixture('<div id=box></div>'),s=f.e('box').style;
  try {
    s.cssText='--日本:10px 20px;grid-gap:VAR(--日本);column-gap:7px';expect(s.gap).toBe('');expect(s.rowGap).toBe('');f.render();expect([f.style('box').rowGap,f.style('box').columnGap]).toEqual([10,7]);
    s.setProperty('--日本','5px');f.render();expect([f.style('box').rowGap,f.style('box').columnGap]).toEqual([5,7]);
    s.setProperty('--日本','bad');f.render();expect(f.style('box').rowGapNormal).toBeTrue();expect(f.style('box').columnGap).toBe(7);
    s.cssText='gap:9px;gap:calc(-10px)';f.render();expect([f.style('box').rowGap,f.style('box').columnGap]).toEqual([0,0]);expect(f.style('box').rowGapNormal).toBeFalse();
    for(const source of ['gap:1px;all:initial;column-gap:7px','gap:2px!important;column-gap:7px!important']) {
      s.cssText=source;f.render();const before=f.style('box');s.cssText=s.cssText;f.render();const after=f.style('box');
      for(const name of ['rowGap','columnGap','rowGapNormal','columnGapNormal','padding','borderWidths'])expect(after[name]).toEqual(before[name]);
    }
    s.cssText='--g:2px;--p:3px;--b:1px solid red;gap:var(--g);padding:var(--p);border:var(--b);row-gap:7px;padding-left:9px;border-left-width:4px';
    f.render();expect([f.style('box').rowGap,f.style('box').columnGap]).toEqual([7,2]);
    expect(f.style('box').padding).toEqual([3,3,3,9]);expect(f.style('box').borderWidths).toEqual([1,1,1,4]);
    // Chromium also serializes a partial pending shorthand as empty longhands.
    // Re-parsing that lossy string deliberately discards its pending source.
    expect(s.columnGap).toBe('');s.cssText=s.cssText;f.render();
    expect(f.style('box').rowGap).toBe(7);expect(f.style('box').columnGapNormal).toBeTrue();
    s.cssText='--g:10px\u00a0;gap:var(--g)';f.render();expect(f.style('box').rowGapNormal).toBeTrue();
  }finally{f.close();}
});

test('definite flex and grid gaps resolve their own content-box axes including reverse and wrapping',()=>{
  for(const display of ['flex','flex;flex-direction:row-reverse','flex;flex-direction:column','flex;flex-direction:column-reverse','grid;grid-template-columns:20px 20px']) {
    const f=fixture(`<main id=box style="display:${display};width:200px;height:100px;padding:10px;border:5px solid;gap:calc(10% + 5px) calc(20% - 5px)">${items}</main>`);
    try {
      f.render();const a=f.box('a'),b=f.box('b'),column=display.includes('flex-direction:column');
      expect(Math.abs(column?b.y-a.y:b.x-a.x)).toBe(column?35:55);expect(f.box('box')).toMatchObject({width:230,height:130});
    }finally{f.close();}
  }
  const f=fixture(`<main style="display:flex;flex-wrap:wrap;width:30px;height:100px;gap:10%">${items}</main>`);
  try{f.render();expect(f.box('b').y-f.box('a').y).toBe(30);}finally{f.close();}
});

test('auto block-axis flex gaps use zero while final inline/grid gaps can overflow intrinsic dimensions',()=>{
  const cases=[
    ['display:flex;flex-direction:column;row-gap:10%',40,20,'y'],
    ['display:flex;flex-direction:column;row-gap:calc(10% + 5px)',45,25,'y'],
    ['display:grid;grid-template-columns:20px;row-gap:10%',40,24,'y'],
    ['display:grid;grid-template-columns:20px;row-gap:calc(10% + 5px)',45,29.5,'y'],
    ['display:inline-flex;column-gap:10%',40,24,'x'],
    ['display:inline-flex;column-gap:calc(10% + 5px)',45,29.5,'x'],
    ['display:inline-grid;grid-template-columns:20px 20px;column-gap:10%',40,24,'x'],
  ];
  for(const [css,size,distance,axis] of cases) {
    const f=fixture(`<main id=box style="${css}">${items}</main>`);
    try{f.render();expect(f.box('box')[axis==='x'?'width':'height']).toBe(size);expect(f.box('b')[axis]-f.box('a')[axis]).toBeCloseTo(distance,7);}finally{f.close();}
  }
});

test('gap resize, clamping, grid auto-repeat and retained layout use the current basis',()=>{
  const f=fixture(`<main id=box style="display:grid;grid-template-columns:20px 20px;width:200px;height:100px;gap:calc(10% - 30px)">${items}</main>`);
  try {
    const engine=new LayoutEngine({measureText:s=>s.length*10});
    for(const width of [200,500,200]){f.e('box').style.width=width+'px';f.render(engine);expect(f.box('b').x-f.box('a').x).toBe(20+Math.max(0,width/10-30));}
    f.e('box').style.cssText='display:grid;width:100px;grid-template-columns:repeat(auto-fill,20px);gap:10%';f.render(engine);expect(f.box('b').x-f.box('a').x).toBe(30);
    f.e('box').style.cssText='display:grid;width:100px;min-height:100px;grid-template-columns:20px;gap:10%;align-content:start';f.render(engine);expect(f.box('box').height).toBe(100);expect(f.box('b').y-f.box('a').y).toBe(30);
  }finally{f.close();}
});

test('renderer paints percentage gaps and updates CSSOM aliases, pending rules and viewport sizes',async()=>{
  const {loadGraphics}=await import('../lib/renderer/page-renderer.js');
  const {RendererHost}=await import('../lib/renderer/host.js');
  const {CanvasKit:kit}=await loadGraphics(),host=new RendererHost({timeout:20000});let image;
  try {
    await host.start();await host.call('resize',200,100,1);
    await host.call('loadDocument',{url:'https://gap.test/',contentType:'text/html',source:'<!doctype html><style>body{margin:0;background:white}#box{display:flex;width:100%;column-gap:10%}i{display:block;width:20px;height:20px;flex:none;background:red}#b{background:blue}</style><main id=box><i id=a></i><i id=b></i></main>'});
    await host.call('whenLoaded');const run=code=>host.call('evaluate',code);
    for(const width of [200,300,200]) {
      await host.call('resize',width,100,1);
      const left=20+width/10;
      expect(await run(`document.getElementById('b').getBoundingClientRect().x`)).toBe(left);
      expect(await run(`(()=>{const s=getComputedStyle(document.getElementById('box'));return [s.columnGap,s.gridColumnGap,s.gap,s.gridGap]})()`)).toEqual(['10%','10%','normal 10%','normal 10%']);
      image?.delete();image=kit.MakeImageFromEncoded(Buffer.from(await host.call('screenshot',{format:'png'}),'base64'));
      const pixels=image.readPixels(0,0,{width,height:100,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB});
      const pixel=x=>[...pixels.subarray((5*width+x)*4,(5*width+x)*4+4)];
      expect(pixel(5)).toEqual([255,0,0,255]);expect(pixel(left-1)).toEqual([255,255,255,255]);expect(pixel(left+1)).toEqual([0,0,255,255]);
    }
    expect(await run(`(()=>{const sheet=new CSSStyleSheet();sheet.replaceSync('#box{--g:10% 20%;gap:var(--g)}');document.adoptedStyleSheets=[sheet];sheet.cssRules[0].style.gridColumnGap='15%';const s=getComputedStyle(document.getElementById('box'));return [s.rowGap,s.columnGap,document.getElementById('b').getBoundingClientRect().x]})()`)).toEqual(['10%','15%',50]);
    expect(await run(`(()=>{document.adoptedStyleSheets[0].cssRules[0].style.setProperty('--g','30% 40%');const s=getComputedStyle(document.getElementById('box'));return [s.rowGap,s.columnGap,document.getElementById('b').getBoundingClientRect().x]})()`)).toEqual(['30%','15%',50]);
  }finally{image?.delete();await host.close();}
},30000);


test('definite row gap percentages follow min/max content height without making auto flex height definite',()=>{
  for(const display of ['flex;flex-direction:column','flex;flex-direction:column-reverse','grid;grid-template-columns:20px;align-content:start']) {
    for(const [limits,height,distance] of [['height:100px;max-height:50px',50,25],['height:50px;min-height:100px',100,30],['height:10px;min-height:60px;max-height:40px',60,26],['height:80px;max-height:50px;box-sizing:border-box;padding:5px;border:5px solid',50,23]]) {
      const f=fixture(`<main id=box style="display:${display};row-gap:10%;${limits}">${items}</main>`);
      try {f.render();expect(f.box('box').height).toBe(height);expect(Math.abs(f.box('b').y-f.box('a').y)).toBe(distance);}finally{f.close();}
    }
  }
  const f=fixture(`<main id=box style="display:flex;flex-direction:column;min-height:100px;row-gap:10%">${items}</main>`);
  try {f.render();expect(f.box('b').y-f.box('a').y).toBe(20);}finally{f.close();}
});
