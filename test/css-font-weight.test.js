import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine,parseDeclarations,supportsDeclaration,extractFontFaces,parseFontShorthand} from '../lib/style/computed-style.js';
import {computedFontWeight} from '../lib/style/font-weight-values.js';
import {parseCanvasFont} from '../lib/renderer/canvas-text.js';
import {neededFontFaces} from '../lib/renderer/font-loading.js';

function fixture() {
  const f=parseHTMLDocument('<!doctype html><main id=p style="font-weight:349;font-size:24px;line-height:2"><div id=x></div></main>'),styles=new StyleEngine(),x=f.document.getElementById('x'),p=f.document.getElementById('p');
  return {...f,p,x,s:x.style,computed(){styles.compute(f.document);return styles.get(x);},close:()=>f.window.happyDOM.close()};
}

test('font weight grammar, CSSOM and feature queries share literal ranges and calculation types',()=>{
  const f=fixture();
  try {
    for(const [value,serialized,computed] of [
      ['NORMAL','normal',400],['b\\6f ld','bold',700],['150.25','150.25',150.25],['+4e2','400',400],
      ['1','1',1],['1000','1000',1000],['calc(100.5*3 + 50.5)','calc(352)',352],
      ['calc(-100)','calc(-100)',1],['calc(1001)','calc(1001)',1000],['min(600, 400)','calc(400)',400],
      ['calc(10px / 2px * 100)','calc(500)',500],['calc(infinity)','calc(infinity)',1000],
      ['calc(-infinity)','calc(-infinity)',1],['calc(NaN)','calc(NaN)',1]]) {
      f.s.cssText='';f.s.fontWeight=value;expect(f.s.fontWeight).toBe(serialized);expect(f.computed().fontWeight).toBe(computed);expect(supportsDeclaration('font-weight',value)).toBeTrue();
      const text=f.s.cssText;f.s.cssText=text;expect(f.s.fontWeight).toBe(serialized);
    }
    for(const value of ['0','.999','-100','1000.001','1001','400 700','bold 400','calc(200) 400','calc(200px)','calc(50%)','calc(100 + 1px)','calc(100+200)','calc(100 +)','var(x)','calc(sign(20cqw - 10px))']) {
      f.s.cssText='font-weight:300!important';f.s.fontWeight=value;
      expect(f.s.fontWeight).toBe('300');expect(f.s.getPropertyPriority('font-weight')).toBe('important');expect(supportsDeclaration('font-weight',value)).toBeFalse();
      expect(parseDeclarations(`font-weight:300;font-weight:${value}`)).toEqual(parseDeclarations('font-weight:300'));
    }
  }finally{f.close();}
});

test('relative weights follow inherited thresholds and update descendants after parent changes',()=>{
  const f=fixture();
  try {
    for(const [parent,bolder,lighter] of [[1,400,1],[99.5,400,99.5],[100,400,100],[349.99,400,100],[350,700,100],[549.99,700,100],[550,900,400],[749.99,900,400],[750,900,700],[899.99,900,700],[900,900,700],[950,950,700],[1000,1000,700]]) {
      f.p.style.fontWeight=String(parent);
      f.s.fontWeight='bolder';expect(f.computed().fontWeight).toBe(bolder);
      f.s.fontWeight='lighter';expect(f.computed().fontWeight).toBe(lighter);
      expect(computedFontWeight('bolder',parent)).toBe(bolder);expect(computedFontWeight('lighter',parent)).toBe(lighter);
    }
    f.p.style.fontWeight='349';f.s.cssText='--w:bolder;font-weight:var(--w)';expect(f.computed().fontWeight).toBe(400);
    f.p.style.fontWeight='550';expect(f.computed().fontWeight).toBe(900);
    f.s.setProperty('--w','1001');expect(f.computed().fontWeight).toBe(550);
    f.s.cssText='font-weight:initial';expect(f.computed().fontWeight).toBe(400);
    f.s.fontWeight='unset';expect(f.computed().fontWeight).toBe(550);
  }finally{f.close();}
});

test('font shorthand preserves relative weights and calculations through cascade and canvas parsing',()=>{
  const f=fixture();
  try {
    for(const [value,weight] of [['lighter 18px serif',100],['bolder 18px serif',400],['450.5 18px serif',450.5],['calc(200 + 250.5) 18px serif',450.5]]) {
      f.s.font=value;expect(f.computed().fontWeight).toBe(weight);expect(parseCanvasFont(value,16,16,349).fontWeight).toBe(weight);
    }
    expect(parseFontShorthand('bolder 18px serif').weight).toBe('bolder');
    expect(parseFontShorthand('400 500 18px serif')).toBeNull();
    f.s.cssText='font-weight:100;font:var(--font);--font:bolder 18px serif';expect(f.computed().fontWeight).toBe(400);
    f.s.setProperty('--font','450 500 18px serif');expect(f.computed()).toMatchObject({fontWeight:349,fontSize:24,lineHeight:48});
    f.s.cssText='font:bolder 18px serif;font-weight:150.25';expect(f.computed().fontWeight).toBe(150.25);
    f.s.cssText='font-weight:150.25;font:lighter 18px serif';expect(f.computed().fontWeight).toBe(100);
  }finally{f.close();}
});

test('font face descriptors retain ranges while fractional computed weights select existing faces',()=>{
  const faces=extractFontFaces('@font-face{font-family:Weight;src:url(/a.ttf);font-weight:100 399.5}@font-face{font-family:Weight;src:url(/b.ttf);font-weight:400 700}@font-face{font-family:Calc;src:url(/c.ttf);font-weight:calc(100 + 25) calc(900 + 50)}','https://font.test/');
  expect(faces.map(face=>face.weight)).toEqual([[100,399.5],[400,700],[125,950]]);
  const needed=weight=>[...neededFontFaces(faces,[{text:'i',style:{fontFamily:['Weight'],fontWeight:weight}}])];
  expect(needed(399.5)).toEqual([faces[0]]);expect(needed(400.5)).toEqual([faces[1]]);
  expect(needed(computedFontWeight('lighter',349))).toEqual([faces[0]]);expect(needed(computedFontWeight('bolder',349))).toEqual([faces[1]]);
});

test('renderer and canvas select fonts using computed relative and fractional weights',async()=>{
  // Host scripting owns process globals, so isolate it like the canvas fixture.
  const child=Bun.spawn([Bun.which('bun'),new URL('fixtures/font-weight.js',import.meta.url).pathname],{stdout:'ignore',stderr:'pipe'});
  const [status,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
  expect({status,stderr}).toEqual({status:0,stderr:''});
},30000);
