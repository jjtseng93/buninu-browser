import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine, parseDeclarations, supportsDeclaration} from '../lib/style/computed-style.js';
import {normalizeBoxShadow, computedBoxShadows} from '../lib/style/box-shadow-values.js';

const canonical = [
  ['none', 'none'], ['inset 1px 2px red', 'red 1px 2px inset'],
  ['-4px 4px 0 0 green', 'green -4px 4px 0px 0px'],
  ['inset 1px -2px, -3px 4px red', '1px -2px inset, red -3px 4px'],
  ['CURRENTCOLOR 0/**/2PX INSET', 'currentcolor 0px 2px inset'],
  ['#0080ff 0 0', 'rgb(0, 128, 255) 0px 0px'],
  ['rgba(0, 255, 0, 1) 0 0', 'rgb(0, 255, 0) 0px 0px'],
  ['1px 1px calc(-1px)', '1px 1px calc(-1px)'],
  ['1px 1px calc(1em - 2px)', '1px 1px calc(1em - 2px)'],
  ['calc(1in / 2) 1px', 'calc(48px) 1px'],
];
const invalid = ['auto','1 2','1px','1% 2%','1px calc(2px + 2%)','1px 2px 3px 4px 5px',
  'red 1px 2px blue','red','inset','4px red','red 4px','-4px red 4px',
  'red -4px 4px red','4px inset -4px','inset 4px -4px inset','4px -4px 0 inset 0',
  '4px -4px red 0','1px 1px -1px','1px 1px -1em','1px 1px -1px 0px',
  '1px 1px,',',1px 1px','none, 1px 2px','inherit 1px 2px','1px calc(1px+2px)',
  'calc(1px + 1) 1px','1px 2px !bad','var(foo)','var(--)'];

test('box-shadow grammar and canonical serialization are shared by CSSOM, supports and cascade', () => {
  const {window, document} = parseHTMLDocument('<div></div>');
  try {
    const style = document.querySelector('div').style;
    for (const [value, expected] of canonical) {
      style.boxShadow = value;
      expect(style.boxShadow).toBe(expected);
      expect(supportsDeclaration('box-shadow', value)).toBeTrue();
      expect(parseDeclarations(`box-shadow:${value}`).get('box-shadow').value).toBe(expected);
      expect(normalizeBoxShadow('box-shadow', expected)).toBe(expected);
    }
    for (const value of invalid) {
      style.setProperty('box-shadow', 'red 1px 2px', 'important');
      style.boxShadow = value;
      expect([style.boxShadow, style.getPropertyPriority('box-shadow')]).toEqual(['red 1px 2px','important']);
      expect(supportsDeclaration('box-shadow', value)).toBeFalse();
      expect(parseDeclarations(`box-shadow:1px 2px;box-shadow:${value}`).get('box-shadow').value).toBe('1px 2px');
    }
    style.cssText='BOX-SHADOW:inset 0 2px red;box-shadow:invalid';
    expect(style.boxShadow).toBe('red 0px 2px inset');
    expect(style.removeProperty('box-shadow')).toBe('red 0px 2px inset');
    expect(style.boxShadow).toBe('');
    for (const value of ['initial','inherit','unset','revert','revert-layer','VAR(--日本, 1px 2px)']) {
      style.boxShadow=value;expect(style.boxShadow).toBe(value);expect(supportsDeclaration('box-shadow',value)).toBeTrue();
    }
  } finally {window.happyDOM.close();}
});

test('box-shadow math clamps blur after calculation and resolves font/viewport lengths', () => {
  const resolve = value => ({'1em':20,'1rem':16,'1vw':8}[value] ?? NaN);
  expect(computedBoxShadows('currentcolor -1em -2rem calc(1em - 30px) -1vw',resolve)).toEqual([
    {x:-20,y:-32,blur:0,spread:-8,inset:false,color:null,currentColor:true},
  ]);
  expect(computedBoxShadows('1px 2px calc(infinity * 1px)',resolve)[0].blur).toBeGreaterThan(1e38);
  expect(computedBoxShadows('calc(NaN * 1px) 2px',resolve)[0].x).toBe(0);
  expect(computedBoxShadows('calc(1em / 1px) 2px',resolve)).toBeUndefined();
  // A caller without a length context must not synthesize a zero length.
  expect(computedBoxShadows('1cqw 2px',resolve)).toBeUndefined();
  expect(computedBoxShadows('none',resolve)).toBeNull();
});

test('box-shadow preserves cq small-viewport fallback when no query container exists', () => {
  const {window, document} = parseHTMLDocument('<div></div>');
  try {
    const element = document.querySelector('div'), engine = new StyleEngine();
    element.style.boxShadow = 'red 1cqw 2cqh 3cqi 4cqb, blue -1cqmin -2cqmax calc(1cqw - 20px)';
    const lengths = viewport => engine.compute(document, [], viewport).get(element).boxShadow
      .map(({x,y,blur,spread}) => [x,y,blur,spread]);
    expect(lengths({width:1000,height:600})).toEqual([[10,12,30,24],[-6,-20,0,0]]);
    expect(lengths({width:800,height:400})).toEqual([[8,8,24,16],[-4,-16,0,0]]);
  } finally {window.happyDOM.close();}
});

test('currentColor follows final color, remains live when inherited, and vars invalidate as unset', () => {
  const {window, document} = parseHTMLDocument('<main id=p><div id=a></div><div id=b></div><div id=c></div></main>');
  try {
    const [p,a,b,c]=['p','a','b','c'].map(id=>document.getElementById(id));
    p.style.cssText='box-shadow:1em 2em;color:red;font-size:20px';
    a.style.cssText='box-shadow:inherit;color:blue;font-size:10px';
    b.style.cssText='box-shadow:2px 3px;--bad:nope;box-shadow:var(--bad)';
    c.style.cssText='box-shadow:var(--missing, 1em 2em calc(-1em));font-size:30px;color:green';
    const read = () => new StyleEngine().compute(document);
    let styles = read();
    expect(styles.get(p).boxShadow[0]).toMatchObject({x:20,y:40,color:'rgba(255, 0, 0, 1)'});
    expect(styles.get(a).boxShadow[0]).toMatchObject({x:20,y:40,color:'rgba(0, 0, 255, 1)'});
    expect(styles.get(b).boxShadow).toBeNull();
    expect(styles.get(c).boxShadow[0]).toMatchObject({x:30,y:60,blur:0,color:'rgba(0, 128, 0, 1)'});
    p.style.fontSize='40px';a.style.color='purple';styles=read();
    expect(styles.get(a).boxShadow[0]).toMatchObject({x:40,y:80,color:'rgba(128, 0, 128, 1)'});
    a.style.cssText='box-shadow:1px 2px;all:initial';expect(read().get(a).boxShadow).toBeNull();
    a.style.cssText='all:initial;box-shadow:1px 2px';expect(read().get(a).boxShadow[0]).toMatchObject({x:1,y:2});
    a.removeAttribute('style');styles=new StyleEngine().compute(document,['#a{box-shadow:inset 2px 3px #f00;box-shadow:bad}']);
    expect(styles.get(a).boxShadow[0]).toMatchObject({x:2,y:3,color:'rgba(255, 0, 0, 1)',inset:true});
  } finally {window.happyDOM.close();}
});

test('actual CPU outer-shadow pixels and live computed style update through page CSSOM', async () => {
  const {loadGraphics} = await import('../lib/renderer/page-renderer.js');
  const {RendererHost} = await import('../lib/renderer/host.js');
  const {CanvasKit:kit}=await loadGraphics(),host=new RendererHost({timeout:20000});let image;
  try {
    await host.start();await host.call('resize',80,40,1);
    await host.call('loadDocument',{url:'https://shadow.test/',contentType:'text/html',source:`<!doctype html><style>
      body{margin:0;background:white}#box{position:absolute;left:10px;top:10px;width:10px;height:10px;background:white;box-shadow:25cqw 0 0 0;color:blue}
      </style><div id=box></div>`});
    await host.call('whenLoaded');
    const read=()=>host.call('evaluate',"getComputedStyle(document.getElementById('box')).boxShadow");
    const pixel=async(x,y)=>{
      image?.delete();image=kit.MakeImageFromEncoded(Buffer.from(await host.call('screenshot',{format:'png'}),'base64'));
      return [...image.readPixels(x,y,{width:1,height:1,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB})];
    };
    expect(await read()).toBe('rgb(0, 0, 255) 20px 0px 0px 0px');
    expect(await pixel(35,15)).toEqual([0,0,255,255]);expect(await pixel(15,15)).toEqual([255,255,255,255]);
    await host.call('evaluate',"document.getElementById('box').style.color='red'");
    expect(await read()).toBe('rgb(255, 0, 0) 20px 0px 0px 0px');expect(await pixel(35,15)).toEqual([255,0,0,255]);
    await host.call('evaluate',"document.getElementById('box').style.boxShadow='currentcolor 30px 0 calc(-5px)'");
    expect(await read()).toBe('rgb(255, 0, 0) 30px 0px 0px 0px');
    expect(await pixel(35,15)).toEqual([255,255,255,255]);expect(await pixel(45,15)).toEqual([255,0,0,255]);
    await host.call('evaluate',"document.getElementById('box').style.boxShadow='none'");
    expect(await read()).toBe('none');expect(await pixel(45,15)).toEqual([255,255,255,255]);
    // Inset remains parsed/computed, but the existing painter skips inner shadows.
    await host.call('evaluate',"document.getElementById('box').style.boxShadow='red 1px 2px 3px 4px inset'");
    expect(await read()).toBe('rgb(255, 0, 0) 1px 2px 3px 4px inset');
  } finally {image?.delete();await host.close();}
},30000);
