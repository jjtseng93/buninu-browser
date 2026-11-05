import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {parseMarkupFragment} from '../lib/happy-dom/markup-fragment.js';
import {RendererHost} from '../lib/renderer/host.js';
import {loadGraphics} from '../lib/renderer/page-renderer.js';
import * as S from '../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

const html = '<div id="host"><template shadowrootmode="closed" shadowrootclonable shadowrootserializable shadowrootdelegatesfocus shadowrootslotassignment="manual"><b>private</b><div id="nested"><template shadowrootmode="open">inside</template></div></template><i>light</i></div>';

test('document parsing consumes declarations, preserves closed/nested trees and hydrates once', () => {
  const {window, document} = parseHTMLDocument(html);
  try {
    const host = document.getElementById('host'), root = host[S.shadowRoot];
    expect(host.shadowRoot).toBeNull(); expect(host.innerHTML).toBe('<i>light</i>');
    expect([root.mode,root.delegatesFocus,root.clonable,root.serializable,root.slotAssignment]).toEqual(['closed',true,true,true,'manual']);
    expect(root.querySelector('#nested').shadowRoot.textContent).toBe('inside');
    expect(() => host.attachShadow({mode:'open'})).toThrow();
    expect(host.attachShadow({mode:'closed',clonable:false})).toBe(root);
    expect(root.childNodes.length).toBe(0); expect(root.clonable).toBeTrue();
    try { host.attachShadow({mode:'closed'}); throw Error('must fail'); } catch (error) { expect(error.name).toBe('NotSupportedError'); }
  } finally { window.happyDOM.close(); }
});

test('clonable declarative roots copy their entire contents on shallow host clones', () => {
  const {window, document} = parseHTMLDocument(html);
  try {
    const host = document.getElementById('host'), original = host[S.shadowRoot], copy = host.cloneNode(false);
    expect(copy.childNodes.length).toBe(0); expect(copy[S.shadowRoot]).not.toBe(original);
    expect(copy[S.shadowRoot].textContent).toBe(original.textContent);
    expect(copy[S.shadowRoot].host).toBe(copy);
    expect(copy.attachShadow({mode:'closed'}).childNodes.length).toBe(0);
    expect(original.textContent).toBe('private');
    expect(() => copy.attachShadow({mode:'closed'})).toThrow();
  } finally { window.happyDOM.close(); }
});

test('hydration cannot be reused from a disconnected custom-element reaction', () => {
  const {window,document} = parseHTMLDocument('');
  try {
    let result;
    window.customElements.define('hydration-child',class extends window.HTMLElement {
      disconnectedCallback() {
        try { host.attachShadow({mode:'open'});result='allowed'; } catch(error) {result=error.name;}
      }
    });
    const fragment=parseMarkupFragment(document.body,'<div><template shadowrootmode="open"><hydration-child></hydration-child></template></div>',{declarative:true});
    const host=fragment.firstChild;document.body.append(host);
    const root=host.attachShadow({mode:'open'});
    expect(result).toBe('NotSupportedError');expect(root.childNodes.length).toBe(0);
  } finally {window.happyDOM.close();}
});

test('ordinary fragment APIs keep templates inert and never reactivate existing templates', () => {
  const {window, document} = parseHTMLDocument('');
  try {
    const markup = '<div><template shadowrootmode="open"><b>x</b></template></div>';
    const container = document.createElement('div'); container.innerHTML = markup;
    expect(container.firstChild.shadowRoot).toBeNull();
    const fragment = parseMarkupFragment(container,markup);
    expect(fragment.firstChild.shadowRoot).toBeNull();
    const parser = new window.DOMParser();
    expect(parser.parseFromString(markup,'text/html').body.firstChild.shadowRoot).toBeNull();
    const range = document.createRange(); range.selectNodeContents(container);
    expect(range.createContextualFragment(markup).firstChild.shadowRoot).toBeNull();
    const root = document.createElement('div').attachShadow({mode:'open'}); root.innerHTML = markup;
    expect(root.firstChild.shadowRoot).toBeNull();
    const enabled = parseMarkupFragment(container,'<template shadowrootmode="open">leading</template>'+markup,{declarative:true});
    expect(container.shadowRoot).toBeNull(); expect(enabled.firstChild.localName).toBe('template');
    expect(enabled.lastChild.shadowRoot.textContent).toBe('x');
    container.appendChild(fragment);
    expect(fragment.childNodes.length).toBe(0); expect(container.lastChild.shadowRoot).toBeNull();
  } finally { window.happyDOM.close(); }
});

test('fragment parsing does not clone custom hosts or their clonable shadow contents', () => {
  const {window, document} = parseHTMLDocument('');
  try {
    let constructed = 0;
    window.customElements.define('custom-host',class extends window.HTMLElement {constructor(){super();constructed++;}});
    const host = document.createElement('custom-host');
    host.attachShadow({mode:'open',clonable:true}).innerHTML = '<p>preserve</p>';
    const before = constructed;
    const fragment = parseMarkupFragment(host,'<em>new</em>',{declarative:true});
    expect(constructed).toBe(before); expect(fragment.firstChild.localName).toBe('em');
    expect(host.shadowRoot.textContent).toBe('preserve');
  } finally { window.happyDOM.close(); }
});

test('HTML element fragment context retains head/body structure without activating a root template', () => {
  const {window,document} = parseHTMLDocument('');
  try {
    for (const declarative of [false,true]) {
      const fragment = parseMarkupFragment(document.documentElement,'<head><title>title</title></head><body><div><template shadowrootmode="open">inside</template></div></body>',{declarative});
      expect([...fragment.children].map(node=>node.localName)).toEqual(['head','body']);
      expect(fragment.firstChild.firstChild.textContent).toBe('title');
      expect(Boolean(fragment.lastChild.firstChild.shadowRoot)).toBe(declarative);
    }
  } finally { window.happyDOM.close(); }
});

test('unsafe HTML APIs preserve inert scripts, parser realms, flags, reactions and replacement records', async () => {
  const renderer = new RendererHost({timeout:20_000});
  try {
    await renderer.call('loadDocument',{url:'https://parser.test/path',contentType:'text/html',source:'<main></main>'});
    await renderer.call('whenLoaded');
    expect(await renderer.call('evaluate', `(() => {
      const host=document.createElement('div'); document.body.append(host);
      host.innerHTML='<p>old</p><b>old2</b>';
      const observer=new MutationObserver(()=>{});observer.observe(host,{childList:true});
      globalThis.executed=0;
      host.setHTMLUnsafe('<div id="inner"><template shadowrootmode="closed" shadowrootclonable shadowrootserializable><b>private</b></template></div><script>executed++<\/script>');
      const records=observer.takeRecords();observer.disconnect();
      const inner=host.firstChild, copy=inner.cloneNode(false), root=copy.attachShadow({mode:'closed'});
      const d=Document.parseHTMLUnsafe('<!doctype html><title>inert</title><div><template shadowrootmode="open">shadow</template><script>executed++<\/script></div>');
      const inside=d.querySelector('div');
      return [executed,host.children.length,inner.shadowRoot,inner.querySelector('b'),
        root.clonable,root.serializable,root.textContent,
        records.length,records[0].addedNodes.length,records[0].removedNodes.length,
        d instanceof Document,d.contentType,d.URL,d.defaultView,d.location,d.title,
        inside.shadowRoot.textContent,inside.ownerDocument===d,inside.shadowRoot.ownerDocument===d,
        inside.shadowRoot.firstChild.ownerDocument===d,d.createElement('p').ownerDocument===d];
    })()`)).toEqual([0,2,null,null,true,true,'',1,2,2,true,'text/html','about:blank',null,null,'inert','shadow',true,true,true,true]);
    expect(await renderer.call('evaluate', `(() => {
      const t=document.createElement('template');t.shadowRootMode='ClOsEd';t.shadowRootClonable=true;t.shadowRootSerializable=true;t.shadowRootSlotAssignment='MANUAL';
      t.setHTMLUnsafe('<div><template shadowrootmode="open">nested</template></div>');
      const host=document.createElement('div'), root=host.attachShadow({mode:'open',clonable:true,serializable:true});
      root.setHTMLUnsafe('<div><template shadowrootmode="closed">nested</template></div>');
      const errors=[];for (const call of [()=>host.setHTMLUnsafe(),()=>host.setHTMLUnsafe(Symbol()),()=>host.setHTMLUnsafe('',1),
        ()=>Element.prototype.setHTMLUnsafe.call({},''),()=>Document.parseHTMLUnsafe(),()=>Document.parseHTMLUnsafe(Symbol()),
        ()=>host.setHTMLUnsafe('',{sanitizer:'default'}),()=>host.setHTMLUnsafe('',{runScripts:true}),
        ()=>document.createElement('input').attachShadow({mode:'open'})]) {
          try{call();errors.push('no error')}catch(e){errors.push(e.name)}
      }
      const thrown={};let same=false;try{host.setHTMLUnsafe({toString(){throw thrown}})}catch(e){same=e===thrown}
      return [t.shadowRootMode,t.getAttribute('shadowrootmode'),t.shadowRootClonable,t.shadowRootSerializable,t.shadowRootSlotAssignment,
        t.childNodes.length,t.content.firstChild.shadowRoot.textContent,root.clonable,root.serializable,root.firstChild.shadowRoot,
        root.firstChild.attachShadow({mode:'closed'}).textContent,errors,same];
    })()`)).toEqual(['closed','ClOsEd',true,true,'manual',0,'nested',true,true,null,'',
      ['TypeError','TypeError','TypeError','TypeError','TypeError','TypeError','NotSupportedError','NotSupportedError','NotSupportedError'],true]);
    expect(await renderer.call('evaluate', `(() => {
      const log=[];class ParsedElement extends HTMLElement {
        constructor(){super();log.push('new')}
        connectedCallback(){log.push(['connected',this.parentNode.children.length])}
        disconnectedCallback(){log.push(['disconnected',this.parentNode])}
      }customElements.define('parsed-element',ParsedElement);
      const host=document.createElement('div');document.body.append(host);
      host.setHTMLUnsafe('<parsed-element></parsed-element><span></span>');
      host.setHTMLUnsafe('<p></p>');return log;
    })()`)).toEqual(['new',['connected',2],['disconnected',null]]);
  } finally { await renderer.close(); }
},30_000);

test('initial and unsafe-parsed closed roots render scoped styles into real pixels', async () => {
  const renderer=new RendererHost({timeout:20_000}),{CanvasKit:kit}=await loadGraphics();
  const pixel=async()=>{
    const image=kit.MakeImageFromEncoded(Buffer.from(await renderer.call('screenshot'),'base64'));
    try {return [...image.readPixels(10,10,{width:1,height:1,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB})];}
    finally{image.delete();}
  };
  try{
    await renderer.call('resize',80,80,1);
    await renderer.call('loadDocument',{url:'https://parser.test/',contentType:'text/html',source:'<!doctype html><style>body{margin:0}</style><main><div><template shadowrootmode="closed"><style>p{margin:0;width:40px;height:40px;background:red}</style><p></p></template></div></main>'});
    await renderer.call('whenLoaded');expect(await pixel()).toEqual([255,0,0,255]);
    await renderer.call('evaluate',`document.querySelector('main').setHTMLUnsafe('<section><template shadowrootmode="closed"><style>p{margin:0;width:40px;height:40px;background:blue}</style><p></p></template></section>')`);
    expect(await pixel()).toEqual([0,0,255,255]);
  }finally{await renderer.close();}
},30_000);
