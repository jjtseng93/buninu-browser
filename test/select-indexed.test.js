import {beforeAll, afterAll, test, expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

let host;
beforeAll(async () => {
  host = new RendererHost({timeout:20000});
  await host.start();
  await host.call('loadDocument', {url:'https://select.test/',contentType:'text/html',source:'<!doctype html><body></body>'});
  await host.call('whenLoaded');
});
afterAll(() => host?.close());
const evaluate = source => host.call('evaluate', source);

test('select indices share option operations while preserving groups, surrounding nodes and identity', async () => {
  expect(await evaluate(`(() => {
    const s=document.createElement('select');s.innerHTML='<option>A</option><optgroup><option>B</option></optgroup><!--keep-->';
    const group=s.children[1],comment=s.lastChild,a=s[0],b=s[1];
    const out=[s[0]===s.item(0),s[1]===s.options[1],s[2]===undefined,0 in s,2 in s,s[1].parentElement===group];
    s[0]=new Option('X');s[3]=new Option('Z');
    out.push([...s].map(o=>o.text).join('|'),s.options[0]===s[0],s[1]===b,s[1].parentElement===group,a.parentNode,comment.parentNode===s);
    s[1]=null;out.push(s.length,group.children.length,group.parentNode===s,s[2].text);
    s[1]=undefined;out.push(s.length,s[1].text);
    s.options.item=()=>null;s.item=()=>null;out.push(s[0].text,s[0]===s.options[0]);
    return out;
  })()`)).toEqual([true,true,true,true,false,true,'X|B||Z',true,true,true,null,true,3,0,true,'Z',2,'Z','X',true]);
});

test('indexed element wrappers retain Node methods, event receiver and borrowed accessors', async () => {
  expect(await evaluate(`(() => {
    const s=document.createElement('select'),o=new Option('A');document.body.appendChild(s);s.appendChild(o);
    const out=[s===document.querySelector('select'),o.parentNode===s,s.ownerDocument===document,s.nodeType,s.nodeName,s.isConnected,
      s.contains(o),s.getRootNode()===document,Node.prototype.hasChildNodes.call(s),s instanceof HTMLSelectElement,s[Symbol.iterator]===Array.prototype.values];
    s.addEventListener('probe',function(e){out.push(this===s,e.target===s,e.currentTarget===s)});s.dispatchEvent(new Event('probe'));
    const clone=s.cloneNode(true);out.push(clone!==s,clone[0]!==o,clone[0].text,clone.isEqualNode(s));
    Node.prototype.removeChild.call(s,o);out.push(s.length,o.parentNode);s.remove();out.push(s.isConnected);
    return out;
  })()`)).toEqual([true,true,true,1,'SELECT',true,true,true,true,true,true,true,true,true,true,true,'A',true,0,null,false]);
});

test('select virtual descriptors stay live and distinguish index names from expandos', async () => {
  expect(await evaluate(`(() => {
    const s=document.createElement('select');s.length=2;s[0].id='named';
    const d=Object.getOwnPropertyDescriptor(s,'0'),out=[d.value===s.options[0],d.writable,d.enumerable,d.configurable,
      Object.keys(s).filter(k=>/^\\d+$/.test(k)).join(','),Reflect.deleteProperty(s,'0'),Reflect.deleteProperty(s,'5'),s.named===undefined];
    s['01']='leading';s['-1']='negative';s['4294967295']='max';s.extra='ok';
    out.push(s['01'],s['-1'],s['4294967295'],s.extra,s.length);
    const option=new Option('defined');Object.defineProperty(s,'1',{value:option,configurable:true});out.push(s[1]===option);
    const derived=Object.create(s);derived[0]='own';out.push(derived[0],s[0].id);
    s.length=0;out.push(Object.getOwnPropertyDescriptor(s,'0')===undefined,0 in s,s[0]===undefined);return out;
  })()`)).toEqual([true,true,true,true,'0,1',false,true,true,'leading','negative','max','ok',2,true,'own','named',true,false,true]);
});

test('select indexed writes validate wrapped options before mutation and reject unrelated nodes', async () => {
  expect(await evaluate(`(() => {
    const s=document.createElement('select');s.append(new Option('keep'));
    const first=s[0],out=[];
    for(const v of [{},document.createElement('div'),document.createTextNode('x'),document.createElement('optgroup'),1,'x']) {
      try{s[0]=v}catch(e){out.push(e instanceof TypeError,s[0]===first,s.length===1)}
    }
    s[100001]=new Option('beyond');out.push(s.length,s[0]===first);
    const other=document.implementation.createHTMLDocument('other'),option=other.createElement('option');
    option.text='adopted';s[0]=option;out.push(option===s[0],option.ownerDocument===document,option.parentNode===s);
    return out;
  })()`)).toEqual([...Array(18).fill(true),1,true,true,true,true]);
});

test('removing multiple retains the first selected option through property and attribute APIs', async () => {
  expect(await evaluate(`(() => {
    const out=[];
    for(const remove of [s=>s.multiple=false,s=>s.removeAttribute('multiple'),s=>s.toggleAttribute('multiple',false),s=>s.removeAttributeNode(s.getAttributeNode('multiple'))]) {
      const s=document.createElement('select');s.multiple=true;s.length=4;
      const selected=s.selectedOptions;s.options[2].selected=true;s.options[1].selected=true;
      remove(s);out.push(s.selectedIndex,selected.length,selected[0]===s[1]);
    }
    const s=document.createElement('select');s.length=2;s.multiple=true;s.selectedIndex=-1;
    s.setAttribute('multiple','again');out.push(s.selectedIndex);s.setAttributeNS('urn:other','multiple','');s.removeAttributeNS('urn:other','multiple');out.push(s.selectedIndex);
    s.multiple=false;out.push(s.selectedIndex);s.selectedIndex=-1;s.multiple=false;out.push(s.selectedIndex);
    s.size=3;s.multiple=true;s.selectedIndex=-1;s.multiple=false;out.push(s.selectedIndex);
    return out;
  })()`)).toEqual([1,1,true,1,1,true,1,1,true,1,1,true,-1,-1,0,-1,-1]);
});


test('select element caches and click guard use backing slots without changing author receivers', async () => {
  expect(await evaluate(`(() => {
    const s=document.createElement('select'),out=[];s.append(new Option('A'));
    for(const name of ['style','classList','dataset','attributes','validity']) out.push(s[name]===s[name]);
    s.style='color:red';s.classList='one';s.dataset.answer='42';
    out.push(s.style.color,s.className,s.getAttribute('data-answer'),s.attributes.getNamedItem('style').ownerElement===s,s.validity.valid);
    let calls=0,receiver; s.addEventListener('click',function(){calls++;receiver=this;s.click()});s.click();s.click();
    out.push(calls,receiver===s);
    Object.defineProperty(s,'author',{get(){return this},set(v){this.saved=v},configurable:true});
    const derived=Object.create(s);derived.author=12;out.push(s.author===s,derived.author===derived,derived.saved,s.saved===undefined);
    const get=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'style')?.get ?? Object.getOwnPropertyDescriptor(Element.prototype,'style').get;
    out.push(get.call(s)===s.style);
    for(const receiver of [{},derived]) {try{get.call(receiver);out.push(false)}catch(e){out.push(e instanceof TypeError)}}
    return out;
  })()`)).toEqual([true,true,true,true,true,'red','one','42',true,true,2,true,true,true,12,true,true,true,true]);
});
