import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine,parseDeclarations,supportsDeclaration} from '../lib/style/computed-style.js';
import {normalizeBorderRadius} from '../lib/style/border-radius-values.js';
import {resolveCornerRadii,radiusPairs} from '../lib/paint/rounded-rect.js';
import {RenderTreeBuilder} from '../lib/render-tree/index.js';
import {layoutText} from '../lib/layout/text-layout.js';
import {buildDisplayList} from '../lib/paint/display-list.js';
import {parseCSSOMRules,renderStyleSheet} from '../lib/renderer/stylesheet-parser.js';

const fields=['TopLeft','TopRight','BottomRight','BottomLeft'].map(corner=>`border${corner}Radius`);
const corners=style=>fields.map(field=>style[field]);

test('radius shared grammar rejects invalid values without replacing valid CSSOM/cascade declarations',()=>{
  const {window,document}=parseHTMLDocument('<div></div>');
  try {
    const style=document.querySelector('div').style;
    for(const [name,valid,invalid] of [
      ['border-radius','1px 2% 3px 4% / 5em',['-1px','auto','none','1px 2px 3px 4px 5px','1px /','/ 1px','1px / 2px / 3px','1px / -2px','1px,2px','1px 2px 3px 4','"1px"','calc(1px + 1)']],
      ['border-top-left-radius','10px 20%',['-1px','1px 2px 3px','1px / 2px','1px -2%','calc(1px+2px)']],
    ]) {
      for(const value of invalid) {
        style.setProperty(name,valid,'important');const before=style.getPropertyValue(name);style.setProperty(name,value);
        expect([style.getPropertyValue(name),style.getPropertyPriority(name)]).toEqual([before,'important']);
        expect(supportsDeclaration(name,value)).toBeFalse();
        expect(parseDeclarations(`${name}:${valid};${name}:${value}`)).toEqual(parseDeclarations(`${name}:${valid}`));
      }
      expect(supportsDeclaration(name,valid)).toBeTrue();
    }
    for(const [input,expected] of [['0','0px'],['1px/**/2% / 3px/**/4%','1px 2% / 3px 4%'],['1px 1px 1px 1px / 1px 1px 2% 1px','1px / 1px 1px 2%'],['10PX / 10px','10px'],['calc(1in / 2)','calc(48px)']]) {
      style.borderRadius=input;expect(style.borderRadius).toBe(expected);expect(normalizeBorderRadius('border-radius',input)).toBe(expected);
    }
    for(const value of ['initial','inherit','unset','revert','revert-layer','VAR(--日本)','var(--x, 10px / 20px)']) {
      style.borderRadius=value;expect(style.borderRadius).toBe(value);expect(supportsDeclaration('border-radius',value)).toBeTrue();
    }
  } finally {window.happyDOM.close();}
});

test('ellipse shorthand serialization preserves individual corner values and priority',()=>{
  const {window,document}=parseHTMLDocument('<div></div>');
  try {
    const e=document.querySelector('div'),s=e.style;
    s.cssText='BORDER-RADIUS:1px 2px 3px 4px / 5px 6px 7px 8px';
    expect(fields.map(name=>s[name])).toEqual(['1px 5px','2px 6px','3px 7px','4px 8px']);
    s.borderTopLeftRadius='9px 10px';expect(s.borderRadius).toBe('9px 2px 3px 4px / 10px 6px 7px 8px');
    const text=s.cssText;s.cssText=text;expect(s.cssText).toBe(text);
    s.setProperty('border-top-left-radius','9px 10px','important');expect(s.borderRadius).toBe('');
    s.cssText='border-top-left-radius:3px!important;border-radius:10px / 20px';
    expect(fields.map(name=>s[name])).toEqual(['3px','10px 20px','10px 20px','10px 20px']);
    expect(s.getPropertyPriority('border-top-left-radius')).toBe('important');
    s.removeProperty('border-top-left-radius');expect(s.borderRadius).toBe('');expect(s.borderTopRightRadius).toBe('10px 20px');
    s.borderRadius='inherit';expect(fields.map(name=>s[name])).toEqual(Array(4).fill('inherit'));
    s.borderBottomRightRadius='10px';expect(s.borderRadius).toBe('');
    s.removeProperty('border-radius');expect(fields.map(name=>s[name])).toEqual(Array(4).fill(''));
    // Radius uses the same source-order domain as pending borders/overflow.
    // Reading or round-tripping cssText must not reorder across all.
    s.cssText='--b:2px solid red;--o:auto hidden;border:VAR(--b);border-left-width:5px;overflow:var(--o);overflow-x:scroll;border-radius:10px / 20px;all:initial;border-top-right-radius:3px 4px';
    for(let i=0;i<2;i++) {
      const current=new StyleEngine().compute(document).get(e);
      expect(corners(current)).toEqual([[0,0],[3,4],[0,0],[0,0]]);
      expect(current.borderWidths).toEqual([0,0,0,0]);expect([current.overflowValueX,current.overflowValueY]).toEqual(['visible','visible']);
      s.cssText=s.cssText;
    }
  } finally {window.happyDOM.close();}
});

test('radius computation clamps math after substitution and preserves deferred percentages',()=>{
  const {window,document}=parseHTMLDocument('<main id=p><div id=a></div><div id=b></div><div id=c></div></main>');
  try {
    const [p,a,b,c]=['p','a','b','c'].map(id=>document.getElementById(id));
    p.style.cssText='font-size:40px;border-radius:2px / 3px';
    a.style.cssText='border-radius:calc(-.5em + 10px) 20% / calc(.5em + 10px) 40%';
    b.style.cssText='border-radius:8px;--bad:-10px;border-radius:VAR(--bad)';
    c.style.cssText='border-radius:inherit';
    let styles=new StyleEngine().compute(document);
    expect(corners(styles.get(a))).toEqual([[0,30],[{unit:'%',value:20},{unit:'%',value:40}],[0,30],[{unit:'%',value:20},{unit:'%',value:40}]]);
    expect(corners(styles.get(b))).toEqual(Array(4).fill([0,0]));expect(corners(styles.get(c))).toEqual(Array(4).fill([2,3]));
    a.style.cssText='--日本:20% / 30%;border-radius:VAR(--日本)';
    expect(corners(new StyleEngine().compute(document).get(a))).toEqual(Array(4).fill([{unit:'%',value:20},{unit:'%',value:30}]));
    a.style.cssText='border-radius:var(--missing, 1em / 2em)';
    expect(corners(new StyleEngine().compute(document).get(a))).toEqual(Array(4).fill([40,80]));
    a.style.cssText='border-radius:5px;all:initial';expect(corners(new StyleEngine().compute(document).get(a))).toEqual(Array(4).fill([0,0]));
    a.removeAttribute('style');styles=new StyleEngine().compute(document,['#a{--r:10px / 20px;border-radius:VAR(--r);border-top-left-radius:7px!important}']);
    expect(corners(styles.get(a))).toEqual([[7,7],[10,20],[10,20],[10,20]]);
    a.style.borderRadius='calc(20% - 30px) / calc(10% + 2px)';
    const current=new StyleEngine().compute(document).get(a);
    expect(radiusPairs(resolveCornerRadii(current,{width:100,height:100}))).toEqual(Array(4).fill([0,12]));
    expect(radiusPairs(resolveCornerRadii(current,{width:200,height:200}))).toEqual(Array(4).fill([10,22]));
    a.style.cssText='direction:rtl;--r:10px 20px;border-start-start-radius:VAR(--r)';
    expect(supportsDeclaration('border-start-start-radius','VAR(--r)')).toBeTrue();
    expect(corners(new StyleEngine().compute(document).get(a))).toEqual([[0,0],[10,20],[0,0],[0,0]]);
    expect(supportsDeclaration('border-middle-radius','var(--r)')).toBeFalse();
  } finally {window.happyDOM.close();}
});

test('pending ellipse shorthands share per-corner metadata, priority and sheet mutation handling',()=>{
  const {window,document}=parseHTMLDocument('<div id=box></div>');
  try {
    const box=document.getElementById('box'),s=box.style;
    const read=(sheets=[])=>new StyleEngine().compute(document,sheets).get(box);
    s.cssText='--r:10px / 20px;border-radius:4px;border-radius:VAR(--r);border-top-left-radius:2px';
    expect(s.borderRadius).toBe('');expect(s.borderTopRightRadius).toBe('');
    expect(corners(read())).toEqual([[2,2],[10,20],[10,20],[10,20]]);
    s.removeProperty('border-top-right-radius');expect(corners(read())).toEqual([[2,2],[0,0],[10,20],[10,20]]);
    s.setProperty('--r','30px / 40px');expect(corners(read())).toEqual([[2,2],[0,0],[30,40],[30,40]]);
    s.cssText='--r:10px / 20px;border-radius:VAR(--r)!important;border-top-left-radius:2px';
    expect(s.borderRadius).toBe('VAR(--r)');expect(s.borderTopLeftRadius).toBe('');expect(corners(read())).toEqual(Array(4).fill([10,20]));
    s.borderTopLeftRadius='2px';expect(s.borderRadius).toBe('');expect(corners(read())).toEqual([[2,2],[10,20],[10,20],[10,20]]);
    s.setProperty('--r','broken');expect(corners(read())).toEqual([[2,2],[0,0],[0,0],[0,0]]);
    box.removeAttribute('style');
    const source='--a:10px / 20px;--b:30px / 40px;border-radius:var(--a);border-top-left-radius:2px';
    const rules=parseCSSOMRules(window,`#box{${source}}`,null),rule=rules[0];
    const sheet=()=>[renderStyleSheet(rules)];
    expect(corners(read(sheet()))).toEqual([[2,2],[10,20],[10,20],[10,20]]);
    rule.style.cssText=source.replace('var(--a)','var(--b)');
    expect(corners(read(sheet()))).toEqual([[2,2],[30,40],[30,40],[30,40]]);
    rule.style.removeProperty('border-bottom-left-radius');expect(corners(read(sheet()))).toEqual([[2,2],[30,40],[30,40],[0,0]]);
    rule.style.all='initial';expect(corners(read(sheet()))).toEqual(Array(4).fill([0,0]));
  } finally {window.happyDOM.close();}
});

test('CSSOM ellipse radii reach actual display-list geometry and overlap reduction',()=>{
  const {window,document}=parseHTMLDocument('<body style="margin:0"><div id=box style="width:100px;height:60px;background:red"></div></body>');
  try {
    const box=document.getElementById('box');box.style.borderRadius='20% 10px 0 30px / 10px 20px 0 30px';
    const tree=new RenderTreeBuilder().build(document,new StyleEngine().compute(document)),layout=layoutText(tree,{x:0,y:0,width:200});
    const item=buildDisplayList(layout,tree).items.find(item=>item.op==='fillRect'&&tree.nodesById.get(item.nodeId)?.domNode===box);
    expect(item.rect).toMatchObject({width:100,height:60});expect(radiusPairs(item.radii)).toEqual([[20,10],[10,20],[0,0],[30,30]]);
    box.style.borderRadius='80% / 20px';
    expect(radiusPairs(resolveCornerRadii(new StyleEngine().compute(document).get(box),item.rect))).toEqual(Array(4).fill([50,12.5]));
  } finally {window.happyDOM.close();}
});

test('software-painted CSSOM elliptical corners remain clipped and update with radius changes',async()=>{
  const {loadGraphics}=await import('../lib/renderer/page-renderer.js');
  const {RendererHost}=await import('../lib/renderer/host.js');
  const {CanvasKit:kit}=await loadGraphics(),host=new RendererHost({timeout:20000});let image;
  try {
    await host.start();await host.call('resize',80,40,1);
    await host.call('loadDocument',{url:'https://radius.test/',contentType:'text/html',source:'<!doctype html><style>body{margin:0;background:white}#box{width:80px;height:40px;background:red}</style><div id=box></div><script>document.getElementById("box").style.borderRadius="40px / 10px"</script>'});
    await host.call('whenLoaded');
    expect(await host.call('evaluate',`getComputedStyle(document.getElementById('box')).borderRadius`)).toBe('40px / 10px');
    image=kit.MakeImageFromEncoded(Buffer.from(await host.call('screenshot',{format:'png'}),'base64'));
    const pixels=image.readPixels(0,0,{width:80,height:40,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB});
    const at=(x,y)=>[...pixels.subarray((y*80+x)*4,(y*80+x)*4+4)];
    expect(at(2,2)).toEqual([255,255,255,255]);expect(at(40,2)).toEqual([255,0,0,255]);
    expect(at(2,12)).toEqual([255,0,0,255]);expect(at(2,37)).toEqual([255,255,255,255]);
    image.delete();image=null;
    await host.call('evaluate',`document.getElementById('box').style.cssText='border-radius:40px / 10px;all:initial;display:block;width:80px;height:40px;background:red'`);
    expect(await host.call('evaluate',`getComputedStyle(document.getElementById('box')).borderRadius`)).toBe('0px');
    image=kit.MakeImageFromEncoded(Buffer.from(await host.call('screenshot',{format:'png'}),'base64'));
    const updated=image.readPixels(0,0,{width:80,height:40,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB});
    expect([...updated.subarray((2*80+2)*4,(2*80+2)*4+4)]).toEqual([255,0,0,255]);
    expect(await host.call('evaluate',`(()=>{const e=document.getElementById('box');e.style.cssText='--r:40px / 10px;width:80px;height:40px;background:red;border-radius:VAR(--r);border-top-left-radius:0px';return [e.style.borderRadius,e.style.borderTopRightRadius,getComputedStyle(e).borderTopLeftRadius,getComputedStyle(e).borderTopRightRadius];})()`)).toEqual(['','','0px','40px 10px']);
    image.delete();image=null;
    image=kit.MakeImageFromEncoded(Buffer.from(await host.call('screenshot',{format:'png'}),'base64'));
    const partial=image.readPixels(0,0,{width:80,height:40,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB});
    expect([...partial.subarray((2*80+2)*4,(2*80+2)*4+4)]).toEqual([255,0,0,255]);
    expect([...partial.subarray((37*80+2)*4,(37*80+2)*4+4)]).toEqual([255,255,255,255]);
  } finally {image?.delete();await host.close();}
});
