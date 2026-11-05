import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {optionText, optionDisplayLabel} from '../lib/happy-dom/option-values.js';
import {BindingRealm, installOptionValueAccessors} from '../lib/renderer/bindings.js';
import {RendererHost} from '../lib/renderer/host.js';

test('option text is HTML-aware DOM text with ASCII whitespace normalization', () => {
  const {window, document} = parseHTMLDocument('');
  try {
    const option = document.createElement('option');
    option.append(document.createTextNode('\t A\r'), document.createComment('ignored'), document.createTextNode('\n B \f'));
    expect([option.text, option.value, option.label]).toEqual(['A B', 'A B', 'A B']);
    option.text = '\u00a0\v\0A\u00a0\u00a0B\v\0\u00a0';
    expect(option.text).toBe('\u00a0\v\0A\u00a0\u00a0B\v\0\u00a0');
    option.text = 'start ';
    for (const [namespace, included] of [['http://www.w3.org/1999/xhtml',false],['http://www.w3.org/2000/svg',false],['http://www.w3.org/1998/Math/MathML',true],[null,true]]) {
      const script = document.createElementNS(namespace,'script');script.textContent = 'content ';option.append(script);
      expect(option.text.includes('content')).toBe(included);
      script.remove();
    }
    const image = document.createElement('img');image.alt=' alternate ';image.append(document.createTextNode('not image content'));
    option.append(image,document.createTextNode(' end'));
    expect(option.text).toBe('start end');expect(optionDisplayLabel(option)).toBe('start alternate end');
    image.setAttributeNS('urn:test','alt','foreign');image.removeAttributeNS(null,'alt');
    expect(optionDisplayLabel(option)).toBe('start end');
    const svgImage = document.createElementNS('http://www.w3.org/2000/svg','img');svgImage.append(document.createTextNode(' svg text '));option.append(svgImage);
    expect(option.text).toBe('start end svg text');
    // Read-only traversal does not mutate or depend on the computed display.
    option.style.display='none';expect(option.text).toBe('start end svg text');
    expect(optionText(option)).toBe(option.text);
  } finally {window.happyDOM.close();}
});

test('option label and value distinguish missing, empty and namespaced attributes', () => {
  const {window, document} = parseHTMLDocument('<select name=s><option>  some text </option></select>');
  try {
    const select = document.querySelector('select'), option = select.options[0];
    expect([option.label,option.value,select.value]).toEqual(['some text','some text','some text']);
    for (const name of ['label','value']) {
      option.setAttributeNS('urn:test',name,'foreign');expect(option[name]).toBe('some text');
      option[name]='';expect(option[name]).toBe('');expect(option.getAttributeNS('urn:test',name)).toBe('foreign');
      option[name]='  explicit \n ';expect(option[name]).toBe('  explicit \n ');
      option.removeAttributeNS(null,name);expect(option[name]).toBe('some text');
      option[name]=null;expect(option[name]).toBe('null');option.removeAttributeNS(null,name);
    }
    option.label='';expect(option.label).toBe('');expect(optionDisplayLabel(option)).toBe('some text');
    option.label=' untrimmed ';expect(optionDisplayLabel(option)).toBe(' untrimmed ');
    option.value='submitted';expect(select.value).toBe('submitted');expect(option.label).toBe(' untrimmed ');
    option.removeAttributeNS(null,'value');option.firstChild.data=' new\t text ';
    expect(select.value).toBe('new text');
  } finally {window.happyDOM.close();}
});

test('option text setter replaces children and keeps selection and explicit value', async () => {
  const {window, document} = parseHTMLDocument('<select><option selected value=fixed>text</option></select>');
  try {
    const option=document.querySelector('option'), before=option.firstChild, records=[];
    const observer=new window.MutationObserver(batch=>records.push(...batch));observer.observe(option,{childList:true,characterData:true,subtree:true});
    option.text='text';expect(option.firstChild).not.toBe(before);expect(before.data).toBe('text');expect(before.parentNode).toBeNull();
    option.text='a\nb';expect(option.childNodes.length).toBe(1);expect(option.firstChild.data).toBe('a\nb');expect(option.text).toBe('a b');
    expect(option.value).toBe('fixed');expect(option.selected).toBeTrue();
    option.text='';expect(option.childNodes.length).toBe(0);expect(option.text).toBe('');
    option.text=null;expect(option.text).toBe('null');
    await new Promise(resolve=>setTimeout(resolve,5));
    expect(records.length).toBeGreaterThan(0);expect(records.every(record=>record.type==='childList')).toBeTrue();observer.disconnect();
  } finally {window.happyDOM.close();}
});

test('option descriptors use defining-realm errors and receiver-realm mutations', () => {
  class ATypeError extends TypeError {}
  class BTypeError extends TypeError {}
  const a=parseHTMLDocument(''), b=parseHTMLDocument('<option>old</option>');
  let aTouches=0,bTouches=0;
  const realmA=new BindingRealm(a.window,{touch(){aTouches++}}),realmB=new BindingRealm(b.window,{touch(){bTouches++}});
  realmA.inputValueIntrinsics={TypeError:ATypeError};realmB.inputValueIntrinsics={TypeError:BTypeError};
  const prototype={};installOptionValueAccessors(prototype,realmA);
  try {
    const element=b.document.querySelector('option'), wrapper=realmB.wrap(element);
    for (const name of ['text','label','value']) {
      const api=Object.getOwnPropertyDescriptor(prototype,name);
      for (const invalid of [null,undefined,{},prototype,new Proxy(wrapper,{}),realmB.wrap(b.document.createElement('div')),realmB.wrap(b.document.createElementNS('http://www.w3.org/2000/svg','option'))]) {
        expect(()=>api.get.call(invalid)).toThrow(ATypeError);
        expect(()=>api.set.call(invalid,{toString(){throw 'must not convert'}})).toThrow(ATypeError);
      }
      expect(()=>api.set.call(wrapper,Symbol())).toThrow(ATypeError);
      const sentinel={};let caught;try{api.set.call(wrapper,{toString(){throw sentinel}})}catch(error){caught=error}expect(caught).toBe(sentinel);
      api.set.call(wrapper,null);expect(api.get.call(wrapper)).toBe('null');
      api.set.call(wrapper,{toString(){element.textContent='intermediate';return 'new text'}});expect(api.get.call(wrapper)).toBe('new text');
    }
    expect(aTouches).toBe(0);expect(bTouches).toBe(6);
  } finally {a.window.happyDOM.close();b.window.happyDOM.close();}
});

test('select rendering follows normalized option text, label mutations, alt text and no selection', async () => {
  const host=new RendererHost(),run=source=>host.call('evaluate',source),shot=()=>host.call('screenshot',{format:'png'});
  try {
    await host.start();await host.call('loadDocument',{url:'https://options.test/',contentType:'text/html',source:'<style>select{font:20px monospace;width:280px;height:40px}</style><select id=s><option id=o>A B</option></select>'});await host.call('whenLoaded');
    await run(`window.s=document.getElementById('s');window.o=document.getElementById('o');window.events=0;s.oninput=s.onchange=()=>events++`);
    const plain=await shot();await run(`o.text='  A\\t \\n B  '`);expect(await shot()).toBe(plain);
    await run(`o.text='A B';window.script=document.createElement('script');script.type='application/json';script.textContent='HIDDEN';o.append(script)`);expect(await shot()).toBe(plain);
    await run(`o.label='LABEL'`);const labeled=await shot();expect(labeled).not.toBe(plain);
    await run(`o.getAttributeNode('label').value='OTHER'`);expect(await shot()).not.toBe(labeled);
    await run(`o.label='';o.text='A B'`);expect(await shot()).toBe(plain);
    await run(`o.removeAttribute('label');o.text='A ';window.img=document.createElement('img');img.alt='ALT';o.append(img,' B')`);
    expect(await run(`[o.text,o.value,o.label,s.value]`)).toEqual(['A B','A B','A B','A B']);
    const withAlt=await shot();await run(`o.label='A ALT B'`);expect(await shot()).toBe(withAlt);
    await run(`o.removeAttribute('label');img.alt='NEXT'`);const nextAlt=await shot();expect(nextAlt).not.toBe(withAlt);
    await run(`o.label='A NEXT B'`);expect(await shot()).toBe(nextAlt);
    await run(`o.label='';o.text='FIRST';s.selectedIndex=-1`);const empty=await shot();
    await run(`s.removeChild(o)`);expect(await shot()).toBe(empty);
    expect(await run(`events`)).toBe(0);
    expect(await run(`(()=>{const p=Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype,'text');let rejected=false;try{p.set.call(o,Symbol())}catch(e){rejected=e instanceof TypeError}return [p.enumerable,p.configurable,rejected,'label' in document.createElement('div')]})()`)).toEqual([true,true,true,false]);
  } finally {await host.close();}
},30000);
