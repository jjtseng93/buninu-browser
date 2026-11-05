import {beforeAll, afterAll, test, expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';

let host;
beforeAll(async () => {
  host = new RendererHost({timeout:20000});
  await host.start();
  await host.call('loadDocument', {url:'https://test.local/',contentType:'text/html',source:'<!doctype html><body></body>'});
  await host.call('whenLoaded');
});
afterAll(() => host?.close());
const evaluate = source => host.call('evaluate', source);

test('select operations preserve option groups, identity and surrounding children', async () => {
  expect(await evaluate(`(() => {
    const s=document.createElement('select');s.innerHTML='<option id=a>A</option><optgroup label=g><option id=b>B</option></optgroup><!--keep-->';
    const a=s.options[0],b=s.options[1],group=b.parentNode,comment=s.lastChild;
    const x=new Option('X'),z=new Option('Z');s.add(x,1);s.options.add(z,group);
    const result=[x.parentNode===group,s.options.length,[...s.options].map(o=>o.textContent).join(''),s.lastChild===comment];
    s.add(group,group);s.options.remove(2);result.push(x.parentNode===null,b.parentNode===group,s.children[2]===group);
    s.add(x,-1);result.push(x.parentNode===s,s.lastChild===x,comment.parentNode===s);
    for(const ref of [document.createElement('option'),s]) {try{s.add(new Option('bad'),ref)}catch(e){result.push(e.name)}}
    for(const value of [null,document.createElement('div'),{}]) {try{s.add(value)}catch(e){result.push(e instanceof TypeError)}}
    return result;
  })()`)).toEqual([true,4,'AZXB',true,true,true,true,true,true,true,'NotFoundError','NotFoundError',true,true,true]);
});

test('options are live typed collections, with writable indices and bounded length', async () => {
  expect(await evaluate(`(() => {
    const s=document.createElement('select');s.innerHTML='<optgroup><option id=old>old</option><option name=n>next</option></optgroup>';
    const options=s.options,group=s.firstChild,result=[options===s.options,options instanceof HTMLOptionsCollection,options instanceof HTMLCollection,options.constructor===HTMLOptionsCollection];
    options[0]=new Option('new');result.push(group.firstChild===options[0]);
    options[1]=null;result.push(options.length,group.children.length);
    options[3]=new Option('last');result.push([...options].map(o=>o.textContent).join('|'),options[3].parentNode===s);
    options.length=2;result.push(s.length,group.parentNode===s);
    s.length=4;result.push(options.length,options[3].attributes.length,options[3].prefix);
    options.length=100001;result.push(options.length);options.length=-1;result.push(options.length);
    options[100001]=new Option('too far');result.push(options.length);
    s.length=0;result.push(options.length,group.parentNode===s);
    try{options.add()}catch(e){result.push(e instanceof TypeError)}
    try{options.remove()}catch(e){result.push(e instanceof TypeError)}
    try{new HTMLOptionsCollection()}catch(e){result.push(e instanceof TypeError)}
    const marker={};try{options.length={valueOf(){throw marker}}}catch(e){result.push(e===marker)}
    try{options.selectedIndex=1n}catch(e){result.push(e instanceof TypeError)}
    return result;
  })()`)).toEqual([true,true,true,true,true,1,1,'new|||last',true,2,true,4,0,null,4,4,4,0,true,true,true,true,true,true]);
});

test('selectedOptions retains one live HTMLCollection across value, index and reset changes', async () => {
  expect(await evaluate(`(() => {
    const form=document.createElement('form'),s=document.createElement('select');s.innerHTML='<option value=a selected>A</option><option value=b>B</option>';form.append(s);document.body.append(form);
    const chosen=s.selectedOptions,result=[chosen===s.selectedOptions,chosen.constructor===HTMLCollection,chosen.item(0)===s.options[0]];
    s.options.selectedIndex=1;result.push(chosen.item(0)===s.options[1],chosen===s.selectedOptions);
    s.value='a';result.push(chosen.item(0)===s.options[0]);
    s.selectedIndex=-1;result.push(chosen.length,chosen.item(0));form.reset();result.push(chosen.length,chosen.item(0)===s.options[0]);
    form.remove();return result;
  })()`)).toEqual([true,true,true,true,true,true,0,null,1,true]);
});

test('select item/namedItem and remove overloads retain ordinary Element remove semantics', async () => {
  expect(await evaluate(`(() => {
    const div=document.createElement('div'),s=document.createElement('select');div.append(s);
    s.innerHTML='<option name=n>N</option><option id=i>I</option>';
    const result=[s.item(0)===s.options[0],s.namedItem('i')===s.options[1],s.namedItem('n')===s.options[0],s.namedItem(''),s.n===undefined];
    s.remove(-1);s.remove(20);result.push(s.length,s.parentNode===div);s.remove(0);result.push(s.length,s.item(0).id,s.parentNode===div);
    Element.prototype.remove.call(s,0);result.push(s.parentNode,s.length);div.append(s);s.remove();result.push(s.parentNode,s.length);
    return result;
  })()`)).toEqual([true,true,true,null,true,2,true,1,'i',true,null,1,null,1]);
});

test('select native getters ignore overridden collection methods and namespaced attributes', async () => {
  expect(await evaluate(`(() => {
    const s=document.createElement('select');s.length=2;
    s.options[0].setAttributeNS('urn:example','id','fake');s.options[1].id='real';
    const result=[s.options.namedItem('fake')===null,s.selectedOptions.length];
    s.options.item=()=>null;s.options.namedItem=()=>null;
    result.push(s.item(0)===s.options[0],s.namedItem('real')===s.options[1]);
    s.selectedIndex=1;result.push(s.selectedOptions.item(0)===s.options[1]);
    return result;
  })()`)).toEqual([true,1,true,true,true]);
});

test('option mutations invalidate rendered select validity styles', async () => {
  expect(await evaluate(`(() => {
    const style=document.createElement('style');style.textContent='select:valid {color:rgb(0,128,0)} select:invalid {color:rgb(255,0,0)}';document.head.append(style);
    const s=document.createElement('select');s.required=true;s.append(new Option('Choose',''),new Option('Valid','ok'));document.body.append(s);
    const color=()=>getComputedStyle(s).color,result=[color()];
    s.options.selectedIndex=1;result.push(color());s.options.remove(1);result.push(color());
    s.options[0]=new Option('Valid','ok');result.push(color());s.remove();style.remove();return result;
  })()`)).toEqual(['rgb(255, 0, 0)','rgb(0, 128, 0)','rgb(255, 0, 0)','rgb(0, 128, 0)']);
});

test('native select mutation keeps optgroups instead of flattening them', () => {
  const {window,document}=parseHTMLDocument('<select><optgroup label=x><option>A</option><option>B</option></optgroup></select>');
  try {
    const select=document.querySelector('select'),group=select.firstChild,option=document.createElement('option');
    select.add(option,1);expect(option.parentNode).toBe(group);
    select.remove(0);expect(group.parentNode).toBe(select);expect(group.children.length).toBe(2);
    select.add(document.createElement('optgroup'));expect(select.children.length).toBe(2);
    expect(group.children.length).toBe(2);
  } finally {window.happyDOM.close();}
});

test('selected options with gaps retain the last selected node, not a selected-count index', () => {
  const {window,document}=parseHTMLDocument('<select><option>A</option><option>B</option><option id=chosen selected>C</option></select>');
  try {
    const select=document.querySelector('select');
    expect(select.selectedIndex).toBe(2);
    expect(select.selectedOptions.namedItem('chosen')).toBe(select.options[2]);
    expect(Array.from(select.options,option=>option.selected)).toEqual([false,false,true]);
  } finally {window.happyDOM.close();}
});

test('zero display size and multiple option mutations keep selected indices current', async () => {
  expect(await evaluate(`(() => {
    const result=[];
    for(const size of ['', '0', '1', '2', '-1']) {
      const s=document.createElement('select');if(size!=='')s.setAttribute('size',size);
      s.add(new Option('a'));s.add(new Option('b'));result.push(s.selectedIndex);
    }
    const m=document.createElement('select');m.multiple=true;
    m.innerHTML='<option>a</option><option selected>b</option><option selected>c</option>';
    result.push(m.selectedIndex);m.insertBefore(new Option('first'),m.firstChild);result.push(m.selectedIndex);
    m.options[2].selected=false;result.push(m.selectedIndex);m.remove(0);result.push(m.selectedIndex);
    m.options[2].selected=false;result.push(m.selectedIndex);return result;
  })()`)).toEqual([0,0,0,-1,0,1,2,3,2,-1]);
});

test('assigning an option to its own index retains native replacement mutations', async () => {
  expect(await evaluate(`(() => {
    const s=document.createElement('select');s.innerHTML='<option>a</option><option>b</option>';
    const option=s.options[0],observer=new MutationObserver(()=>{});observer.observe(s,{childList:true});
    s.options[0]=option;
    const result=observer.takeRecords().map(r=>[r.addedNodes.length,r.removedNodes.length]);observer.disconnect();
    return [s.options[0]===option,s.options.length,result];
  })()`)).toEqual([true,2,[[0,1],[1,0]]]);
});
