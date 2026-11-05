import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine,parseDeclarations,supportsDeclaration} from '../lib/style/computed-style.js';
import {normalizeSizingValue,computedSizingValue} from '../lib/style/sizing-values.js';
import {RenderTreeBuilder} from '../lib/render-tree/index.js';
import {LayoutEngine} from '../lib/layout/text-layout.js';

const names=['width','height','min-width','min-height','max-width','max-height','inline-size','block-size','min-inline-size','min-block-size','max-inline-size','max-block-size'];

test('sizing declarations reject invalid dimensions without replacing CSSOM values or priority',()=>{
  const {window,document}=parseHTMLDocument('<div></div>');
  try {
    const style=document.querySelector('div').style;
    for(const name of names) {
      const initial=name.startsWith('max-')?'none':'auto';
      for(const [input,expected] of [['0','0px'],['.5PX','0.5px'],['1e2%','100%'],['10px/**/','10px'],['calc(1in + 2px)','calc(98px)'],['calc(50% - 2em)','calc(50% - 2em)'],[initial.toUpperCase(),initial]]) {
        style.setProperty(name,input);
        expect(style.getPropertyValue(name)).toBe(expected);
        expect(parseDeclarations(`${name}:${input}`).get(name)?.value).toBe(expected);
        expect(supportsDeclaration(name,input)).toBeTrue();
      }
      for(const input of ['-1px','-2%','3','1.','1px 2%','10px border-box','available','complex','"2px"','calc(1px + 2)','calc(1 / 2px)','calc(1px+2px)','var(foo)','var(--)','fit-content(-2px)',initial==='auto'?'none':'auto']) {
        style.setProperty(name,'40px','important');style.setProperty(name,input);
        expect(style.getPropertyValue(name)).toBe('40px');
        expect(style.getPropertyPriority(name)).toBe('important');
        expect(parseDeclarations(`${name}:40px;${name}:${input}`).get(name)?.value).toBe('40px');
        expect(supportsDeclaration(name,input)).toBeFalse();
      }
      for(const input of ['initial','inherit','unset','revert','revert-layer','var(--日本)','VAR(--x)','env(unknown, 20px)']) {
        style.setProperty(name,input);expect(style.getPropertyValue(name)).toBe(input);
      }
      style.setProperty(name,'40px');expect(style.removeProperty(name)).toBe('40px');
      expect(style.getPropertyValue(name)).toBe('');
      // Valid specified syntax remains available to CSSOM without claiming
      // intrinsic sizing/font metrics which layout cannot implement yet.
      for(const input of ['1ex','1cap','1ic','1lh','1rch','fit-content(20%)','min-content']) {
        style.setProperty(name,input);expect(style.getPropertyValue(name)).toBe(input);
        expect(supportsDeclaration(name,input)).toBeFalse();
      }
    }
  } finally {window.happyDOM.close();}
});

test('sizing computes math ranges and pending substitutions without reviving earlier declarations',()=>{
  const {window,document}=parseHTMLDocument('<main id=p><div id=a></div><div id=b></div><div id=c></div></main>');
  try {
    const p=document.getElementById('p'),a=document.getElementById('a'),b=document.getElementById('b'),c=document.getElementById('c');
    p.style.cssText='width:200px;height:120px;min-width:30px;max-height:90px;font-size:20px';
    a.style.cssText='width:80px;width:calc(-2px);height:calc(2em / 1em * 3px);min-width:calc(-20px);max-height:calc(2px - .5em)';
    b.style.cssText='width:80px;width:VAR(--日本);min-width:70px;min-width:var(--日本);max-height:60px;max-height:var(--日本);--日本:-2%';
    c.style.cssText='width:inherit;height:inherit;min-width:inherit;max-height:inherit';
    let styles=new StyleEngine().compute(document),values=e=>{const s=styles.get(e);return [s.width,s.height,s.minWidth,s.maxHeight]};
    expect(values(a)).toEqual([0,6,0,0]);
    expect(values(b)).toEqual(['auto','auto','auto','none']);
    expect(values(c)).toEqual([200,120,30,90]);
    a.style.cssText='--日本:23px;width:VAR(--日本);height:var(--missing, 7px);min-width:80px;min-width:auto';
    styles=new StyleEngine().compute(document);expect(values(a)).toEqual([23,7,'auto','none']);
    a.style.cssText='inline-size:33px;block-size:44px;min-inline-size:12px;max-block-size:55px';
    styles=new StyleEngine().compute(document);expect(values(a)).toEqual([33,44,12,55]);
    a.style.cssText+=';all:unset';styles=new StyleEngine().compute(document);expect(values(a)).toEqual(['auto','auto','auto','none']);
    a.style.cssText='width:calc(NaN * 1px);height:calc(infinity * 1px)';styles=new StyleEngine().compute(document);
    expect(styles.get(a).width).toBe(0);expect(Number.isFinite(styles.get(a).height)).toBeTrue();
    const invalid=normalizeSizingValue('width','calc(1px + 2)');expect(invalid).toBeNull();
    expect(computedSizingValue('1ex',()=>NaN)).toBeNaN();
    // This dimensionally valid advanced percentage division has no used-value
    // evaluator yet; CSS.supports must not advertise it just because it parses.
    expect(normalizeSizingValue('width','calc(10% / 2px * 3px)')).not.toBeNull();
    expect(supportsDeclaration('width','calc(10% / 2px * 3px)')).toBeFalse();
  } finally {window.happyDOM.close();}
});

test('percentage math clamps at used size across block, flex, grid and canvas without changing offsets',()=>{
  const {window,document}=parseHTMLDocument(`<body style="margin:0"><main style="position:relative;height:200px">
    <div id=block style="width:calc(10% - 30px);height:calc(10% - 30px)"></div>
    <div id=clamped style="width:100px;max-width:calc(10% - 30px);height:100px;max-height:calc(10% - 30px)"></div>
    <div id=minimum style="width:0;height:0;min-width:calc(50% - 30px);min-height:calc(50% - 30px)"></div>
    <div style="display:flex"><div id=flex style="width:calc(10% - 30px);height:10px;min-width:0;flex-shrink:0"></div><div id=next style="width:20px;height:10px"></div></div>
    <div style="display:grid;grid-template-columns:100%"><div id=grid style="width:calc(10% - 30px);height:10px;min-width:0"></div></div>
    <canvas id=canvas width=40 height=20 style="display:block;width:calc(10% - 30px);height:10px"></canvas>
    <div id=negative style="position:absolute;left:calc(10% - 30px);top:0;width:10px;height:10px;margin-left:-5px"></div>
  </main></body>`);
  try {
    const tree=new RenderTreeBuilder().build(document,new StyleEngine().compute(document)),engine=new LayoutEngine();
    for(const width of [200,400,200]) {
      const layout=engine.layout(tree,{x:0,y:0,width,measureText:text=>text.length*10,fontMetrics:()=>({ascent:8,height:10})});
      const box=id=>layout.boxes.find(box=>tree.nodesById.get(box.nodeId)?.domNode?.id===id),used=Math.max(0,width*.1-30);
      for(const id of ['block','clamped','flex','grid','canvas'])expect(box(id).width).toBe(used);
      expect(box('block').height).toBe(0);expect(box('clamped').height).toBe(0);
      expect([box('minimum').width,box('minimum').height]).toEqual([width*.5-30,70]);
      expect(box('next').x).toBe(used);
      expect(box('negative').x).toBe(width*.1-35);
    }
    const huge=document.createElement('div');huge.id='huge';
    huge.style.cssText='width:calc(1e308% * 1e308 - 1px);height:1px';document.body.appendChild(huge);
    const overflowTree=new RenderTreeBuilder().build(document,new StyleEngine().compute(document));
    const overflowLayout=new LayoutEngine().layout(overflowTree,{x:0,y:0,width:200});
    expect(overflowLayout.boxes.find(box=>overflowTree.nodesById.get(box.nodeId)?.domNode===huge).width).toBe(3.4028234663852886e38);
  } finally {window.happyDOM.close();}
});
