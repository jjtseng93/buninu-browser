import { test, expect } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';
import { optionDisabled } from '../lib/happy-dom/form-disabled.js';
import { fixDisabledFocus } from '../lib/happy-dom/form-disabled-interaction.js';
import { inputClipboard } from '../lib/renderer/text-input.js';
import { sheetTraits } from '../lib/style/selector-traits.js';
import { RendererHost } from '../lib/renderer/host.js';

function page(source, run) {
  const { document, window } = parseHTMLDocument(source);
  try { run(document, window); } finally { window.happyDOM.close(); }
}

test('disabled selectors follow fieldset legends and DOM ancestry without changing reflected attributes', () => {
  page('<fieldset id=f disabled><legend id=a><input id=i></legend><legend id=b><input id=j></legend><input id=k><fieldset><legend><input id=l></legend></fieldset></fieldset><div id=d disabled tabindex=0></div>', document => {
    const get = id => document.getElementById(id), f = get('f');
    expect(['i','j','k','l'].map(id=>get(id).matches(':disabled'))).toEqual([false,true,true,true]);
    expect(['i','j','k','l'].map(id=>get(id).disabled)).toEqual([false,false,false,false]);
    expect(['i','j','k','l'].map(id=>get(id).willValidate)).toEqual([true,false,false,false]);
    f.insertBefore(get('b'),get('a'));
    expect(['i','j'].map(id=>get(id).matches(':disabled'))).toEqual([true,false]);
    f.disabled=false;
    expect(['i','j','k','l'].map(id=>get(id).matches(':enabled'))).toEqual([true,true,true,true]);
    expect(get('d').matches(':enabled,:disabled')).toBeFalse();
    const shadow = get('d').attachShadow({mode:'open'});shadow.innerHTML='<input>';
    f.append(get('d'));f.disabled=true;
    expect(shadow.firstChild.matches(':enabled')).toBeTrue();
    const foreign=document.createElementNS('urn:x','input');foreign.setAttribute('disabled','');
    expect(foreign.matches(':enabled,:disabled')).toBeFalse();
    get('j').setAttributeNS('urn:x','disabled','');f.disabled=false;
    expect(get('j').matches(':enabled')).toBeTrue();
  });
});

test('options distinguish selection disabledness from ancestor select actual disabledness', () => {
  page('<form><select id=s disabled><optgroup disabled><div><option id=a value=a>A</option></div></optgroup><option id=b value=b>B</option></select></form>',document=>{
    const s=document.getElementById('s'), a=document.getElementById('a'), b=document.getElementById('b');
    expect(s.value).toBe('b');expect(optionDisabled(a)).toBeTrue();expect(optionDisabled(b)).toBeFalse();
    expect(a.matches(':disabled')).toBeTrue();expect(b.matches(':disabled')).toBeTrue();
    s.disabled=false;expect(b.matches(':enabled')).toBeTrue();
    a.closest('optgroup').disabled=false;expect(a.matches(':enabled')).toBeTrue();
    a.closest('optgroup').disabled=true;s.value='a';document.querySelector('form').reset();expect(s.value).toBe('b');
    for(const barrier of ['select','hr','datalist','option']) {
      const group=document.createElement('optgroup'), wrapper=document.createElement(barrier), option=document.createElement('option');
      group.disabled=true;group.append(wrapper);wrapper.append(option);expect(optionDisabled(option)).toBeFalse();
    }
  });
});

test('disabled native controls block focus and click but preserve synthetic checkable activation', () => {
  page('<form><fieldset disabled><input id=i type=checkbox><input id=r type=radio><input id=t><button id=b type=reset></button><label for=i id=l>label</label></fieldset><input id=e><div disabled tabindex=0 id=d></div></form>',(document,window)=>{
    let resets=0;document.querySelector('form').addEventListener('reset',()=>resets++);
    for(const id of ['i','r','t','b']) {
      const input=document.getElementById(id);let clicks=0;input.addEventListener('click',()=>clicks++);
      input.focus();expect(document.activeElement===input).toBeFalse();input.click();expect(clicks).toBe(0);
      expect(input.dispatchEvent(new window.MouseEvent('click',{bubbles:true,cancelable:true}))).toBeTrue();
      expect(clicks).toBe(1);if(id==='i'||id==='r')expect(input.checked).toBeTrue();
    }
    const checkbox=document.getElementById('i');checkbox.checked=false;checkbox.indeterminate=true;
    const cancel=event=>event.preventDefault();checkbox.addEventListener('click',cancel);
    expect(checkbox.dispatchEvent(new window.MouseEvent('click',{bubbles:true,cancelable:true}))).toBeFalse();
    expect([checkbox.checked,checkbox.indeterminate]).toEqual([false,true]);checkbox.removeEventListener('click',cancel);
    let forwarded=0;checkbox.addEventListener('click',()=>forwarded++);
    document.getElementById('l').click();expect(forwarded).toBe(0);expect(checkbox.checked).toBeFalse();expect(resets).toBe(0);
    checkbox.disabled=true;checkbox.dispatchEvent(new window.MouseEvent('click'));expect(checkbox.checked).toBeTrue();
    const e=document.getElementById('e');e.focus();expect(document.activeElement===e).toBeTrue();
    e.disabled=true;fixDisabledFocus(document);expect(document.activeElement===e).toBeFalse();
    document.getElementById('d').focus();expect(document.activeElement===document.getElementById('d')).toBeTrue();
  });
});

test('synthetic activation rechecks listener changes to disabledness, type and label control', () => {
  page('<body></body>', (document, window) => {
    for (const tag of ['input', 'button']) for (const type of tag === 'button' ? ['reset', 'submit'] : ['checkbox', 'radio', 'reset', 'submit']) for (const initialDisabled of [true, false]) {
      const form=document.createElement('form'), fieldset=document.createElement('fieldset'), control=document.createElement(tag);
      control.type=type;fieldset.disabled=initialDisabled;form.append(fieldset);fieldset.append(control);document.body.append(form);
      const events=[];for(const type of ['reset','submit'])form.addEventListener(type,event=>{events.push(type);event.preventDefault()});
      control.addEventListener('click',()=>{fieldset.disabled=!initialDisabled;if(type==='checkbox'||type==='radio')control.type='reset'});
      control.dispatchEvent(new window.MouseEvent('click',{bubbles:true,cancelable:true}));
      expect(events).toEqual(initialDisabled?[type==='submit'?'submit':'reset']:[]);form.remove();
    }
    const label=document.createElement('label'), control=document.createElement('input');control.type='checkbox';label.append(control);document.body.append(label);
    control.disabled=true;const enable=event=>{if(event.target===label)control.disabled=false};label.addEventListener('click',enable);label.click();expect(control.checked).toBeTrue();
    label.removeEventListener('click',enable);control.checked=false;label.addEventListener('click',event=>{if(event.target===label)control.disabled=true});label.click();expect(control.checked).toBeFalse();
  });
});

test('readonly pseudo states use actual mutability and disabled styles opt into propagation', () => {
  page('<fieldset disabled><input id=i><textarea id=t></textarea><div contenteditable id=e></div></fieldset>', document=>{
    for(const id of ['i','t'])expect(document.getElementById(id).matches(':read-only')).toBeTrue();
    expect(document.getElementById('e').matches(':read-write')).toBeTrue();
    const i=document.getElementById('i');document.querySelector('fieldset').disabled=false;
    for(const type of ['text','email','password','number','date']){i.type=type;expect(i.matches(':read-write')).toBeTrue();}
    for(const type of ['checkbox','radio','button','range','color','file','hidden']){i.type=type;expect(i.matches(':read-only')).toBeTrue();}
    i.type='text';i.readOnly=true;expect(i.matches(':read-only')).toBeTrue();
    const foreign=document.createElementNS('http://www.w3.org/2000/svg','svg');foreign.setAttribute('contenteditable','true');
    document.body.append(foreign);expect(foreign.matches(':read-write')).toBeFalse();
    document.getElementById('e').append(foreign);foreign.setAttribute('contenteditable','false');expect(foreign.matches(':read-write')).toBeTrue();
  });
  expect(sheetTraits('@media(min-width:1px){fieldset:disabled input{color:red}}').controlState).toBeTrue();
  expect(sheetTraits(String.raw`input:read\2d write{color:red}`).controlState).toBeTrue();
  expect(sheetTraits('.a{content:":disabled"}').controlState).toBeFalse();
});

test('clipboard cannot complete an edit after a fieldset becomes disabled', async()=>{
  const {document,window}=parseHTMLDocument('<fieldset><input value=abc></fieldset>');
  try {
    const input=document.querySelector('input');input.setSelectionRange(0,3);let replaced=false,release;
    const pending=inputClipboard(input,'paste',{read:()=>new Promise(resolve=>release=resolve),replace:()=>replaced=true});
    document.querySelector('fieldset').disabled=true;release('new');await pending;expect(replaced).toBeFalse();
  } finally { window.happyDOM.close(); }
});

test('rendered inherited disabled states update CSS, focus, keyboard and primary pointer activation', async()=>{
  const host=new RendererHost({clipboardRead:async()=>'P'}),run=source=>host.call('evaluate',source);
  try {
    await host.start();await host.call('resize',500,400,1);
    await host.call('loadDocument',{url:'https://disabled.test/',contentType:'text/html',source:`<style>input,option,optgroup{color:black}input:enabled{color:green}input:disabled,option:disabled,optgroup:disabled{color:red}#f:has(input:disabled){border-width:7px}#f:has(input:enabled){background-color:blue}</style><fieldset id=f><legend id=l><input id=a></legend><legend id=m><input id=b></legend><input id=i><select id=s><optgroup id=g><option id=o>O</option></optgroup></select><button id=c type=button>C</button></fieldset>`});
    await host.call('whenLoaded');await run(`for(const id of ['f','l','m','a','b','i','s','g','o','c'])window[id]=document.getElementById(id);window.count=0;c.onclick=()=>count++;i.focus()`);
    await host.call('type','A');expect(await run('i.value')).toBe('A');
    await run('f.disabled=true');
    expect(await run(`[a,b,i,o,g].map(e=>getComputedStyle(e).color)`)).toEqual(['rgb(0, 128, 0)',...Array(4).fill('rgb(255, 0, 0)')]);
    expect(await run('document.activeElement===i')).toBeFalse();
    await host.call('type','X');expect(await run('i.value')).toBe('A');
    const bounds=await run('(()=>{const r=c.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()');
    await host.call('click',...bounds);expect(await run('count')).toBe(0);
    await run('f.insertBefore(m,l)');expect(await run(`[a,b].map(e=>getComputedStyle(e).color)`)).toEqual(['rgb(255, 0, 0)','rgb(0, 128, 0)']);
    await run('f.disabled=false;i.focus()');await host.call('press','v',{modifiers:2});
    for(let n=0;n<20&&await run('i.value!=="AP"');n++)await Bun.sleep(10);
    expect(await run('[i.value,i.matches(":read-write"),getComputedStyle(o).color]')).toEqual(['AP',true,'rgb(0, 0, 0)']);
    await run('i.onbeforeinput=()=>{f.disabled=true}');await host.call('type','Z');
    expect(await run('i.value')).toBe('AP');
    await run('i.onbeforeinput=null;f.disabled=false');
    await run('s.disabled=true');expect(await run('[o,g].map(e=>getComputedStyle(e).color)')).toEqual(['rgb(255, 0, 0)','rgb(255, 0, 0)']);
    await run('s.disabled=false');expect(await run('[o,g].map(e=>getComputedStyle(e).color)')).toEqual(['rgb(0, 0, 0)','rgb(0, 0, 0)']);
    await run(`const ns='http://www.w3.org/1999/xhtml';window.pf=document.createElementNS(ns,'h:fieldset');window.pi=document.createElementNS(ns,'h:input');pi.id='prefixed';pf.append(pi);document.body.append(pf);const st=document.createElement('style');st.textContent='[id=prefixed]{color:green}[id=prefixed]:disabled{color:red}';document.head.append(st)`);
    expect(await run('getComputedStyle(pi).color')).toBe('rgb(0, 128, 0)');
    await run('pf.disabled=true');expect(await run('getComputedStyle(pi).color')).toBe('rgb(255, 0, 0)');
    await run(`const legend=document.createElementNS('http://www.w3.org/1999/xhtml','h:legend');pf.append(legend);legend.append(pi)`);
    expect(await run('getComputedStyle(pi).color')).toBe('rgb(0, 128, 0)');
  } finally {host.close();}
},30000);
