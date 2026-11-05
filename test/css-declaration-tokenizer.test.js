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
