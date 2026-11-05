import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {RendererHost} from '../lib/renderer/host.js';

function fixture() {
  const parsed=parseHTMLDocument('<form id=f></form>');
  const input=(type,attributes={},value)=>{
    const element=parsed.document.createElement('input');element.type=type;
    for(const [name,text]of Object.entries(attributes))element.setAttributeNS(null,name,text);
    if(value!==undefined)element.value=value;
    parsed.document.querySelector('form').append(element);return element;
  };
  return {...parsed,input};
}

test('seven typed controls step with their units, defaults and UTC calendar boundaries',()=>{
  const {window,input}=fixture();
  try {
    for(const [type,start,next]of [
      ['number','24','25'],['range','22','23'],['date','1970-01-01','1970-01-02'],
      ['month','1969-12','1970-01'],['week','2020-W53','2021-W01'],
      ['time','00:00','00:01'],['datetime-local','2024-03-10T01:59','2024-03-10T02:00'],
    ]) {
      const e=input(type,{},start);expect(e.stepUp()).toBeUndefined();expect(e.value).toBe(next);
      expect(e.stepDown()).toBeUndefined();expect(e.value).toBe(start);
    }
    const range=input('range');range.stepUp();expect(range.value).toBe('51');
    const alignedRange=input('range',{step:'3'});alignedRange.stepUp();expect(alignedRange.value).toBe('54');
    for(const bad of ['0','-2','bogus','']) {
      const e=input('number',{step:bad},'1');e.stepUp();expect(e.value).toBe('2');
    }
    for(const [type,start,next,step]of [
      ['date','2000-01-01','2000-01-02','.1'],['month','2000-01','2000-03','1.5'],
      ['week','2000-W01','2000-W03','1.5'],['time','00:00:00.001','00:00:00.002','.0001'],
      ['datetime-local','2000-01-01T00:00:00.001','2000-01-01T00:00:00.002','.0005'],
    ]) {const e=input(type,{step},start);e.stepUp();expect(e.value).toBe(next);}
  }finally{window.happyDOM.close();}
});

test('stepping keeps exact decimal precision, signed counts and author step bases',()=>{
  const {window,input}=fixture();
  try {
    const decimal=input('number',{step:'.3'},'1.2');decimal.stepDown();expect(decimal.value).toBe('0.9');
    for(let i=0;i<100;i++)decimal.stepUp();expect(decimal.value).toBe('30.9');
    for(const [count,up,down]of [[-2,'2','8'],[-1,'4','6'],[0,'5','5'],[1,'6','4'],[2,'8','2']]) {
      const e=input('number',{step:'2'},'5');e.stepUp(count);expect(e.value).toBe(up);
      e.value='5';e.stepDown(count);expect(e.value).toBe(down);
    }
    const base=input('number',{value:'.3',step:'.2'});base.stepUp(2);expect(base.value).toBe('0.7');
    base.min='.2';base.value='.3';base.stepUp(2);expect(base.value).toBe('0.6');
    const prefix=input('number',{step:'  +2junk'},'4');prefix.stepUp();expect(prefix.value).toBe('6');
    prefix.setAttributeNS('urn:foreign','min','100');prefix.value='4';prefix.stepUp();expect(prefix.value).toBe('6');
    prefix.setAttributeNS(null,'min','100');prefix.value='4';prefix.stepUp();expect(prefix.value).toBe('100');
    const long=input('number',{},'0');long.stepDown(-2147483648);expect(long.value).toBe('2147483648');
    long.value='0';long.stepUp(4294967297);expect(long.value).toBe('1');
    long.value='0';long.stepUp(-1.9);expect(long.value).toBe('-1');
  }finally{window.happyDOM.close();}
});

test('stepping clamps aligned bounds, treats empty values separately and never wraps time',()=>{
  const {window,input}=fixture();
  try {
    for(const [source,min,n,expected]of [['','7',1,'7'],['','-7',1,'-1'],['3','7',1,'3'],['10','7',1,'9']]) {
      const e=input('number',{min},source);e.stepDown(n);expect(e.value).toBe(expected);
    }
    const up=input('number',{max:'7',step:'3'},'0');up.stepUp(3);expect(up.value).toBe('6');
    up.value='9';up.stepUp();expect(up.value).toBe('9');
    const reversed=input('number',{min:'10',max:'5'},'0');reversed.stepUp();expect(reversed.value).toBe('0');
    for(const [type,value]of [['time','23:59'],['date','275760-09-13'],['month','275760-09'],['week','275760-W37'],['datetime-local','275760-09-13T00:00'],['number',String(Number.MAX_VALUE)]]) {
      const e=input(type,{},value);e.stepUp(1000);expect(e.value).toBe(value);
    }
    for(const [type,value]of [['time','00:00'],['date','0001-01-01'],['month','0001-01'],['week','0001-W01'],['datetime-local','0001-01-01T00:00']]) {
      const e=input(type,{},value);e.stepDown(1000);expect(e.value).toBe(value);
    }
    const periodic=input('time',{min:'22:00',max:'06:00'},'23:00');periodic.stepDown();expect(periodic.value).toBe('23:00');
    const huge=input('date',{step:'1e308'},'2000-01-01');huge.stepUp();expect(huge.value).toBe('2000-01-01');
    const tiny=input('number',{step:'5e-324'},'0');tiny.stepUp();expect(tiny.value).toBe('5e-324');
    tiny.stepDown();expect(tiny.value).toBe('0');
    // No aligned value exists in this calendar's representable domain.
    const impossible=input('date',{step:'1e308',value:'0001-01-01',min:'2000-01-01',max:'2001-01-01'},'2000-01-02');
    impossible.stepUp();expect(impossible.value).toBe('2000-01-02');
  }finally{window.happyDOM.close();}
});

test('script stepping dirties successful values without user events and preserves true no-ops',()=>{
  const {window,document,input}=fixture();
  try {
    const e=input('number',{value:'5',step:'2'});let events=0;
    e.addEventListener('input',()=>events++);e.addEventListener('change',()=>events++);
    e.stepUp(0);e.defaultValue='20';expect(e.value).toBe('5');
    e.stepUp();expect(e.value).toBe('6');expect(events).toBe(0);
    expect(e.cloneNode().value).toBe('6');document.querySelector('form').reset();expect(e.value).toBe('20');
    const noop=input('number',{value:'1',min:'10',max:'5'});noop.stepUp();noop.defaultValue='2';expect(noop.value).toBe('2');
    for(const type of ['text','button','color','checkbox','file']) {
      const control=input(type);expect(()=>control.stepUp()).toThrow('This input type does not support stepping');
    }
    for(const any of ['any','ANY','aNy']) {
      e.step=any;expect(()=>e.stepUp(0)).toThrow('An input with step any cannot be stepped');
    }
    e.step=' any ';e.value='1';e.stepUp();expect(e.value).toBe('2');
    e.type='number';e.value='4';const marker={};
    let thrown;try{e.stepUp({valueOf(){throw marker}})}catch(error){thrown=error}expect(thrown).toBe(marker);expect(e.value).toBe('4');
  }finally{window.happyDOM.close();}
});

test('page stepping enforces input brands and defining-realm IDL conversions, and repaints values',async()=>{
  const host=new RendererHost();const run=source=>host.call('evaluate',source);
  try {
    await host.start();await host.call('resize',400,130,1);
    await host.call('loadDocument',{url:'https://step-api.test/',contentType:'text/html',source:'<form id=f><input id=i type=number value=123 style="width:300px;font-size:24px"></form><div id=d></div>'});
    await host.call('whenLoaded');
    await run(`window.i=document.getElementById('i');window.d=document.getElementById('d');window.up=HTMLInputElement.prototype.stepUp;window.down=HTMLInputElement.prototype.stepDown;window.savedError=TypeError;window.events=0;i.oninput=i.onchange=()=>events++`);
    expect(await run(`[typeof i.stepUp,i.stepUp.length,i.stepDown.length,'stepUp' in d,Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'stepUp').enumerable]`)).toEqual(['function',0,0,false,true]);
    expect(await run(`(()=>{const result=[];for(const e of [{},d,document.createElementNS('http://www.w3.org/2000/svg','input')]){let converted=false;try{up.call(e,{valueOf(){converted=true;return 1}})}catch(x){result.push(x instanceof TypeError&&!converted)}}return result})()`)).toEqual([true,true,true]);
    expect(await run(`(()=>{const result=[];for(const n of [1n,Symbol('x'),Object(1n)])try{i.stepUp(n);result.push(false)}catch(x){result.push(x instanceof TypeError)}return result})()`)).toEqual([true,true,true]);
    expect(await run(`(()=>{const result=[];for(const n of [undefined,null,NaN,Infinity,-Infinity,4294967297,-1.9]){i.value='0';i.stepUp(n);result.push(i.value)}return result})()`)).toEqual(['1','0','0','0','0','1','-1']);
    expect(await run(`(()=>{const marker={};try{i.stepUp({valueOf(){throw marker}})}catch(x){return x===marker}})()`)).toBeTrue();
    expect(await run(`(()=>{i.type='text';let converted=false;try{i.stepUp({valueOf(){converted=true;i.type='number';i.value='5';i.step='2';return 2}})}catch(x){return x.name}return [converted,i.value]})()`)).toEqual([true,'9']);
    expect(await run(`(()=>{i.type='text';let valid=false;try{i.stepUp()}catch(x){valid=x instanceof DOMException&&x.name==='InvalidStateError'}return valid})()`)).toBeTrue();
    expect(await run(`(()=>{i.type='number';window.TypeError=function(){throw 'replaced'};try{i.stepUp(1n)}catch(x){return x instanceof savedError}finally{window.TypeError=savedError}})()`)).toBeTrue();
    await run(`i.step='1';i.value='123'`);const before=await host.call('screenshot',{format:'png'});
    await run(`i.stepUp()`);const after=await host.call('screenshot',{format:'png'});expect(after).not.toBe(before);
    await run(`i.value='124'`);expect(await host.call('screenshot',{format:'png'})).toBe(after);
    expect(await run(`[i.value,events]`)).toEqual(['124',0]);
    await run(`document.getElementById('f').reset()`);expect(await host.call('screenshot',{format:'png'})).toBe(before);
  }finally{host.close();}
},30000);
