import { test, expect } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';
import { setUserEditedValue } from '../lib/happy-dom/text-control-edit-state.js';
import { RendererHost } from '../lib/renderer/host.js';

test('text length validity distinguishes script values from actual user edits', () => {
  const { window, document } = parseHTMLDocument('<input><textarea></textarea>');
  try {
    for (const control of document.querySelectorAll('input,textarea')) {
      control.minLength = 5;control.defaultValue = 'abc';
      expect(control.validity.tooShort).toBeFalse();
      control.value = 'ab';expect(control.validity.tooShort).toBeFalse();
      setUserEditedValue(control, 'abc');expect(control.validity.tooShort).toBeTrue();
      expect(control.cloneNode(true).validity.tooShort).toBeTrue();
      control.defaultValue = 'different';expect(control.validity.tooShort).toBeTrue();
      control.value = control.value;
      expect(control.validity.tooShort).toBe(control.localName === 'textarea');
      control.value = 'x';expect(control.validity.tooShort).toBeFalse();
      control.dispatchEvent(new window.InputEvent('input',{bubbles:true}));
      expect(control.validity.tooShort).toBeFalse();
      setUserEditedValue(control, 'abc');
      control.setRangeText('abc',0,3);
      expect(control.validity.tooShort).toBe(control.localName === 'textarea');
      control.setRangeText('a',0,3);expect(control.validity.tooShort).toBeFalse();
      control.maxLength = 0;expect(control.validity.tooLong).toBeFalse();
      setUserEditedValue(control,'😀');expect(control.validity.tooLong).toBeTrue();
      control.maxLength = 2;expect(control.validity.tooLong).toBeFalse();
      control.minLength = 3;expect(control.validity.tooShort).toBeTrue();
      setUserEditedValue(control,'');expect(control.validity.tooShort).toBeFalse();
    }
  } finally { window.happyDOM.close(); }
});

test('length validity follows input type, reset cancellation, newline API values and failed setters', () => {
  const { window, document } = parseHTMLDocument('<form><input value="abc" minlength="5"><textarea minlength="5">xyz</textarea></form>');
  try {
    const form = document.querySelector('form');
    const input = document.querySelector('input'), textarea = document.querySelector('textarea');
    textarea.defaultValue='a\r\n😀';expect(textarea.value).toBe('a\n😀');
    textarea.textContent='b\rc';expect(textarea.value).toBe('b\nc');
    setUserEditedValue(input, '12');input.type='number';expect(input.validity.tooShort).toBeFalse();
    input.type='text';expect(input.validity.tooShort).toBeTrue();
    setUserEditedValue(textarea, 'a\r\n😀');
    expect(textarea.value).toBe('a\n😀');expect(textarea.validity.tooShort).toBeTrue();
    textarea.value = 'a\r\n😀';expect(textarea.validity.tooShort).toBeTrue();
    expect(() => {textarea.value = {toString(){throw new Error('conversion')}}}).toThrow('conversion');
    expect(textarea.validity.tooShort).toBeTrue();
    textarea.replaceChildren(document.createTextNode('default'));expect(textarea.validity.tooShort).toBeTrue();
    const cancel = event => event.preventDefault();form.addEventListener('reset',cancel);
    form.reset();expect(input.validity.tooShort).toBeTrue();expect(textarea.validity.tooShort).toBeTrue();
    form.removeEventListener('reset',cancel);form.reset();
    expect([input.value,textarea.value]).toEqual(['abc','default']);
    expect(input.validity.tooShort).toBeFalse();expect(textarea.validity.tooShort).toBeFalse();
  } finally { window.happyDOM.close(); }
});

test('real keyboard, paste and deletion update length validity before input handlers', async () => {
  let clipboard = '';
  const host = new RendererHost({clipboardRead:async()=>clipboard});
  const run = source => host.call('evaluate',source);
  try {
    await host.start();
    await host.call('loadDocument',{url:'https://edit-state.test/',contentType:'text/html',source:'<style>input:invalid,textarea:invalid{color:red}input:valid,textarea:valid{color:green}</style><form id=f><input id=i minlength=5><textarea id=t minlength=5></textarea></form>'});
    await host.call('whenLoaded');
    await run(`window.i=document.getElementById('i');window.t=document.getElementById('t');window.f=document.getElementById('f');window.changes=[];i.oninput=()=>changes.push(i.validity.tooShort);i.focus()`);
    await host.call('type','abc');
    expect(await run(`[i.value,i.validity.tooShort,changes,i.checkValidity(),i.reportValidity(),i.validationMessage!=='',f.checkValidity(),getComputedStyle(i).color]`)).toEqual(['abc',true,[true],false,false,true,false,'rgb(255, 0, 0)']);
    await run(`i.value=i.value`);
    expect(await run(`[i.validity.tooShort,i.validationMessage,getComputedStyle(i).color]`)).toEqual([false,'','rgb(0, 128, 0)']);
    await run(`i.onbeforeinput=e=>e.preventDefault()`);await host.call('type','x');
    expect(await run(`[i.value,i.validity.tooShort]`)).toEqual(['abc',false]);
    await run(`i.onbeforeinput=null;i.readOnly=true`);await host.call('type','x');
    expect(await run(`[i.value,i.validity.tooShort]`)).toEqual(['abc',false]);
    await run(`i.readOnly=false;i.disabled=true`);await host.call('type','x');
    expect(await run(`[i.value,i.validity.tooShort]`)).toEqual(['abc',false]);
    await run(`i.disabled=false;i.focus();i.value='';i.maxLength=0`);await host.call('type','x');
    expect(await run(`[i.value,i.validity.tooShort]`)).toEqual(['',false]);
    await run(`i.removeAttribute('maxlength');i.value='ab';i.setSelectionRange(2,2)`);await host.call('press','Delete');
    expect(await run(`i.validity.tooShort`)).toBeFalse();
    clipboard='';await host.call('press','v',{modifiers:2});await Bun.sleep(20);
    expect(await run(`i.validity.tooShort`)).toBeFalse();
    await host.call('press','Backspace');expect(await run(`[i.value,i.validity.tooShort]`)).toEqual(['a',true]);
    await run(`i.setCustomValidity('custom');i.disabled=true`);
    expect(await run(`[i.validity.tooShort,i.checkValidity(),i.validationMessage]`)).toEqual([true,true,'']);
    await run(`i.disabled=false;i.setCustomValidity('');i.oninput=()=>{i.value='x'}`);await host.call('type','b');
    expect(await run(`[i.value,i.validity.tooShort]`)).toEqual(['x',false]);
    await run(`t.oninput=()=>{t.defaultValue=t.value;t.replaceChildren(t.value)};t.focus()`);
    clipboard='a\r\n😀';await host.call('press','v',{modifiers:2});
    for(let n=0;n<30&&await run(`t.value===''`);n++)await Bun.sleep(10);
    expect(await run(`[t.value,t.value.length,t.validity.tooShort,t.validationMessage!=='']`)).toEqual(['a\n😀',4,true,true]);
    await run(`t.removeAttribute('minlength');t.maxLength=3`);
    expect(await run(`[t.validity.tooLong,t.checkValidity(),t.validationMessage!=='']`)).toEqual([true,false,true]);
    await run(`f.reset()`);
    expect(await run(`[t.value,t.validity.tooLong,t.validationMessage]`)).toEqual(['a\n😀',false,'']);
    for(const type of ['text','search','tel','url','email','password']) {
      await run(`i.type='${type}';i.oninput=()=>changes.push(i.validity.tooShort);changes=[];i.value='';i.minLength=5;i.focus()`);
      await host.call('type','abc');
      expect(await run(`[i.value,i.validity.tooShort,changes]`)).toEqual(['abc',true,[true]]);
    }
  } finally { host.close(); }
},30000);

test('beforeinput reentry edits the current value and cannot revive a canceled or inactive edit', async () => {
  const host = new RendererHost();const run = source => host.call('evaluate',source);
  try {
    await host.start();
    await host.call('loadDocument',{url:'https://beforeinput.test/',contentType:'text/html',source:'<input id=i minlength=5><textarea id=t maxlength=4></textarea>'});
    await host.call('whenLoaded');
    await run(`window.i=document.getElementById('i');window.t=document.getElementById('t');i.focus();i.value='abc';i.setSelectionRange(0,3)`);
    await host.call('type','abc');expect(await run(`[i.value,i.validity.tooShort]`)).toEqual(['abc',true]);
    await run(`i.value='abc';i.onbeforeinput=()=>{i.value='xy';i.setSelectionRange(1,1)}`);
    await host.call('type','z');expect(await run(`[i.value,i.validity.tooShort]`)).toEqual(['xzy',true]);
    for(const handler of ['t.focus()','i.readOnly=true','i.disabled=true']) {
      await run(`i.onbeforeinput=null;i.readOnly=false;i.disabled=false;i.value='abc';i.focus();i.setSelectionRange(0,3);i.onbeforeinput=()=>{${handler}}`);
      await host.call('type','z');expect(await run(`[i.value,i.validity.tooShort]`)).toEqual(['abc',false]);
    }
    await run(`i.onbeforeinput=null;i.disabled=false;i.readOnly=false;i.value='abc';i.focus();i.onbeforeinput=e=>{i.value='xy';e.preventDefault()}`);
    await host.call('type','z');expect(await run(`[i.value,i.validity.tooShort]`)).toEqual(['xy',false]);
    await run(`t.defaultValue='a\\r\\nb';t.focus();t.setSelectionRange(3,3)`);
    await host.call('type','cd');expect(await run(`[t.value,t.value.length]`)).toEqual(['a\nbc',4]);
  } finally { host.close(); }
},30000);
