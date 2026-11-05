import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine,parseDeclarations,supportsDeclaration,extractFontFaces,resolveVariables} from '../lib/style/computed-style.js';
import {parseFontFamily,fontFamilyEntry} from '../lib/style/font-family-values.js';
import {parseCanvasFont} from '../lib/renderer/canvas-text.js';
import {neededFontFaces} from '../lib/renderer/font-loading.js';

function fixture() {
  const f=parseHTMLDocument('<!doctype html><main id=p style="font-family:serif"><div id=x></div></main>'),styles=new StyleEngine(),x=f.document.getElementById('x');
  return {...f,x,s:x.style,computed(){styles.compute(f.document);return styles.get(x);},close:()=>f.window.happyDOM.close()};
}

test('font family grammar shares canonical strings between CSSOM, declarations and feature queries',()=>{
  const f=fixture();
  try {
    for(const [value,expected] of [
      ['Serif','serif'],['"Serif"','"Serif"'],["'Times New Roman', Sans-Serif",'Times New Roman, sans-serif'],
      ['"21st Century", fantasy','"21st Century", fantasy'],['"inherit", "serif"','"inherit", "serif"'],
      ['A/**/B','A B'],['"A  B"','"A  B"'],['"A,B"','"A,B"'],['"A\\\"B"','"A\\\"B"'],
      ['A\\2c B','"A,B"'],['\\31 23','"123"'],['M\\6f no','Mono'],['"A\\a B"','"A\\a B"'],
      ['"A\\\r\nB"','AB'],['"\0"','�'],['""','""'],['GENERIC(KAI), Ui-Serif','generic(kai), ui-serif'],
      ['emoji, fangsong, BlinkMacSystemFont','emoji, fangsong, BlinkMacSystemFont']]) {
      f.s.cssText='';f.s.fontFamily=value;expect(f.s.fontFamily).toBe(expected);expect(f.computed().fontFamily.join(', ')).toBe(expected);expect(supportsDeclaration('font-family',value)).toBeTrue();
      const serialized=f.s.cssText;f.s.cssText=serialized;expect(f.s.fontFamily).toBe(expected);
    }
    for(const value of ['',',Arial','Arial,','Arial,,serif','cursive serif','FirstName initial','FirstName,unset','revert-rule','default','Red/Black','"Lucida" Grande','Ahem!','test@foo','#POUND','Hawaii 5-0','generic(other)','generic(kai,fangsong)','"bad\nline"']) {
      if(!value)continue;
      f.s.cssText='font-family:monospace!important';f.s.fontFamily=value;expect(f.s.fontFamily).toBe('monospace');expect(f.s.getPropertyPriority('font-family')).toBe('important');
      expect(supportsDeclaration('font-family',value)).toBeFalse();expect(parseDeclarations(`font-family:monospace;font-family:${value}`)).toEqual(parseDeclarations('font-family:monospace'));
    }
  }finally{f.close();}
});

test('family substitution, inheritance and font shorthand preserve quoted content and invalid cascade behavior',()=>{
  const f=fixture();
  try {
    expect(resolveVariables(String.raw`url(a\"b) var(--x)`,new Map([['--x','red']]))).toBe(String.raw`url(a\"b) red`);
    expect(resolveVariables(String.raw`var(--missing,hello\"world var(--x))`,new Map([['--x','red']]))).toBe(String.raw`hello\"world red`);
    f.s.cssText='--family:"A,B", monospace;font-family:var(--family)';expect(f.computed().fontFamily).toEqual(['"A,B"','monospace']);
    f.s.setProperty('--family','Ahem!');expect(f.computed().fontFamily).toEqual(['serif']);
    f.s.cssText='--x:wrong;font-family:"var(--x)"';expect(f.computed().fontFamily).toEqual(['"var(--x)"']);
    f.s.cssText='--x:wrong;--family:"var(--x)", serif;font-family:var(--family)';expect(f.computed().fontFamily).toEqual(['"var(--x)"','serif']);
    f.s.cssText='font-family:var(--missing,"A),B", monospace)';expect(f.computed().fontFamily).toEqual(['"A),B"','monospace']);
    f.s.cssText='font:italic bold 20px/1.5 "A  B", "serif"';expect(f.s.fontFamily).toBe('"A  B", "serif"');expect(f.computed()).toMatchObject({fontSize:20,fontWeight:700,fontStyle:'italic',lineHeight:30,fontFamily:['"A  B"','"serif"']});
    f.s.font='12px "A / B"';expect(f.s.fontFamily).toBe('"A / B"');expect(f.computed().fontFamily).toEqual(['"A / B"']);
    f.s.cssText='font-family:monospace;font-size:25px;font:12px Ahem!';expect(f.computed()).toMatchObject({fontFamily:['monospace'],fontSize:25});
    f.s.cssText='font:16px "var(--x)"';expect(f.computed().fontFamily).toEqual(['"var(--x)"']);
    const p=f.document.getElementById('p');p.style.fontFamily='"serif", "A,B"';f.s.cssText='font-family:inherit';expect(f.computed().fontFamily).toEqual(['"serif"','"A,B"']);
    expect(parseCanvasFont('italic 18px "A  B", A\\2c B, "serif"').fontFamily).toEqual(['"A  B"','"A,B"','"serif"']);
    expect(parseCanvasFont('16px Ahem!')).toBeNull();
  }finally{f.close();}
});

test('font descriptors and font selection distinguish decoded custom names from generic fallback',()=>{
  const faces=extractFontFaces('@font-face{font-family:"sans-serif";src:url(/a.ttf)}@font-face{font-family:A\\2c B;src:url(/b.ttf)}@font-face{font-family:serif;src:url(/wrong.ttf)}@font-face{font-family:Later;src:url(/later.ttf)}','https://font.test/');
  expect(faces.map(f=>f.family)).toEqual(['sans-serif','A,B','Later']);
  expect(extractFontFaces('@font-face{src:url(/wrong.ttf)}@font-face{font-family:Unused}', 'https://font.test/')).toEqual([]);
  const run=family=>[{text:'abc',style:{fontFamily:parseFontFamily(family).families}}],available=new Set(['sans-serif','monospace']);
  expect([...neededFontFaces(faces,run('sans-serif,Later'),available)]).toEqual([]);
  expect([...neededFontFaces(faces,run('"sans-serif",Later'),available)]).toEqual([faces[0]]);
  expect([...neededFontFaces(faces,run('"monospace",Later'),available)]).toEqual([faces[2]]);
  expect([...neededFontFaces(faces,run('A\\2c B,Later'),available)]).toEqual([faces[1]]);
  expect(fontFamilyEntry('"sans-serif"')).toEqual({name:'sans-serif',generic:false});expect(fontFamilyEntry('sans-serif')).toEqual({name:'sans-serif',generic:true});
});

test('renderer uses quoted custom generic names for DOM and canvas fonts without replacing generic fallback',async()=>{
  const {createPageRenderer}=await import('../lib/renderer/page-renderer.js');
  const bytes=await Bun.file(new URL('../usr/share/fonts/DejaVuSansMono.ttf',import.meta.url)).bytes();let requests=0;
  const renderer=await createPageRenderer({fetchResource:async url=>({ok:false,status:404,url,body:new Uint8Array()}),pageFetch:async()=>{requests++;return {status:200,body:bytes};}});
  try {
    renderer.setScripting('host');
    await renderer.loadDocument({url:'https://font.test/',contentType:'text/html',source:`<!doctype html><style>@font-face{font-family:"sans-serif";src:url(/mono.ttf)}@font-face{font-family:A\\2c B;src:url(/mono.ttf)}span{font-size:30px}#generic{font-family:sans-serif}#custom{font-family:"sans-serif"}#escaped{font-family:A\\2c B}</style><span id=generic>iiii</span><span id=custom>iiii</span><span id=escaped>iiii</span><canvas id=c></canvas>`});await renderer.whenLoaded();
    const spans=renderer.inspect('span'),widths=spans.map(s=>s.box.width);expect(widths[1]).toBeGreaterThan(widths[0]*2);expect(widths[2]).toBeCloseTo(widths[1],5);expect(requests).toBe(1);
    const result=await renderer.evaluate(`(()=>{const ctx=document.getElementById('c').getContext('2d');ctx.font='30px sans-serif';const a=ctx.measureText('iiii').width;ctx.font='30px "sans-serif"';const b=ctx.measureText('iiii').width;return [getComputedStyle(document.getElementById('custom')).fontFamily,a,b]})()`);
    expect(result[0]).toBe('"sans-serif"');expect(result[2]).toBeGreaterThan(result[1]*2);
  }finally{renderer.dispose();}
},30000);
