import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {BindingRealm, installSelectSizeAccessor} from '../lib/renderer/bindings.js';
import {RendererHost} from '../lib/renderer/host.js';
import * as S from '../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

test('required selects distinguish the placeholder from other empty selections', () => {
  const {window, document} = parseHTMLDocument('<form><select required><option></option><option></option><optgroup><option></option></optgroup></select></form>');
  try {
    const select=document.querySelector('select'), form=document.querySelector('form');
    const validity=select.validity;
    expect(validity.valueMissing).toBeTrue();
    for (const index of [1,2]) {
      select.selectedIndex=index;
      expect(select.value).toBe(''); expect(validity.valueMissing).toBeFalse();
      expect(select.checkValidity()).toBeTrue();expect(form.matches(':valid')).toBeTrue();
    }
    select.selectedIndex=0;select.options[0].disabled=true;
    expect(validity.valueMissing).toBeTrue();
    select.options[0].value='chosen';expect(validity.valueMissing).toBeFalse();
    select.selectedIndex=-1;expect(validity.valueMissing).toBeTrue();
    select.required=false;expect(validity.valueMissing).toBeFalse();
    select.setAttributeNS('urn:foreign','required','');expect(validity.valueMissing).toBeFalse();
    select.required=true;select.disabled=true;
    expect(validity.valueMissing).toBeTrue();expect(select.checkValidity()).toBeTrue();
    expect(select.matches(':valid,:invalid')).toBeFalse();expect(form.matches(':valid')).toBeTrue();
    select.disabled=false;let invalid=0;
    select.addEventListener('invalid',event=>{invalid++;expect(event.cancelable).toBeTrue();expect(event.bubbles).toBeFalse();});
    expect(select.checkValidity()).toBeFalse();expect(select.reportValidity()).toBeFalse();expect(invalid).toBe(2);
  } finally {window.happyDOM.close();}
});

test('listboxes and optgroups accept empty values and still require a selection', () => {
  const {window,document}=parseHTMLDocument('');
  try {
    for(const mode of ['list','multiple','optgroup']) {
      const select=document.createElement('select');select.required=true;
      if(mode==='list')select.size=2;
      if(mode==='multiple')select.multiple=true;
      const option=document.createElement('option');
      if(mode==='optgroup'){const group=document.createElement('optgroup');group.append(option);select.append(group);}
      else select.append(option);
      if(mode!=='optgroup'){expect(option.selected).toBeFalse();expect(select.validity.valueMissing).toBeTrue();}
      option.selected=true;expect(select.validity.valueMissing).toBeFalse();
      option.disabled=true;expect(select.validity.valueMissing).toBeFalse();
      select.selectedIndex=-1;expect(select.validity.valueMissing).toBeTrue();
    }
  } finally {window.happyDOM.close();}
});

test('select size reflects unsigned conversion and updates selectedness after attribute changes', () => {
  const {window,document}=parseHTMLDocument('');
  try {
    const select=document.createElement('select');
    expect(select.size).toBe(0);
    for(const [text,expected] of [['  +2suffix',2],['0',0],['-1',0],['2147483647',2147483647],['2147483648',0],['\u00a02',0]]) {
      select.setAttribute('size',text);expect(select.size).toBe(expected);
    }
    for(const [number,expected] of [[2.9,2],[-1,0],[2147483648,0],[4294967298,2],[Infinity,0],[NaN,0]]) {
      select.size=number;expect(select.size).toBe(expected);expect(select.getAttributeNS(null,'size')).toBe(String(expected));
    }
    select.removeAttribute('size');select.setAttributeNS('urn:foreign','size','5');expect(select.size).toBe(0);
    select.size=2;select.append(document.createElement('option'));expect(select.selectedIndex).toBe(-1);
    select.getAttributeNodeNS(null,'size').value='1';expect(select.selectedIndex).toBe(0);
    select.size=2;select.selectedIndex=-1;select.removeAttributeNS(null,'size');expect(select.selectedIndex).toBe(0);
    select.selectedIndex=-1;
    for(const size of ['0','invalid','2147483648']) { select.setAttributeNS(null,'size',size);expect(select.selectedIndex).toBe(-1); }
    select.size=1;expect(select.selectedIndex).toBe(0);
    select.selectedIndex=-1;select.size=1;expect(select.selectedIndex).toBe(-1);
  } finally {window.happyDOM.close();}
});

test('placeholder detection crosses ordinary and foreign wrappers but stops at HTML optgroups', () => {
  const {window,document}=parseHTMLDocument('');
  try {
    for(const [namespace,name,missing] of [['http://www.w3.org/1999/xhtml','div',true],['urn:test','optgroup',true],['http://www.w3.org/1999/xhtml','optgroup',false]]) {
      const select=document.createElement('select'),wrapper=document.createElementNS(namespace,name),option=document.createElement('option');
      select.required=true;wrapper.append(option);select.append(wrapper);option.selected=true;
      expect(select.validity.valueMissing).toBe(missing);
    }
    const multiple=document.createElement('select');multiple.multiple=true;multiple.size=1;multiple.required=true;
    const option=document.createElement('option');multiple.append(option);option.selected=true;
    expect(multiple.validity.valueMissing).toBeFalse();
  } finally {window.happyDOM.close();}
});

test('size accessors brand-check and convert using their defining realm', () => {
  class PageError extends TypeError {}
  const {window,document}=parseHTMLDocument('<select></select>');
  const realm=new BindingRealm(window,{touch(){}});realm.inputValueIntrinsics={TypeError:PageError};
  const prototype={};installSelectSizeAccessor(prototype,realm);
  const api=Object.getOwnPropertyDescriptor(prototype,'size'),select=document.querySelector('select'),wrapper=realm.wrap(select);
  try {
    for(const bad of [null,undefined,{},new Proxy(wrapper,{}),realm.wrap(document.createElement('div'))]) {
      expect(()=>api.get.call(bad)).toThrow(PageError);
      expect(()=>api.set.call(bad,{valueOf(){throw 'not reached'}})).toThrow(PageError);
    }
    for(const bad of [Symbol(),1n,{valueOf(){return 1n}}]) expect(()=>api.set.call(wrapper,bad)).toThrow(PageError);
    const sentinel={};let caught;
    try{api.set.call(wrapper,{valueOf(){throw sentinel}})}catch(error){caught=error}
    expect(caught).toBe(sentinel);
    let conversions=0;api.set.call(wrapper,{valueOf(){conversions++;select.setAttribute('size','5');return 2}});
    expect([conversions,api.get.call(wrapper),select.getAttribute('size')]).toEqual([1,2,'2']);
  } finally {window.happyDOM.close();}
});

test('reinserting an already selected option gives it priority over the previous selection', () => {
  const {window,document}=parseHTMLDocument('');
  try {
    const select=document.createElement('select'),placeholder=document.createElement('option'),choice=document.createElement('option');
    select.required=true;choice.text='chosen';select.append(placeholder,choice);
    const assertState=(selected,missing)=>{
      expect([...select.options].map(option=>option.selected)).toEqual(selected);
      expect(select.validity.valueMissing).toBe(missing);
      expect(select.selectedOptions.length).toBe(1);
    };
    assertState([true,false],true);
    placeholder.remove();assertState([true],false);
    select.prepend(placeholder);assertState([true,false],true);
    const other=document.createElement('select');other.append(placeholder);
    assertState([true],false);select.insertBefore(placeholder,choice);assertState([true,false],true);
    select.multiple=true;choice.selected=true;
    select.append(placeholder);expect([...select.options].map(option=>option.selected)).toEqual([true,true]);
  } finally {window.happyDOM.close();}
});

test('pre-read options queries do not hide inserted options from selectedness', () => {
  const {window,document}=parseHTMLDocument('');
  try {
    for(const read of [s=>s.options.length,s=>s.value,s=>s.querySelectorAll('option'),s=>s.selectedOptions.length]) {
      const select=document.createElement('select'),option=document.createElement('option');
      const held=select.querySelectorAll('option');read(select);select.append(option);
      expect([select.selectedIndex,option.selected,held.length]).toEqual([0,true,0]);
      const other=document.createElement('option');other.text='choice';select.append(other);
      option.remove();read(select);select.prepend(option);
      expect([...select.options].map(o=>o.selected)).toEqual([true,false]);
    }
  } finally {window.happyDOM.close();}
});

test('repeated selection does not accumulate dead query-cache dependencies', () => {
  const {window,document}=parseHTMLDocument('<select><option>A</option><option>B</option></select>');
  try {
    const select=document.querySelector('select'),[first,second]=select.options;
    const nodes=[document,select,first,second],counts=nodes.map(node=>node[S.affectsCache].length);
    for(let i=0;i<1000;i++) (i%2?first:second).selected=true;
    expect(nodes.map(node=>node[S.affectsCache].length)).toEqual(counts);
    expect([select.selectedIndex,first.selected,second.selected]).toEqual([0,true,false]);
  } finally {window.happyDOM.close();}
});

test('nested option text and size mutations repaint validity styles without changing selection', async () => {
  const {loadGraphics}=await import('../lib/renderer/page-renderer.js');
  const {CanvasKit:kit}=await loadGraphics();
  const host=new RendererHost({timeout:20000}),run=source=>host.call('evaluate',source);
  try {
    await host.start();await host.call('resize',300,200,1);
    await host.call('loadDocument',{url:'https://select.test/',contentType:'text/html',source:'<style>body{margin:0}form{width:80px;height:80px}form:valid{background:green}form:invalid{background:red}select{width:100px}</style><form id=f><select id=s required><option id=o></option><option></option></select></form>'});
    await host.call('whenLoaded');
    await run(`window.s=document.getElementById('s');window.o=document.getElementById('o');window.n=document.createTextNode('');const span=document.createElement('span');span.append(n);o.append(span)`);
    const pixel=async()=>{
      const png=await host.call('screenshot',{format:'png'});
      const image=kit.MakeImageFromEncoded(Buffer.from(png,'base64'));
      try {return [...image.readPixels(50,50,{width:1,height:1,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB})];}
      finally{image.delete();}
    };
    const red=[255,0,0,255],green=[0,128,0,255];
    expect(await pixel()).toEqual(red);
    await run(`n.data='chosen'`);expect(await pixel()).toEqual(green);
    await run(`n.data=''`);expect(await pixel()).toEqual(red);
    await run(`s.size=2`);expect(await pixel()).toEqual(green);
    await run(`s.removeAttribute('size')`);expect(await pixel()).toEqual(red);
    await run(`s.selectedIndex=1`);expect(await pixel()).toEqual(green);
    expect(await run(`s.size`)).toBe(0);
  } finally {await host.close();}
},30000);
