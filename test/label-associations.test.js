import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {labelCollectionQuery} from '../lib/happy-dom/label-associations.js';
import {RendererHost} from '../lib/renderer/host.js';

test('label controls use exact attributes and the first labelable node in the same DOM tree', () => {
  const {window, document} = parseHTMLDocument('<label id=l><input id=i></label>');
  try {
    const label = document.getElementById('l'), input = document.getElementById('i');
    expect(label.control).toBe(input);
    label.htmlFor = 'missing'; expect(label.control).toBeNull();
    label.htmlFor = ''; expect(label.control).toBeNull();
    label.removeAttribute('for'); input.id = 'a" b]#'; label.htmlFor = input.id;
    expect(label.control).toBe(input);
    const duplicate = document.createElement('b'); duplicate.id = input.id; document.body.prepend(duplicate);
    expect(label.control).toBeNull(); duplicate.remove();
    input.setAttributeNS(null, 'type', 'HIDDEN'); expect(label.control).toBeNull();
    input.type = 'text'; input.disabled = true; input.hidden = true; expect(label.control).toBe(input);
    label.removeAttribute('for'); label.setAttributeNS('urn:foreign', 'for', 'missing'); expect(label.control).toBe(input);
    label.htmlFor = input.id; expect(label.getAttributeNS(null, 'for')).toBe(input.id);
    expect(label.getAttributeNS('urn:foreign', 'for')).toBe('missing');
    const detached = document.createElement('div'); detached.innerHTML = '<label for=x></label><input id=x>';
    expect(detached.firstChild.control).toBe(detached.lastChild);
    detached.id = 'x'; expect(detached.firstChild.control).toBeNull();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'input'); svg.id = input.id;
    document.body.prepend(svg); expect(label.control).toBeNull();
  } finally { window.happyDOM.close(); }
});

test('label form follows the associated control owner, with no form for meter or progress', () => {
  const {window, document} = parseHTMLDocument('<form id=a><label id=l for=i></label><input id=i form=b></form><form id=b></form>');
  try {
    const label = document.getElementById('l'), input = document.getElementById('i'), a = document.getElementById('a'), b = document.getElementById('b');
    expect(label.form).toBe(b);
    label.setAttribute('form', 'a'); expect(label.form).toBe(b);
    input.setAttribute('form', 'missing'); expect(label.form).toBeNull();
    input.removeAttribute('form'); expect(label.form).toBe(a);
    input.setAttributeNS('urn:foreign', 'form', 'b'); expect(label.form).toBe(a);
    for (const type of ['meter', 'progress']) {
      const control = document.createElement(type); control.id = type; control.form = b;
      a.append(control); label.htmlFor = type; expect(label.control).toBe(control); expect(label.form).toBeNull();
    }
    label.htmlFor = 'missing'; expect(label.form).toBeNull();
  } finally { window.happyDOM.close(); }
});

test('live label query identity survives hidden state, DOM mutation, shadow roots and adoption', () => {
  const {window, document} = parseHTMLDocument('<label id=a><label id=b><input id=i></label></label><label id=c for=i></label>');
  try {
    const input = document.getElementById('i'), a = document.getElementById('a'), b = document.getElementById('b'), c = document.getElementById('c');
    const query = labelCollectionQuery(input); expect(query()).toEqual([a,b,c]);
    c.remove(); expect(query()).toEqual([a,b]); document.body.prepend(c); expect(query()).toEqual([c,a,b]);
    b.htmlFor = 'missing'; expect(query()).toEqual([c,a]); b.removeAttribute('for');
    input.type = 'hidden'; expect(query()).toEqual([]); expect(labelCollectionQuery(input)).toBeNull();
    input.type = 'checkbox'; expect(labelCollectionQuery(input)).toBe(query);
    const host = document.createElement('div'); document.body.append(host); const shadow = host.attachShadow({mode:'open'});
    shadow.innerHTML = '<label id=s for=i></label>'; shadow.append(input);
    expect(query()).toEqual([shadow.firstChild]); expect(c.control).toBeNull();
    const other = document.implementation.createHTMLDocument('other'); other.body.innerHTML = '<label id=o for=i></label>';
    other.body.append(other.adoptNode(input)); expect(query()).toEqual([other.getElementById('o')]);
    const empty = document.createElement('input'); expect(labelCollectionQuery(empty)()).toEqual([]);
  } finally { window.happyDOM.close(); }
});

test('page label APIs expose wrapped nodes and live SameObject NodeLists and share click targeting', async () => {
  const host = new RendererHost(), run = source => host.call('evaluate', source);
  try {
    await host.start(); await host.call('loadDocument', {url:'https://labels.test/', contentType:'text/html', source:'<form id=f><label id=l for=i>check</label><input id=i type=checkbox></form><div id=d></div>'});
    await host.call('whenLoaded');
    await run(`window.i=document.getElementById('i');window.l=document.getElementById('l');window.list=i.labels`);
    expect(await run(`[l.control===i,l.form===document.getElementById('f'),list instanceof NodeList,list===i.labels,list.length,list[0]===l]`)).toEqual([true,true,true,true,1,true]);
    expect(await run(`(()=>{l.remove();const a=list.length;document.body.append(l);return[a,list.length,list[0]===l]})()`)).toEqual([0,1,true]);
    expect(await run(`(()=>{i.type='hidden';const a=[i.labels===null,list.length];i.type='text';return [...a,i.labels===list,list.length]})()`)).toEqual([true,0,true,1]);
    expect(await run(`(()=>{i.id='other';const a=list.length;l.htmlFor='other';return[a,list.length]})()`)).toEqual([0,1]);
    expect(await run(`(()=>{i.type='checkbox';l.click();return i.checked})()`)).toBeTrue();
    expect(await run(`(()=>{i.checked=false;l.htmlFor='missing';l.append(i);l.click();return[i.checked,l.control,list.length]})()`)).toEqual([false,null,0]);
    expect(await run(`(()=>{const d=document.getElementById('d');return['labels' in d,'control' in d,'form' in d,'labels' in document.createElement('fieldset'),'labels' in document.createElementNS('http://www.w3.org/2000/svg','input')]})()`)).toEqual([false,false,false,false,false]);
    expect(await run(`(()=>{const result=[];for(const [proto,name,node]of [[HTMLLabelElement.prototype,'control',i],[HTMLLabelElement.prototype,'form',document.getElementById('d')],[HTMLInputElement.prototype,'labels',document.createElement('button')],[HTMLInputElement.prototype,'labels',document.createElementNS('http://www.w3.org/2000/svg','input')]]){try{Object.getOwnPropertyDescriptor(proto,name).get.call(node);result.push(false)}catch(e){result.push(e instanceof TypeError)}}return result})()`)).toEqual([true,true,true,true]);
    expect(await run(`(()=>{const saved=TypeError;window.TypeError=function(){throw 'replaced'};try{Object.getOwnPropertyDescriptor(HTMLLabelElement.prototype,'control').get.call({})}catch(e){return e instanceof saved}finally{window.TypeError=saved}})()`)).toBeTrue();
  } finally { host.close(); }
}, 30000);
