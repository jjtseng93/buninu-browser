import { test, expect } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';
import { inputDateTimestamp, serializeInputNumber, serializeInputDate } from '../lib/happy-dom/input-value-types.js';
import { RendererHost } from '../lib/renderer/host.js';

test('typed number serialization uses UTC, ISO weeks, periodic time and finite date limits', () => {
  for(const [type,number,text] of [
    ['number',-0,'0'],['number',1e30,'1e+30'],['month',-1,'1969-12'],['month',-.5,'1969-12'],
    ['month',-.1,'1970-01'],['month',.5,'1970-02'],['month',1.1,'1970-02'],['month',1.5,'1970-03'],
    ['date',-.5,'1969-12-31'],['date',-.1,'1970-01-01'],['date',253402300800000,'10000-01-01'],
    ['date',-62135596800000,'0001-01-01'],['date',-62135596800001,''],['date',8640000000000001,''],
    ['datetime-local',.5,'1970-01-01T00:00:00.001'],['datetime-local',-.5,'1969-12-31T23:59:59.999'],
    ['datetime-local',1710037800000,'2024-03-10T02:30'],
    ['datetime-local',8639999999999999,'275760-09-12T23:59:59.999'],
    ['datetime-local',4503599627370497,'144683-05-23T16:29:30.497'],
    ['week',0,'1970-W01'],['week',1575849600000,'2019-W50'],['week',1609459200000,'2020-W53'],
    ['week',-62135596800000,'0001-W01'],['week',8640000000000001,'275760-W37'],
    ['time',-3600000,'23:00'],['time',-.1,'23:59:59.999'],['time',1.9,'00:00:00.001'],
    ['time',2.734333707189448e26,'10:54:10.944'],['time',Infinity,''],
  ]) expect(serializeInputNumber(type,number)).toBe(text);
  expect(inputDateTimestamp('month','1969-12')).toBe(-2678400000);
  expect(inputDateTimestamp('datetime-local','1970-01-01T00:00')).toBeNull();
  expect(serializeInputDate('time',1704112496789)).toBe('12:34:56.789');
  expect(serializeInputDate('month',253402300800000)).toBe('10000-01');
});

test('native Date and number APIs preserve dirty/reset values and use Date internal slots', () => {
  const {window,document}=parseHTMLDocument('<form><input type=date value=2000-01-01></form>');
  try {
    const input=document.querySelector('input');
    const first=input.valueAsDate,second=input.valueAsDate;
    expect(first).not.toBe(second);expect(first.getTime()).toBe(946684800000);
    first.setFullYear(2010);expect(input.value).toBe('2000-01-01');
    input.defaultValue='2001-01-01';expect(input.value).toBe('2001-01-01');
    const foreign=runInNewContext('new Date(1575936000000)');
    foreign.getTime=()=>{throw Error('must not call override');};foreign.toISOString=foreign.getTime;
    input.valueAsDate=foreign;expect(input.value).toBe('2019-12-10');
    input.defaultValue='2002-01-01';expect(input.value).toBe('2019-12-10');
    expect(input.cloneNode().valueAsNumber).toBe(1575936000000);
    document.querySelector('form').reset();expect(input.value).toBe('2002-01-01');
    for(const value of [undefined,null,new Date(NaN)]) {input.value='2000-01-01';input.valueAsDate=value;expect(input.value).toBe('');}
    for(const value of [{},new Proxy(new Date(0),{}),Object.create(Date.prototype),1,'x',1n]) {
      input.value='2000-01-01';expect(()=>{input.valueAsDate=value;}).toThrow(window.TypeError);expect(input.value).toBe('2000-01-01');
    }
    input.type='week';input.value='1969-W20';expect(input.valueAsNumber).toBe(-20217600000);
    expect(input.valueAsDate.getTime()).toBe(-20217600000);
    input.type='time';input.valueAsNumber=-3600000;expect(input.value).toBe('23:00');
    input.valueAsDate=new Date(1704112496789);expect(input.value).toBe('12:34:56.789');
    input.type='text';expect(input.valueAsDate).toBeNull();expect(input.valueAsNumber).toBeNaN();
    expect(()=>{input.valueAsDate={};}).toThrow('This input type does not support Date values');
    expect(()=>{input.valueAsDate=1;}).toThrow(window.TypeError);
    expect(()=>{input.valueAsNumber=Infinity;}).toThrow(window.TypeError);
    expect(()=>{input.valueAsNumber=0;}).toThrow('This input type does not support number values');
  } finally {window.happyDOM.close();}
});

test('native numeric assignment clears NaN, preserves out-of-range values and existing range behavior', () => {
  const {window,document}=parseHTMLDocument('<input type=number min=0 max=10>');
  try {
    const input=document.querySelector('input');let events=0;
    for(const name of ['input','change'])input.addEventListener(name,()=>events++);
    input.valueAsNumber=20;expect(input.value).toBe('20');expect(input.validity.rangeOverflow).toBeTrue();
    input.valueAsNumber='2';expect(input.value).toBe('2');
    const marker={};expect(()=>{input.valueAsNumber={valueOf(){throw marker;}};}).toThrow();expect(input.value).toBe('2');
    for(const value of [1n,Symbol('number'),Infinity,-Infinity]) {
      let error;try {input.valueAsNumber=value;}catch(e){error=e;}
      expect(error?.name).toBe('TypeError');
    }
    input.valueAsNumber=NaN;expect(input.value).toBe('');expect(input.valueAsNumber).toBeNaN();
    input.type='range';input.valueAsNumber=20;expect(input.valueAsNumber).toBe(10);
    input.valueAsNumber=NaN;expect(input.valueAsNumber).toBe(5);
    expect(events).toBe(0);
  } finally {window.happyDOM.close();}
});

test('page typed accessors keep Date/error realms, receiver brands and numeric conversion order', async () => {
  const host=new RendererHost();const run=source=>host.call('evaluate',source);
  try {
    await host.start();await host.call('loadDocument',{url:'https://typed-api.test/',contentType:'text/html',source:'<input id=i type=date value=2000-01-01><div id=d></div>'});await host.call('whenLoaded');
    await run(`window.i=document.getElementById('i');window.d=document.getElementById('d');window.SavedDate=Date;window.SavedTypeError=TypeError;window.dateAPI=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'valueAsDate');window.numberAPI=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'valueAsNumber')`);
    expect(await run(`[i.valueAsDate instanceof Date,i.valueAsDate.getTime(),i.valueAsDate!==i.valueAsDate,'valueAsDate' in d,'valueAsNumber' in d,dateAPI.enumerable,dateAPI.configurable]`)).toEqual([true,946684800000,true,false,false,true,true]);
    expect(await run(`(()=>{const v=new Date(1575936000000);v.getTime=()=>{throw 'override'};v.toISOString=v.getTime;i.valueAsDate=v;return [i.value,i.valueAsDate.getTime()];})()`)).toEqual(['2019-12-10',1575936000000]);
    expect(await run(`(()=>{const result=[];for(const v of [{},d,document.createElementNS('http://www.w3.org/2000/svg','input')])for(const api of [dateAPI,numberAPI]){try{api.get.call(v);result.push(false)}catch(e){result.push(e instanceof TypeError)}}return result})()`)).toEqual([true,true,true,true,true,true]);
    expect(await run(`(()=>{i.type='number';i.valueAsNumber={valueOf(){i.type='date';return 0}};return [i.type,i.value]})()`)).toEqual(['date','1970-01-01']);
    expect(await run(`(()=>{const marker={};try{i.valueAsNumber={valueOf(){throw marker}}}catch(e){return e===marker}})()`)).toBeTrue();
    expect(await run(`(()=>{i.type='text';const results=[];for(const v of [Infinity,-Infinity,1n,Symbol('x')])try{i.valueAsNumber=v;results.push(false)}catch(e){results.push(e instanceof TypeError)};try{i.valueAsNumber=0}catch(e){results.push(e.name==='InvalidStateError'&&e instanceof DOMException)};try{i.valueAsDate={}}catch(e){results.push(e.name==='InvalidStateError')};return results})()`)).toEqual([true,true,true,true,true,true]);
    expect(await run(`(()=>{i.type='date';window.Date=function(){throw 'replaced Date'};window.TypeError=function(){throw 'replaced TypeError'};i.valueAsDate=new SavedDate(0);let invalid=false;try{i.valueAsNumber=1n}catch(e){invalid=e instanceof SavedTypeError};return [i.valueAsDate instanceof SavedDate,i.valueAsDate.getTime(),invalid]})()`)).toEqual([true,0,true]);
    await run(`window.Date=SavedDate;window.TypeError=SavedTypeError`);
  } finally {host.close();}
},30000);

test('page typed setter changes affect rendered validity without generating user events', async () => {
  const host=new RendererHost();const run=source=>host.call('evaluate',source);
  try {
    await host.start();await host.call('loadDocument',{url:'https://typed-api.test/',contentType:'text/html',source:'<style>input:valid{color:green}input:invalid{color:red}</style><form id=f><input id=i type=date min=2000-01-01 value=2001-01-01></form>'});await host.call('whenLoaded');
    await run(`window.i=document.getElementById('i');window.f=document.getElementById('f');window.events=0;i.oninput=i.onchange=()=>events++`);
    await run(`i.valueAsNumber=0`);
    expect(await run(`[i.value,i.validity.rangeUnderflow,getComputedStyle(i).color,events]`)).toEqual(['1970-01-01',true,'rgb(255, 0, 0)',0]);
    await run(`i.valueAsDate=new Date('2002-01-01T23:00Z')`);
    expect(await run(`[i.value,i.validity.valid,getComputedStyle(i).color,events]`)).toEqual(['2002-01-01',true,'rgb(0, 128, 0)',0]);
    await run(`f.reset()`);expect(await run(`[i.value,i.valueAsDate.getTime(),events]`)).toEqual(['2001-01-01',978307200000,0]);
    // Compare actual captured pixels while the validity/style stays identical.
    // Typed API assignment must repaint text just like ordinary .value writes.
    const initial=await host.call('screenshot',{format:'png'});
    await run(`i.valueAsNumber=1009843200000`);
    const numeric=await host.call('screenshot',{format:'png'});
    expect(numeric).not.toBe(initial);
    await run(`i.value='2001-01-01'`);
    expect(await host.call('screenshot',{format:'png'})).toBe(initial);
    await run(`i.value='2002-01-01'`);
    expect(await host.call('screenshot',{format:'png'})).toBe(numeric);
    await run(`i.valueAsDate=new Date('2003-01-01T00:00Z')`);
    const dated=await host.call('screenshot',{format:'png'});
    expect(dated).not.toBe(numeric);
    await run(`i.value='2003-01-01'`);
    expect(await host.call('screenshot',{format:'png'})).toBe(dated);
  } finally {host.close();}
},30000);
