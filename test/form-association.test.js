import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {formControls} from '../lib/happy-dom/form-association.js';
import {htmlCollectionInterface} from '../lib/renderer/html-collection.js';
import {nodeListInterface} from '../lib/renderer/node-list.js';
import {formControlsInterface} from '../lib/renderer/form-controls.js';
import {RendererHost} from '../lib/renderer/host.js';

test('native form ownership and listed controls share exact attributes and tree order', () => {
  const {window, document:d} = parseHTMLDocument('<input id=before form=b><form id=a><input id=in form=b><input id=own><input type=image><fieldset id=fs><output id=out></output><object id=obj></object></fieldset></form><form id=b></form><input id=after form=b>');
  try {
    const a=d.getElementById('a'), b=d.getElementById('b'), input=d.getElementById('in'), list=b.elements;
    expect([...list].map(x=>x.id)).toEqual(['before','in','after']);
    expect(list).toBe(b.elements); expect(input.form).toBe(b);
    expect([...a.elements].map(x=>x.id)).toEqual(['own','fs','out','obj']);
    expect(a.length).toBe(4);
    b.id='changed'; expect(list.length).toBe(0); expect(input.form).toBeNull();
    input.removeAttribute('form'); expect(input.form).toBe(a);
    input.setAttributeNS('urn:test','form','changed'); expect(input.form).toBe(a);
    input.setAttributeNS(null,'form','changed'); expect(input.form).toBe(b); expect(list.length).toBe(1);
    const first=d.createElement('div'); first.id='changed'; d.body.prepend(first);
    expect(input.form === null).toBe(true); expect(list.length).toBe(0); first.remove();
    const shadow=d.body.appendChild(d.createElement('div')).attachShadow({mode:'open'});
    const form=d.createElement('form'), other=d.createElement('input'); form.id='changed'; other.setAttribute('form','changed'); shadow.append(form,other);
    expect(other.form).toBe(form); expect(formControls(form)).toEqual([other]); expect(list.length).toBe(1);
    form.id='elsewhere'; expect(other.form).toBeNull();
    const fieldset=d.getElementById('fs'), fields=fieldset.elements;
    expect([...fields].map(x=>x.id)).toEqual(['out','obj']);
    const image=d.createElement('input'); image.type='image'; fieldset.append(image);
    expect(fields.length).toBe(3); expect(a.elements.length).toBe(4);
    a.remove(); expect(d.getElementById('own')).toBeNull(); expect(a.querySelector('#own').form).toBe(a);
  } finally { window.happyDOM.close(); }
});

test('native activation, reset, labels and submission use the same reassociated owner', () => {
  const {window, document:d} = parseHTMLDocument('<form id=a><label for=field id=l></label><input id=field name=field value=original form=b><button id=submit form=b>Send</button><button id=reset type=reset form=b>Reset</button></form><form id=b></form><input name=outside value=ok form=b>');
  try {
    const a=d.getElementById('a'), b=d.getElementById('b'), input=d.getElementById('field');
    let owner=null, submitter=null, changes=0;
    for(const f of [a,b]) f.addEventListener('submit', e=>{e.preventDefault();owner=e.target;submitter=e.submitter;});
    input.addEventListener('change',()=>changes++);
    d.getElementById('submit').click(); expect(owner).toBe(b); expect(submitter).toBe(d.getElementById('submit'));
    expect(d.getElementById('l').form).toBe(b);
    expect([...new window.FormData(a)]).toEqual([]);
    expect([...new window.FormData(b)]).toEqual([['field','original'],['outside','ok']]);
    input.value='edited'; d.getElementById('reset').click(); expect(input.value).toBe('original'); expect(changes).toBe(0);
    input.required=true; input.value=''; expect(a.checkValidity()).toBe(true); expect(b.checkValidity()).toBe(false);
    input.removeAttribute('form'); expect(input.form).toBe(a); expect(a.checkValidity()).toBe(false); expect(b.checkValidity()).toBe(true);
  } finally { window.happyDOM.close(); }
});

test('native collection views retain live radio groups and standard collection prototypes', () => {
  const {window, document:d} = parseHTMLDocument('<form id=f><input type=checkbox name=g checked value=ignored><input type=radio name=g value=a><input type=radio name=g value=b><input name=constructor><input name=2></form>');
  try {
    const f=d.getElementById('f'), changes=[];
    const base=htmlCollectionInterface(), lists=nodeListInterface(), api=formControlsInterface({base,lists,wrap:x=>x,changed:x=>changes.push(x)});
    const c=api.create(f), radios=c.g;
    expect(c).toBe(api.create(f)); expect(c instanceof api.HTMLFormControlsCollection).toBe(true); expect(c instanceof base.HTMLCollection).toBe(true);
    expect(radios instanceof api.RadioNodeList).toBe(true); expect(radios instanceof lists.NodeList).toBe(true);
    expect(radios.value).toBe(''); radios.value='b'; expect(radios.value).toBe('b'); expect(f.querySelector('[value=a]').checked).toBe(false);
    expect(changes).toEqual([f.querySelector('[value=b]')]);
    expect(base.HTMLCollection.prototype.namedItem.call(c,'g')).toBe(radios[0]);
    expect(c.constructor).toBe(api.HTMLFormControlsCollection); expect(c.namedItem('constructor').name).toBe('constructor');
    expect(c[2].value).toBe('b'); expect(c.namedItem('2').name).toBe('2');
    const a=radios[1]; a.remove(); expect(radios.length).toBe(2);
    radios[0].remove(); expect(radios.length).toBe(1); expect(c.g).toBe(radios[0]);
    radios[0].name='moved'; expect(radios.length).toBe(0); expect(radios.value).toBe(''); expect(c.g).toBeUndefined();
    const unrelated=d.createElement('input'); unrelated.setAttributeNS('urn:test','name','g'); f.append(unrelated);
    expect(c.namedItem('g')).toBeNull();
    expect(()=>c.namedItem(Symbol())).toThrow(TypeError); expect(()=>c.namedItem()).toThrow(TypeError);
    expect(()=>new api.RadioNodeList()).toThrow(TypeError); expect(()=>new api.HTMLFormControlsCollection()).toThrow(TypeError);
  } finally { window.happyDOM.close(); }
});

test('native collection borrowed APIs keep receiver views and defining-realm conversion errors', () => {
  const {window, document:d} = parseHTMLDocument('<form><input name=g type=radio value=a><input name=g type=radio value=b></form>');
  try {
    class AError extends TypeError {} class BError extends TypeError {}
    const changes=[], create=(TypeError, label) => {
      const global=()=>({TypeError}),base=htmlCollectionInterface(global),lists=nodeListInterface(global);
      return formControlsInterface({base,lists,global,wrap:x=>x,changed:()=>changes.push(label)});
    };
    const a=create(AError,'a'),b=create(BError,'b'),form=d.querySelector('form'),collection=b.create(form);
    const named=a.HTMLFormControlsCollection.prototype.namedItem;
    const group=named.call(collection,'g');
    expect(group instanceof b.RadioNodeList).toBe(true); expect(group instanceof a.RadioNodeList).toBe(false);
    const descriptor=Object.getOwnPropertyDescriptor(a.RadioNodeList.prototype,'value');
    descriptor.set.call(group,'b'); expect(descriptor.get.call(group)).toBe('b'); expect(changes).toEqual(['b']);
    expect(()=>named.call({},'g')).toThrow(AError); expect(()=>named.call(collection,Symbol())).toThrow(AError);
    expect(()=>descriptor.get.call({})).toThrow(AError); expect(()=>descriptor.set.call(group,Symbol())).toThrow(AError);
    const sentinel={};let thrown;try{descriptor.set.call(group,{toString(){throw sentinel}})}catch(e){thrown=e}
    expect(thrown===sentinel).toBe(true);
    const first=group[0];first.checked=false;
    descriptor.set.call(group,{toString(){first.name='other';return 'a'}});
    expect(first.checked).toBe(false); expect(group.length).toBe(1);
    const last=group[0];last.remove();expect(descriptor.get.call(group)).toBe('');
  } finally {window.happyDOM.close();}
});

test('page form collections expose live groups, preserve owner branding and paint scripted checked state', async () => {
  const host=new RendererHost({timeout:20000});
  try {
    await host.start();
    await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:'<!doctype html><style>input:checked{background:red}input{background:blue}</style><form id=a><input id=x name=g type=radio value=a form=b><input id=y name=g type=radio value=b form=b><button id=send form=b>Send</button></form><form id=b></form>'});
    await host.call('whenLoaded');
    const initial=await host.call('screenshot',{format:'png'});
    await host.call('evaluate',`document.getElementById('b').elements.g.value='b'`);
    expect(await host.call('screenshot',{format:'png'})).not.toBe(initial);
    await host.call('evaluate',`document.getElementById('y').checked=false`);
    expect(await host.call('screenshot',{format:'png'})).toBe(initial);
    expect(await host.call('evaluate',`(() => {
      const a=document.getElementById('a'),b=document.getElementById('b'),x=document.getElementById('x'),y=document.getElementById('y');
      const c=b.elements,g=c.g, result=[x.form===b,c===b.elements,c instanceof HTMLFormControlsCollection,c instanceof HTMLCollection,g instanceof RadioNodeList,g instanceof NodeList,g.length,g.value];
      let events=0;for(const type of ['input','change'])b.addEventListener(type,()=>events++);
      g.value='b';result.push(y.checked,!x.checked,g.value,events,getComputedStyle(y).backgroundColor);
      x.remove();result.push(g.length,c.g===y);y.name='other';result.push(g.length,c.namedItem('g'));
      for(const [prototype,key,receiver] of [[HTMLInputElement.prototype,'form',document.createElement('button')],[HTMLFormElement.prototype,'elements',{}],[HTMLFieldSetElement.prototype,'elements',b]]) {
        try{Object.getOwnPropertyDescriptor(prototype,key).get.call(receiver)}catch(e){result.push(e instanceof TypeError)}
      }
      try{Object.getOwnPropertyDescriptor(RadioNodeList.prototype,'value').set.call({},'b')}catch(e){result.push(e instanceof TypeError)}
      try{HTMLFormControlsCollection.prototype.namedItem.call(document.forms,'b')}catch(e){result.push(e instanceof TypeError)}
      let target=null;b.onsubmit=e=>{e.preventDefault();target=e.target};document.getElementById('send').click();result.push(target===b);
      return result;
    })()`)).toEqual([true,true,true,true,true,true,2,'',true,true,'b',0,'rgb(255, 0, 0)',1,true,0,null,true,true,true,true,true,true]);
  } finally { await host.close(); }
});
