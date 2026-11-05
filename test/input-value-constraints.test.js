import { test, expect } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';
import { parseInputValue, parseInputNumber, parseNumberAttribute, inputStepMismatch } from '../lib/happy-dom/input-value-types.js';
import * as S from '../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import { RendererHost } from '../lib/renderer/host.js';

test('typed values validate calendar syntax and use UTC components across ISO years', () => {
  for (const [type, source, value, text = source] of [
    ['date','0001-01-01',-62135596800000],['date','0099-01-01',-59042995200000],
    ['date','2000-02-29',951782400000],['date','10000-01-01',253402300800000],
    ['date','275760-09-13',8640000000000000],['month','1969-12',-1],['month','10000-01',96360],
    ['week','1970-W01',-259200000],['week','2020-W53',1609113600000],['week','0001-W01',-62135596800000],
    ['time','23:59:59.999',86399999],['time','01:02:00.100',3720100],
    ['datetime-local','2024-03-10T02:30',1710037800000],
    ['datetime-local','00001-01-01 01:02:00.100',-62135593079900,'0001-01-01T01:02:00.1'],
  ]) expect(parseInputValue(type, source)).toEqual({value,text});
  for (const [type, values] of [
    ['date',['0000-01-01','999-01-01','1900-02-29','2000-02-30','2000-13-01','275760-09-14','999999999999999999-01-01']],
    ['month',['0000-01','2000-00','2000-13','2000-1','275760-10']],
    ['week',['2021-W53','2000-w01','2000-W00','2000-W54','275760-W38']],
    ['time',['24:00','23:60','23:59:60','01:02:03.1234','1:02','01:02:03.']],
    ['datetime-local',['2000-01-01  12:00','2000-01-01T12:00Z','2000-02-30T12:00','275760-09-13T00:00:00.001']],
  ]) for (const value of values) expect(parseInputValue(type,value)).toBeNull();
});

test('number values are strict while HTML attribute floating-point parsing consumes a prefix', () => {
  for (const [source, value] of [['0',0],['-0',-0],['.5',0.5],['-.5',-0.5],['1e+2',100],['1e-999',0]]) expect(parseInputNumber(source)).toBe(value);
  for (const value of ['', '+1','1.',' 1','1\n','1abc','0x10','NaN','Infinity','1e999']) expect(parseInputNumber(value)).toBeNull();
  // WHATWG parsing rules deliberately differ from this Chromium binary's
  // stricter handling of nonconforming min/max/step attributes.
  // https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#rules-for-parsing-floating-point-number-values
  for (const [source, value] of [[' +2junk',2],['2.',2],['2e',2],['2e+',2],['2e-1foo',0.2],['\t.5',0.5]]) expect(parseNumberAttribute(source)).toBe(value);
  for (const value of ['', 'any', '\u00a02', 'x2','Infinity','1e999']) expect(parseNumberAttribute(value)).toBeNull();
});

test('step arithmetic preserves decimal multiples, tiny steps and temporal scale factors', () => {
  for (const [value, base, step, scale, mismatch] of [
    [0.3,0.2,0.1,1,false],[3.6,0,0.003,1,false],[-12345678.9,0,1e-12,1,false],
    [17,0,3e-15,1,true],[2,1,2,1,true],[-259200000,-259200000,2,604800000,false],
    [86400000,0,1e308,86400000,true],[1,0,5e-324,1000,false],[0,0,1e308,86400000,false],
  ]) expect(inputStepMismatch(value,base,step,scale)).toBe(mismatch);
});

test('time numeric serialization is canonical while valid string values preserve their spelling', () => {
  const {window,document}=parseHTMLDocument('<input type=time>');
  try {
    const input=document.querySelector('input');
    for(const [number,text] of [[0,'00:00'],[43200000,'12:00'],[86340000,'23:59'],[3720100,'01:02:00.1'],[3723000,'01:02:03']]) {
      input.valueAsNumber=number;expect(input.value).toBe(text);
    }
    input.value='12:00:00.000';expect(input.value).toBe('12:00:00.000');
    input.value='01:02:00.100';expect(input.value).toBe('01:02:00.100');
  } finally {window.happyDOM.close();}
});

test('initial values, resets and type changes sanitize without corrupting dirty value state', () => {
  const {window,document}=parseHTMLDocument('<form><input type=date value=invalid><input type=month value=2001-01 max=2000-01><input type=number value=1abc></form>');
  try {
    const [date,month,number]=document.querySelectorAll('input');
    expect([date.value,month.value,number.value]).toEqual(['','2001-01','']);
    expect(month.validity.rangeOverflow).toBeTrue();expect(month[S.value]).toBeNull();
    month.setAttribute('value','2002-01');expect(month.value).toBe('2002-01');expect(month[S.value]).toBeNull();
    month.value='2003-01';month.defaultValue='2004-01';expect(month.value).toBe('2003-01');
    document.querySelector('form').reset();expect(month.value).toBe('2004-01');expect(month[S.value]).toBeNull();
    number.type='text';number.value='wrong';number.type='number';expect(number.value).toBe('');
    number.type='text';expect(number.value).toBe('');
    number.type='number';number.value='1e3';expect(number.validity.badInput).toBeFalse();
    number.setAttributeNS('urn:test','min','2000');expect(number.validity.rangeUnderflow).toBeFalse();
    number.setAttributeNS(null,'min','2000');expect(number.validity.rangeUnderflow).toBeTrue();
    const copy=month.cloneNode();expect(copy.value).toBe('2004-01');expect(copy.validity.rangeOverflow).toBeTrue();
  } finally {window.happyDOM.close();}
});

test('bounds and steps share typed values, content-attribute bases and midnight wrapping', () => {
  const {window,document}=parseHTMLDocument('<input>');
  try {
    const input=document.querySelector('input');
    const states = [
      [{type:'month',value:'2001-01',max:'2000-01'},[false,true,false]],
      [{type:'week',value:'2000-W01',min:'10000-W01'},[true,false,false]],
      [{type:'date',value:'10000-01-01',max:'9999-01-01'},[false,true,false]],
      [{type:'time',value:'13:00',min:'14:00',max:'12:00'},[true,true,false]],
      [{type:'time',value:'15:00',min:'14:00',max:'12:00'},[false,false,false]],
      [{type:'time',value:'12:00',min:'14:00',max:'12:00'},[false,false,false]],
      [{type:'number',value:'10',max:''},[false,false,false]],
      [{type:'number',value:'0.3',min:'0.2',step:'0.1'},[false,false,false]],
      [{type:'number',value:'1.1',step:'ANY'},[false,false,false]],
      [{type:'number',value:'1.1',step:' any'},[false,false,true]],
      [{type:'date',value:'1970-01-02',step:'2'},[false,false,true]],
      [{type:'week',value:'1970-W03',step:'2'},[false,false,false]],
      [{type:'week',value:'1970-W04',step:'2'},[false,false,true]],
      [{type:'datetime-local',value:'1970-01-01T12:03',step:'120'},[false,false,true]],
      [{type:'number',value:'1',step:''},[false,false,false]],
      [{type:'number',value:'1',step:'0'},[false,false,false]],
    ];
    for(const [attributes,expected] of states) {
      for(const name of input.getAttributeNames())input.removeAttribute(name);
      for(const [key,value] of Object.entries(attributes))if(key!=='value')input.setAttribute(key,value);
      input.value=attributes.value;
      expect([input.validity.rangeUnderflow,input.validity.rangeOverflow,input.validity.stepMismatch]).toEqual(expected);
      expect(input.value).toBe(attributes.value);
    }
    input.type='number';input.removeAttribute('min');input.setAttribute('step','2');input.setAttribute('value','1');input.value='3';
    expect(input.validity.stepMismatch).toBeFalse();input.value='4';expect(input.validity.stepMismatch).toBeTrue();
    input.setAttribute('min','0');expect(input.validity.stepMismatch).toBeFalse();
    input.removeAttribute('min');input.removeAttribute('value');input.setAttributeNS('urn:test','value','1');
    expect(input.validity.stepMismatch).toBeFalse();
    let invalid=0;input.addEventListener('invalid',()=>invalid++);void input.validity.valid;expect(invalid).toBe(0);
  } finally {window.happyDOM.close();}
});

test('date/time constraints update real page messages, forms and rendered validity', async () => {
  const host=new RendererHost();const run=source=>host.call('evaluate',source);
  try {
    await host.start();await host.call('loadDocument',{url:'https://typed-input.test/',contentType:'text/html',source:'<style>input:valid{color:green}input:invalid{color:red}</style><form id=f><input id=i type=time min=14:00 max=12:00 value=13:00></form>'});await host.call('whenLoaded');
    await run(`window.i=document.getElementById('i');window.f=document.getElementById('f');window.invalid=0;i.oninvalid=()=>invalid++`);
    expect(await run(`[i.value,i.validity.rangeUnderflow,i.validity.rangeOverflow,i.validationMessage!=='',getComputedStyle(i).color,invalid]`)).toEqual(['13:00',true,true,true,'rgb(255, 0, 0)',0]);
    expect(await run(`[i.checkValidity(),f.reportValidity(),invalid]`)).toEqual([false,false,2]);
    await run(`i.value='15:00'`);expect(await run(`[i.validity.valid,i.validationMessage,f.checkValidity(),getComputedStyle(i).color]`)).toEqual([true,'',true,'rgb(0, 128, 0)']);
    await run(`i.type='datetime-local';i.min='2024-03-10T02:00';i.max='2024-03-10T03:00';i.value='2024-03-10 02:30:00.000'`);
    expect(await run(`[i.value,i.validity.valid,f.reportValidity()]`)).toEqual(['2024-03-10T02:30',true,true]);
    await run(`i.type='month';i.min='';i.max='2000-01';i.value='2001-01'`);
    expect(await run(`[i.value,i.validity.rangeOverflow,i.validationMessage!=='']`)).toEqual(['2001-01',true,true]);
  } finally {host.close();}
},30000);
