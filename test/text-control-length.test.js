import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {RendererHost} from '../lib/renderer/host.js';

test('input and textarea length attributes reflect decimal non-negative longs',()=>{
  const {window,document}=parseHTMLDocument('<input><textarea></textarea>');
  try {
    for(const element of document.querySelectorAll('input,textarea'))for(const name of ['minLength','maxLength']) {
      const attribute=name.toLowerCase();
      expect(element[name]).toBe(-1);
      for(const [source,expected] of [['',-1],['-1',-1],['abc',-1],['0',0],['-0',0],['+12',12],[' \n25junk',25],['1.5',1],['0x20',0],['\u00a01',-1],['2147483647',2147483647],['2147483648',-1],['9999999999999999999999',-1]]) {
        element.setAttributeNS(null,attribute,source);expect(element[name]).toBe(expected);
      }
      element.removeAttributeNS(null,attribute);
      element.setAttributeNS('urn:test',attribute,'9');expect(element[name]).toBe(-1);
      element[name]=4;
      expect(element[name]).toBe(4);expect(element.getAttributeNS('urn:test',attribute)).toBe('9');
      expect(element.getAttributeNS(null,attribute)).toBe('4');
    }
  } finally {window.happyDOM.close();}
});

test('length assignment applies WebIDL long conversion and rejects negatives atomically',()=>{
  const {window,document}=parseHTMLDocument('<input><textarea></textarea>');
  try {
    for(const element of document.querySelectorAll('input,textarea'))for(const name of ['minLength','maxLength']) {
      for(const [source,expected] of [[undefined,0],[null,0],[NaN,0],[Infinity,0],[-Infinity,0],['not a number',0],[3.9,3],[-0.9,0],[4294967298,2],[-4294967294,2],[{valueOf:()=>6},6]]) {
        element[name]=source;expect(element[name]).toBe(expected);
      }
      element[name]=5;
      for(const value of [-1,-3.8,2147483648,4294967295]) {
        expect(()=>{element[name]=value}).toThrow(expect.objectContaining({name:'IndexSizeError'}));
        expect(element[name]).toBe(5);
      }
      for(const value of [Symbol('x'),1n,{valueOf:()=>1n},{[Symbol.toPrimitive]:()=>({})}]) {
        expect(()=>{element[name]=value}).toThrow(TypeError);expect(element[name]).toBe(5);
      }
    }
  } finally {window.happyDOM.close();}
});

test('page length errors use the page realm and editing enforces UTF-16 limits on keyboard and paste',async()=>{
  let clipboard='';const host=new RendererHost({clipboardRead:async()=>clipboard});
  const run=source=>host.call('evaluate',source);
  try {
    await host.start();
    await host.call('loadDocument',{url:'https://length.test/',contentType:'text/html',source:'<input id=i><textarea id=t></textarea>'});
    await host.call('whenLoaded');
    expect(await run(`(()=>{
      const result=[];
      for(const element of document.querySelectorAll('input,textarea'))for(const property of ['minLength','maxLength']) {
        element[property]=5;
        for(const value of [Symbol('x'),1n,{valueOf:()=>1n},{[Symbol.toPrimitive]:()=>({})}]) {
          try {element[property]=value;result.push(false)}catch(error){result.push(error instanceof TypeError&&element[property]===5)}
        }
        try {element[property]=-1;result.push(false)}catch(error){result.push(error.name==='IndexSizeError'&&element[property]===5)}
        const own={};try {element[property]={valueOf(){throw own}};result.push(false)}catch(error){result.push(error===own)}
      }
      return result;
    })()`)).toEqual(Array(24).fill(true));
    await run(`window.i=document.getElementById('i');window.t=document.getElementById('t');window.events=[];
      i.minLength=10;i.maxLength=4;i.oninput=e=>events.push(e.data);i.focus()`);
    await host.call('type','A😀BC');
    expect(await run(`[i.value,i.selectionStart,i.selectionEnd,events]`)).toEqual(['A😀B',4,4,['A😀B']]);
    await host.call('press','z');expect(await run(`i.value`)).toBe('A😀B');
    await host.call('press','Backspace');expect(await run(`i.value`)).toBe('A😀');
    await host.call('press','z');expect(await run(`i.value`)).toBe('A😀z');
    await run(`i.setSelectionRange(1,3)`);await host.call('press','x');
    expect(await run(`[i.value,i.selectionStart]`)).toEqual(['Axz',2]);
    await run(`i.value='';i.maxLength=1;events=[]`);await host.call('type','😀');
    expect(await run(`[i.value,events.length]`)).toEqual(['',0]);
    await run(`i.maxLength=2`);await host.call('type','😀');expect(await run(`i.value`)).toBe('😀');
    await run(`i.value='';i.maxLength=10`);clipboard='👨‍👩‍👧‍👦';
    await host.call('press','v',{modifiers:2});
    for(let n=0;n<30&&await run(`i.value===''`);n++)await Bun.sleep(10);
    expect(await run(`i.value`)).toBe('👨‍👩‍👧‍');
    await run(`t.maxLength=4;t.focus()`);clipboard='a\r\n😀';
    await host.call('press','v',{modifiers:2});
    for(let n=0;n<30&&await run(`t.value===''`);n++)await Bun.sleep(10);
    expect(await run(`[t.value,t.selectionStart]`)).toEqual(['a\n😀',4]);
    await run(`t.value='script can exceed the limit'`);
    expect(await run(`t.value`)).toBe('script can exceed the limit');
  } finally {host.close();}
},30000);
