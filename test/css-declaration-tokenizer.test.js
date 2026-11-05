import {test,expect} from 'bun:test';
import {parseDeclarationText} from '../lib/happy-dom/css-text-parser.js';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';

test('declarations preserve quoted delimiters, nested functions, comments and priorities',()=>{
 const result=parseDeclarationText('--text:"a;b{}/*x*/";width:calc(1px + var(--x, calc(2px + 3px)));color:/**/red ! IMPORTANT;--block:{a:b;c:d};height:9px');
 expect(result.rules.map(r=>[r.name,r.value,r.important])).toEqual([
  ['--text','"a;b{}/*x*/"',false],['width','calc(1px + var(--x, calc(2px + 3px)))',false],['color','red',true],['--block','{a:b;c:d}',false],['height','9px',false],
 ]);
 expect(parseDeclarationText('color:red;width:"unterminated').rules).toHaveLength(1);
 expect(parseDeclarationText('--x:"a\\";b";height:2px').rules).toHaveLength(2);
 const long='x'.repeat(200000);expect(parseDeclarationText(`--x:"${long};${long}";height:2px`).rules).toHaveLength(2);
});
test('inline declaration reads and mutations retain custom strings and nested values',()=>{
 const {window,document}=parseHTMLDocument('<div></div>');
 try{
  const style=document.querySelector('div').style;
  style.cssText='--message:"a;b{}";color:red';
  expect(style.getPropertyValue('--message')).toBe('"a;b{}"');
  style.height='12px';
  expect(style.getPropertyValue('--message')).toBe('"a;b{}"');
  expect(style.height).toBe('12px');
 }finally{window.happyDOM.close();}
});

test('discard at-rules without swallowing following inline declarations',()=>{
 const cases=[
  '@unknown{}color:red',
  '@unknown x { nested {a:b} --value:"};"; }color:red',
  ' /**/ @unknown ("{") { /* } */ nested{} }color:red',
  '@unknown x(y;z);color:red',
  '@unknown{}@another{}color:red',
  '@é{}color:red',
  '@-vendor{}color:red',
  '@--custom{}color:red',
  '@\\66 oo{}color:red',
 ];
 const {window,document}=parseHTMLDocument('<div></div>');
 try {
  const element=document.querySelector('div');
  for(const source of cases){
   expect(parseDeclarationText(source).rules).toEqual([{name:'color',value:'red',important:false}]);
   element.setAttribute('style',source);expect(element.style.cssText).toBe('color: red;');
   element.style.cssText=source;expect(element.style.cssText).toBe('color: red;');
  }
  for(const source of ['@{}color:red','@1{}color:red','@-1{}color:red','{}color:red','@unknown{color:red','\u00a0@unknown{}color:red','@unknown{(]}color:red']){
   element.style.cssText=source;expect(element.style.cssText).toBe('');
  }
  element.style.cssText='--block:{a:b;c:d};--text:"@foo{}";color:red';
  expect(element.style.getPropertyValue('--block')).toBe('{a:b;c:d}');
  expect(element.style.getPropertyValue('--text')).toBe('"@foo{}"');
 } finally {window.happyDOM.close();}
});
