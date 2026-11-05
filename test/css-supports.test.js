import {test,expect} from 'bun:test';
import {supportsCSS,supportsDeclaration,parseStyleSheet,extractAnimationKeyframes,extractFontFaces} from '../lib/style/computed-style.js';
import {RendererHost} from '../lib/renderer/host.js';

test('feature queries validate declarations and balanced logical conditions',()=>{
 for(const c of ['(color:red)','not (unknown: value)','(display:grid) and (width:10px)','(width:nope) or (color:blue)','((color:red))','not (future(foo))']) expect(supportsCSS(c)).toBe(true);
 for(const c of ['color:red','not (','not (color:red) and (width:10px)','(color:red) or (width:1px) and (height:1px)','(color:red) (width:1px)','(width:garbage)','not ((color:red)']) expect(supportsCSS(c)).toBe(false);
 expect(supportsCSS('color:red',true)).toBe(true);
 expect(supportsDeclaration('width','garbage')).toBe(false);
 expect(supportsDeclaration('color','notacolor')).toBe(false);
 expect(supportsDeclaration('anchor-name','--foo')).toBe(false);
 expect(supportsDeclaration('unicode-range','inherit')).toBe(false);
 expect(supportsDeclaration('--theme','red')).toBe(true);
 expect(supportsDeclaration('color','unknown(var(--theme))')).toBe(true);
 expect(supportsDeclaration('color','var(nope)')).toBe(false);
 expect(supportsDeclaration('color','var(--theme')).toBe(false);
 expect(supportsDeclaration('--theme','"a;b!"')).toBe(true);
 expect(supportsDeclaration('--theme','{a:b}')).toBe(true);
 expect(supportsCSS('('.repeat(5000)+'color:red'+')'.repeat(5000))).toBe(false);
});
test('rules, fonts and keyframes consistently exclude unsupported branches',()=>{
 const css=`@supports (width: nonsense) { p{color:red} @keyframes excluded{to{opacity:0}} @font-face{font-family:Excluded;src:url(excluded.woff)} }
 @supports not (width: nonsense) {p{color:green} @keyframes included{to{opacity:1}} @font-face{font-family:Included;src:url(included.woff)} }`;
 expect(parseStyleSheet(css)).toHaveLength(1);
 expect([...extractAnimationKeyframes(css).keys()]).toEqual(['included']);
 expect(extractFontFaces(css,'https://test.local/').map(f=>f.family)).toEqual(['Included']);
});
test('page CSS.supports agrees with conditional rendering without mutating inline styles',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><style>#box{color:blue}@supports (width:nope){#box{color:red}}@supports not (width:nope){#box{color:green}}</style><div id="box"></div>'});await host.call('whenLoaded');
  expect(await host.call('evaluate',`[CSS.supports('color','red'),CSS.supports('width','nope'),CSS.supports('(color:red) and (display:block)'),CSS.supports('--theme','blue'),getComputedStyle(document.getElementById('box')).color,document.body.getAttribute('style')]`)).toEqual([true,false,true,true,'rgb(0, 128, 0)',null]);
 }finally{await host.close();}
});
