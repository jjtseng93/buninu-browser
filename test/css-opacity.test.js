import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {normalizeOpacity, computedOpacity} from '../lib/style/opacity-values.js';
import {StyleEngine, parseDeclarations, supportsDeclaration} from '../lib/style/computed-style.js';
import {RenderTreeBuilder} from '../lib/render-tree/index.js';
import {layoutText} from '../lib/layout/text-layout.js';
import {buildDisplayList} from '../lib/paint/display-list.js';

test('opacity shares number/percentage validation across CSSOM, declarations and supports', () => {
  const {window, document} = parseHTMLDocument('<div></div>');
  try {
    const style = document.querySelector('div').style;
    for (const [input, expected] of [['-2','-2'],['3','3'],['50%','0.5'],['-100%','-1'],['300%','3'],['5e-1','0.5'],['.5/**/','0.5'],['calc(25% * 2)','calc(50%)'],['min(0.8, 0.3)','calc(0.3)'],['clamp(50%, 80%, 70%)','calc(70%)']]) {
      style.opacity = input;
      expect(style.opacity).toBe(expected);
      expect(supportsDeclaration('opacity', input)).toBeTrue();
      expect(parseDeclarations(`opacity:${input}`).get('opacity').value).toBe(expected);
    }
    for (const input of ['auto','10px','0 1','1.','0xff','"0.5"','calc(1+2)','calc(0.5 + 50%)','min(1, 50%)','var(foo)','var(--)']) {
      style.opacity = '.25'; style.opacity = input;
      expect(style.opacity).toBe('0.25');
      expect(supportsDeclaration('opacity', input)).toBeFalse();
      expect(parseDeclarations(`opacity:.25;opacity:${input}`).get('opacity').value).toBe('0.25');
    }
    style.setProperty('opacity', '25%', 'important');
    style.setProperty('opacity', 'invalid');
    expect([style.opacity, style.getPropertyPriority('opacity')]).toEqual(['0.25', 'important']);
    expect(style.removeProperty('opacity')).toBe('0.25');
    expect(style.opacity).toBe('');
    style.cssText = 'OPACITY:50%;opacity:bad';
    expect(style.opacity).toBe('0.5');
    for (const value of ['initial','inherit','unset','revert','revert-layer','var(--alpha, 50%)']) expect(supportsDeclaration('opacity',value)).toBeTrue();
  } finally {window.happyDOM.close();}
});

test('opacity clamps only after typed numeric calculations and handles nonfinite math', () => {
  for (const [value, expected] of [['-2',0],['3',1],['50%',.5],['calc(-50% - 50%)',0],['calc(100% + 100%)',1],['calc(0.25 * 2)',.5],['calc(infinity)',1],['calc(-infinity)',0],['calc(NaN)',0],['calc(1 / 0)',1],['calc(infinity * 1%)',1]]) {
    const normalized = normalizeOpacity('opacity', value);
    expect(normalized).not.toBeNull();
    expect(computedOpacity(normalized)).toBe(expected);
  }
  // Do not advertise calculations that require an unavailable layout context.
  expect(supportsDeclaration('opacity', 'calc(1em / 1px)')).toBeFalse();
  expect(computedOpacity('calc(1px + 1px)')).toBeUndefined();
});

test('opacity variable fallback, invalid computed values and transparent paint culling', () => {
  const {window, document} = parseHTMLDocument('<body style="margin:0"><div id="parent"><p id="valid">faint</p><p id="zero">gone</p><p id="invalid">unset</p><p id="fallback">fallback</p><p id="inherited">inherited</p></div></body>');
  try {
    const styles = new StyleEngine().compute(document, [`
      #parent{opacity:50%}
      #valid{opacity:var(--alpha);--alpha:calc(25% * 2)}
      #zero{opacity:calc(-1)}
      #invalid{opacity:.2;opacity:var(--alpha);--alpha:garbage}
      #fallback{opacity:var(--missing, 30%)}
      #inherited{opacity:inherit}
    `]);
    expect(['parent','valid','zero','invalid','fallback','inherited'].map(id => styles.get(document.getElementById(id)).opacity)).toEqual([.5,.5,0,1,.3,.5]);
    const tree = new RenderTreeBuilder().build(document,styles);
    const layout = layoutText(tree,{x:0,y:0,width:200,lineHeight:20,measureText:text=>text.length*10,fontMetrics:()=>({ascent:16,height:20})});
    const texts = buildDisplayList(layout,tree).items.filter(item=>item.op==='drawText');
    expect(texts.find(item=>item.text==='gone')).toBeUndefined();
    // In-flow text paints before the sibling opacity stacking contexts.
    expect(texts.map(item=>[item.text,item.opacity])).toEqual([['unset',.5],['faint',.25],['fallback',.15],['inherited',.25]]);
  } finally {window.happyDOM.close();}
});

test('computed percentage opacity reaches software-painted pixels', async () => {
  const {createPageRenderer, loadGraphics} = await import('../lib/renderer/page-renderer.js');
  const {CanvasKit: kit} = await loadGraphics();
  const renderer = await createPageRenderer({});
  let image;
  try {
    renderer.resize(40,10,1);
    await renderer.loadDocument({url:'https://opacity.test/', contentType:'text/html', source:`<!doctype html><style>
      body{margin:0;background:white}div{position:absolute;top:0;width:10px;height:10px;background:red}
      #a{left:0;opacity:calc(25% * 2)}#b{left:10px;opacity:calc(-2)}
      #c{left:20px;opacity:calc(1 + 1)}#d{left:30px;opacity:var(--missing, 25%)}
      </style><div id=a></div><div id=b></div><div id=c></div><div id=d></div>`});
    await renderer.whenLoaded();
    image = kit.MakeImageFromEncoded(Buffer.from(await renderer.screenshot({format:'png'}), 'base64'));
    const pixels = image.readPixels(0,0,{width:40,height:10,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB});
    const at = x => [...pixels.subarray((5*40+x)*4,(5*40+x)*4+4)];
    const near = (actual, expected) => actual.forEach((value,index) => expect(Math.abs(value-expected[index])).toBeLessThanOrEqual(1));
    near(at(5),[255,127,127,255]);
    expect(at(15)).toEqual([255,255,255,255]);
    expect(at(25)).toEqual([255,0,0,255]);
    near(at(35),[255,191,191,255]);
  } finally {image?.delete(); renderer.dispose();}
});
