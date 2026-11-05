import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {BindingRealm, installTextControlValueAccessors} from '../lib/renderer/bindings.js';
import {setUserEditedValue} from '../lib/happy-dom/text-control-edit-state.js';
import {chooseInputFiles} from '../lib/renderer/file-input.js';
import {RendererHost} from '../lib/renderer/host.js';

function fixture(source='') {
  const page=parseHTMLDocument(source),realm=new BindingRealm(page.window,{touch(){}});
  realm.inputValueIntrinsics={TypeError,DOMException};
  const prototypes=new Map([['HTMLInputElement',{}],['HTMLTextAreaElement',{}]]);
  installTextControlValueAccessors(prototypes,realm);
  const api=(tag,property)=>Object.getOwnPropertyDescriptor(prototypes.get(tag==='input'?'HTMLInputElement':'HTMLTextAreaElement'),property);
  return {...page,realm,api};
}

test('textarea defaults contain direct Text, with raw versus API newlines',()=>{
  const f=fixture('<textarea></textarea>');
  try {
    const t=f.document.querySelector('textarea');
    const span=f.document.createElement('span');span.textContent='excluded';
    t.append('A\r',span,f.document.createComment('excluded'),'\nB\rC\0');
    expect(t.textContent).toBe('A\rexcluded\nB\rC\0');
    expect(t.defaultValue).toBe('A\r\nB\rC\0');expect(t.value).toBe('A\nB\nC\0');
    span.firstChild.data='still excluded';expect(t.value).toBe('A\nB\nC\0');
    t.defaultValue='same';const old=t.firstChild;t.defaultValue='same';
    expect(t.firstChild).not.toBe(old);expect(old.parentNode).toBeNull();
    t.defaultValue='';expect(t.childNodes.length).toBe(0);
    t.defaultValue=null;expect(t.defaultValue).toBe('null');expect(t.value).toBe('null');
  } finally {f.window.happyDOM.close();}
});

test('text values retain dirty, reset, clone, selection and user-edit state',()=>{
  const f=fixture('<form><input value=default minlength=5><textarea minlength=5>default</textarea></form>');
  try {
    const form=f.document.querySelector('form');
    for(const node of form.querySelectorAll('input,textarea')) {
      const wrapper=f.realm.wrap(node),value=f.api(node.localName,'value'),def=f.api(node.localName,'defaultValue');
      value.set.call(wrapper,'abcdef');node.setSelectionRange(1,4,'backward');
      def.set.call(wrapper,'changed');expect(node.value).toBe('abcdef');
      expect([node.selectionStart,node.selectionEnd,node.selectionDirection]).toEqual([1,4,'backward']);
      value.set.call(wrapper,'abcdef');expect([node.selectionStart,node.selectionEnd]).toEqual([1,4]);
      value.set.call(wrapper,null);expect(node.value).toBe('');expect(node.defaultValue).toBe('changed');
      expect([node.selectionStart,node.selectionEnd]).toEqual([0,0]);
      def.set.call(wrapper,'next');expect(node.value).toBe('');
      const clone=node.cloneNode(true);expect(clone.value).toBe('');expect(clone.defaultValue).toBe('next');
      form.reset();expect(node.value).toBe('next');
      setUserEditedValue(node,'ab');expect(node.validity.tooShort).toBeTrue();
      def.set.call(wrapper,'longer default');expect(node.value).toBe('ab');expect(node.validity.tooShort).toBeTrue();
      value.set.call(wrapper,null);expect(node.validity.tooShort).toBeFalse();
      value.set.call(wrapper,undefined);expect(node.value).toBe('undefined');
      value.set.call(wrapper,{toString(){node.value='same';node.setSelectionRange(0,0);return 'same'}});
      expect(node.value).toBe('same');expect(node.selectionStart).toBe(0);
    }
  } finally {f.window.happyDOM.close();}
});

test('value descriptors enforce defining realm branding and conversion before file state',()=>{
  class AError extends TypeError {} class AException extends DOMException {}
  const a=fixture(),b=fixture('<input><textarea></textarea>');let aTouches=0,bTouches=0;
  a.realm.inputValueIntrinsics={TypeError:AError,DOMException:AException};
  const realmB=new BindingRealm(b.window,{touch(){bTouches++}}),realmA=new BindingRealm(a.window,{touch(){aTouches++}});
  realmA.inputValueIntrinsics=a.realm.inputValueIntrinsics;
  const prototypes=new Map([['HTMLInputElement',{}],['HTMLTextAreaElement',{}]]);installTextControlValueAccessors(prototypes,realmA);
  try {
    for(const tag of ['input','textarea']) {
      const raw=b.document.querySelector(tag),wrapper=realmB.wrap(raw);
      for(const property of ['value','defaultValue']) {
        const api=Object.getOwnPropertyDescriptor(prototypes.get(tag==='input'?'HTMLInputElement':'HTMLTextAreaElement'),property);
        for(const invalid of [undefined,null,{},prototypes.get('HTMLInputElement'),new Proxy(wrapper,{}),realmB.wrap(b.document.createElement(tag==='input'?'textarea':'input')),realmB.wrap(b.document.createElementNS('http://www.w3.org/2000/svg',tag))]) {
          expect(()=>api.get.call(invalid)).toThrow(AError);
          expect(()=>api.set.call(invalid,{toString(){throw 'conversion-before-brand'}})).toThrow(AError);
        }
        expect(()=>api.set.call(wrapper,Symbol())).toThrow(AError);
        let caught;const sentinel={};try{api.set.call(wrapper,{toString(){throw sentinel}})}catch(error){caught=error}expect(caught).toBe(sentinel);
        api.set.call(wrapper,123n);expect(api.get.call(wrapper)).toBe('123');
        api.set.call(wrapper,{toString(){return null}});expect(api.get.call(wrapper)).toBe('null');
      }
    }
    const input=b.document.querySelector('input'),wrapper=realmB.wrap(input),api=Object.getOwnPropertyDescriptor(prototypes.get('HTMLInputElement'),'value');
    expect(()=>api.set.call(wrapper,{toString(){input.type='file';return 'not empty'}})).toThrow(AException);
    api.set.call(wrapper,{toString(){input.type='text';return 'allowed'}});expect(input.value).toBe('allowed');
    expect(aTouches).toBe(0);expect(bTouches).toBe(9);
  } finally {a.window.happyDOM.close();b.window.happyDOM.close();}
});

test('null file value clears the selected FileList while preserving fakepath before clearing',async()=>{
  const f=fixture('<input type=file>');
  try {
    const node=f.document.querySelector('input'),wrapper=f.realm.wrap(node),api=f.api('input','value');let events=0;
    node.addEventListener('input',()=>events++);node.addEventListener('change',()=>events++);
    await chooseInputFiles(node,async()=>({accept:true,files:[{name:'chosen.txt',data:'WA==',type:'text/plain'}]}),f.window);
    expect(api.get.call(wrapper)).toBe('C:\\fakepath\\chosen.txt');expect(wrapper.files.length).toBe(1);expect(events).toBe(2);
    api.set.call(wrapper,null);expect(api.get.call(wrapper)).toBe('');expect(wrapper.files.length).toBe(0);expect(events).toBe(2);
  } finally {f.window.happyDOM.close();}
});

test('actual text control paint and editing follow null values and direct-child defaults',async()=>{
  let clipboard='';const host=new RendererHost({clipboardRead:async()=>clipboard});
  const run=source=>host.call('evaluate',source),shot=()=>host.call('screenshot',{format:'png'});
  try {
    await host.start();await host.call('loadDocument',{url:'https://text-values.test/',contentType:'text/html',source:'<style>input,textarea{display:block;width:200px;height:40px;font:20px monospace}</style><form id=f><input id=i placeholder=empty><textarea id=t placeholder=empty></textarea></form>'});await host.call('whenLoaded');
    await run(`window.i=document.getElementById('i');window.t=document.getElementById('t');window.f=document.getElementById('f');window.events=0;i.oninput=t.oninput=()=>events++`);
    const empty=await shot();await run(`i.value='null';t.value='null'`);expect(await shot()).not.toBe(empty);
    await run(`i.value=null;t.value=null`);expect(await shot()).toBe(empty);expect(await run('events')).toBe(0);
    await run(`f.reset();t.defaultValue='AB';`);const plain=await shot();
    await run(`window.span=document.createElement('span');span.textContent='HIDDEN';t.append(span)`);expect(await shot()).toBe(plain);
    await run(`span.firstChild.data='STILL HIDDEN'`);expect(await shot()).toBe(plain);
    await run(`t.firstChild.data='CHANGED'`);expect(await shot()).not.toBe(plain);
    await run(`t.defaultValue='AB';t.focus();t.setSelectionRange(1,1)`);await host.call('type','😀');
    expect(await run(`[t.value,t.selectionStart,t.selectionEnd]`)).toEqual(['A😀B',3,3]);
    await run(`t.value=null`);clipboard='x\r\ny';await host.call('press','v',{modifiers:2});
    for(let n=0;n<30&&await run(`t.value===''`);n++)await Bun.sleep(10);
    expect(await run(`[t.value,t.selectionStart,t.selectionEnd]`)).toEqual(['x\ny',3,3]);
    await run(`f.reset()`);expect(await run(`[i.value,t.value]`)).toEqual(['','AB']);
    expect(await run(`(()=>{const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;let a=false,b=false;try{s.call(i,Symbol())}catch(e){a=e instanceof TypeError}i.type='file';try{s.call(i,'x')}catch(e){b=e instanceof DOMException&&e.name==='InvalidStateError'}return [a,b]})()`)).toEqual([true,true]);
  } finally {await host.close();}
},30000);
