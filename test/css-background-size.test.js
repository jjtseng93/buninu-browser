import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine,parseDeclarations,supportsDeclaration} from '../lib/style/computed-style.js';
import {normalizeBackgroundSize} from '../lib/style/background-size-values.js';
import {RenderTreeBuilder} from '../lib/render-tree/index.js';
import {layoutText} from '../lib/layout/text-layout.js';
import {buildDisplayList} from '../lib/paint/display-list.js';

function fixture() {
  const parsed=parseHTMLDocument('<body style="margin:0"><main style="font-size:40px"><div id=box style="width:100px;height:60px"></div></main></body>');
  const e=parsed.document.getElementById('box');
  const read=()=>new StyleEngine().compute(parsed.document);
  const tiles=()=>{
    const tree=new RenderTreeBuilder().build(parsed.document,read());
    return buildDisplayList(layoutText(tree,{x:0,y:0,width:200}),tree,null,()=>({width:40,height:20,image:{}})).items
      .filter(item=>item.op==='drawBackgroundImage'&&tree.nodesById.get(item.nodeId)?.domNode===e);
  };
  return {...parsed,e,read,tiles};
}

test('background size CSSOM, cascade and supports share list grammar and invalid retention',()=>{
  const f=fixture(),s=f.e.style;
  try {
    for(const [input,expected] of [['1px','1px auto'],['auto auto','auto'],['AUTO/**/4%','auto 4%'],['0','0px auto'],['1px,2% 3%,contain','1px auto, 2% 3%, contain'],['calc(1in / 2)','calc(48px) auto']]) {
      s.backgroundSize=input;expect(s.backgroundSize).toBe(expected);expect(normalizeBackgroundSize('background-size',input)).toBe(expected);expect(supportsDeclaration('background-size',input)).toBeTrue();
    }
    for(const value of ['-1px','2% -3%','1px 2px 3px','auto cover','cover auto','',',auto','auto,','auto,,auto','1','calc(1px + 1)','calc(1px+2px)','none','"auto"']) {
      s.setProperty('background-size','20px 30px','important');s.backgroundSize=value;
      // Empty CSSOM values intentionally remove a declaration.
      if(value)expect([s.backgroundSize,s.getPropertyPriority('background-size')]).toEqual(['20px 30px','important']);
      else expect(s.backgroundSize).toBe('');
      expect(supportsDeclaration('background-size',value)).toBeFalse();
      expect(parseDeclarations(`background-size:20px 30px;background-size:${value}`)).toEqual(parseDeclarations('background-size:20px 30px'));
    }
    for(const value of ['initial','inherit','unset','revert','revert-layer','VAR(--日本)','var(--x, 10px, 20px)']) {
      s.backgroundSize=value;expect(s.backgroundSize).toBe(value);expect(supportsDeclaration('background-size',value)).toBeTrue();
    }
    s.cssText='BACKGROUND-SIZE: 10px, auto auto';expect(s.backgroundSize).toBe('10px auto, auto');
    const text=s.cssText;s.cssText=text;expect(s.cssText).toBe(text);
    s.removeProperty('background-size');expect(s.backgroundSize).toBe('');
  } finally {f.window.happyDOM.close();}
});

test('background sizes compute independently of image count and respect substitution, inheritance and reset',()=>{
  const f=fixture(),s=f.e.style,read=()=>f.read().get(f.e).backgroundSizeValues;
  try {
    s.backgroundSize='calc(10px + .5em) calc(10px - .5em)';expect(read()).toEqual([[30,0]]);
    s.backgroundSize='auto,100%,contain';expect(read()).toEqual([['auto','auto'],[{unit:'%',value:100},'auto'],'contain']);
    s.cssText='--日本:10px,20% 30%;background-size:VAR(--日本)';expect(read()).toEqual([[10,'auto'],[{unit:'%',value:20},{unit:'%',value:30}]]);
    s.setProperty('--日本','-3px');expect(read()).toEqual([['auto','auto']]);
    s.cssText='background-size:40px;background-size:var(--missing, 1em 2em)';expect(read()).toEqual([[40,80]]);
    s.cssText='background-size:40px;background-size:var(--missing)';expect(read()).toEqual([['auto','auto']]);
    f.e.parentElement.style.backgroundSize='10px 20px';s.backgroundSize='inherit';expect(read()).toEqual([[10,20]]);
    s.cssText='background-size:40px;all:initial';expect(read()).toEqual([['auto','auto']]);
    f.e.setAttribute('style','background:none 0% 0% / 10px 20px');expect(read()).toEqual([[10,20]]);
    f.e.setAttribute('style','background-size:40px;background:red');expect(read()).toEqual([['auto','auto']]);
    f.e.setAttribute('style','background:red;background:url(x) 0 0 / -3px');
    expect(f.read().get(f.e).backgroundColor).toBe('rgba(255, 0, 0, 1)');
    f.e.removeAttribute('style');
    expect(new StyleEngine().compute(f.document,['#box{background:red;background:url(x) 0 0 / 2px 3px 4px}']).get(f.e).backgroundColor).toBe('rgba(255, 0, 0, 1)');
    f.e.removeAttribute('style');
    const styles=new StyleEngine().compute(f.document,['#box {background-size: 10px; background-size:-5px} @supports(background-size:VAR(--日本)){#box{--日本:calc(50% - 5px);background-size:VAR(--日本)}}']);
    expect(styles.get(f.e).backgroundSizeValues[0][0]).toMatchObject({unit:'math',kind:'calc',px:-5,percent:50,nonNegative:true});
  } finally {f.window.happyDOM.close();}
});

test('background image tile geometry uses positioning box, intrinsic ratio and deferred nonnegative math',()=>{
  const f=fixture(),s=f.e.style;
  try {
    s.cssText='width:100px;height:60px;padding:10px;border:2px solid black;background-image:url(a.png);background-repeat:no-repeat;background-size:calc(50% - 10px) auto';
    expect(f.tiles()[0].tile).toEqual({x:2,y:2,width:50,height:25});
    s.backgroundSize='auto 50%';expect(f.tiles()[0].tile).toMatchObject({width:80,height:40});
    s.backgroundSize='contain';expect(f.tiles()[0].tile).toMatchObject({width:120,height:60});
    s.backgroundSize='cover';expect(f.tiles()[0].tile).toMatchObject({width:160,height:80});
    s.backgroundSize='calc(20% - 50px) 10px';expect(f.tiles()).toEqual([]);
    s.backgroundSize='min(80%, 70px) clamp(10px, 50%, 100px)';expect(f.tiles()[0].tile).toMatchObject({width:70,height:40});
    s.backgroundSize='2em auto';expect(f.tiles()[0].tile).toMatchObject({width:80,height:40});
    f.e.parentElement.style.fontSize='20px';expect(f.tiles()[0].tile).toMatchObject({width:40,height:20});
    s.backgroundImage='url(a.png),url(b.png),url(c.png)';s.backgroundSize='10px 20px,30px 40px';
    expect(f.tiles().map(item=>[item.tile.width,item.tile.height])).toEqual([[10,20],[30,40],[10,20]]);
    s.backgroundSize='20px auto';f.e.setAttribute('style',f.e.getAttribute('style')+';background-position:right 5px bottom 10px');
    expect(f.tiles()[0].tile).toEqual({x:97,y:62,width:20,height:10});
    s.backgroundRepeat='repeat-x';expect(f.tiles()[0]).toMatchObject({repeatX:true,repeatY:false});
  } finally {f.window.happyDOM.close();}
});

test('software background image paint follows CSSOM sizing, zero clamps and updates without layout',async()=>{
  const {loadGraphics}=await import('../lib/renderer/page-renderer.js');
  const {RendererHost}=await import('../lib/renderer/host.js');
  const {CanvasKit:kit}=await loadGraphics(),host=new RendererHost({timeout:20000});let image,surface;
  try {
    surface=kit.MakeSurface(40,20);surface.getCanvas().clear(kit.Color(255,0,0,1));const snap=surface.makeImageSnapshot();
    const url='data:image/png;base64,'+Buffer.from(snap.encodeToBytes()).toString('base64');snap.delete();surface.delete();surface=null;
    await host.start();await host.call('resize',80,40,1);
    await host.call('loadDocument',{url:'https://background-size.test/',contentType:'text/html',source:`<!doctype html><style>body{margin:0;background:white}#box{font-size:20px;width:80px;height:40px;background-image:url(${url});background-repeat:no-repeat;background-size:calc(10px + 1em) auto}</style><div id=box></div>`});
    await host.call('whenLoaded');
    const pixel=async(x,y)=>{
      image?.delete();image=kit.MakeImageFromEncoded(Buffer.from(await host.call('screenshot',{format:'png'}),'base64'));
      const p=image.readPixels(0,0,{width:80,height:40,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB});
      return [...p.subarray((y*80+x)*4,(y*80+x)*4+4)];
    };
    expect(await host.call('evaluate',`getComputedStyle(document.getElementById('box')).backgroundSize`)).toBe('30px auto');
    expect(await pixel(25,10)).toEqual([255,0,0,255]);expect(await pixel(35,10)).toEqual([255,255,255,255]);
    await host.call('evaluate',`document.getElementById('box').style.backgroundSize='50% auto'`);
    expect(await pixel(35,10)).toEqual([255,0,0,255]);expect(await pixel(45,10)).toEqual([255,255,255,255]);
    await host.call('evaluate',`document.getElementById('box').style.backgroundSize='calc(10% - 20px) auto'`);
    expect(await host.call('evaluate',`getComputedStyle(document.getElementById('box')).backgroundSize`)).toBe('calc(10% - 20px) auto');
    expect(await pixel(2,2)).toEqual([255,255,255,255]);
    await host.call('evaluate',`document.getElementById('box').style.backgroundSize='min(50%, 30px) clamp(5px, 20%, 10px)'`);
    expect(await host.call('evaluate',`getComputedStyle(document.getElementById('box')).backgroundSize`)).toBe('min(50%, 30px) clamp(5px, 20%, 10px)');
    await host.call('evaluate',`document.getElementById('box').style.cssText='--日本:20px 10px;background-size:VAR(--日本)'`);
    expect(await pixel(15,5)).toEqual([255,0,0,255]);expect(await pixel(25,5)).toEqual([255,255,255,255]);
  } finally {image?.delete();surface?.delete();await host.close();}
});
