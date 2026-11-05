import {test,expect} from 'bun:test';
import {parseXHTMLDocument} from '../lib/renderer/xhtml-document.js';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {RendererHost} from '../lib/renderer/host.js';
import {NetworkService} from '../lib/network/network-service.js';

const HTML='http://www.w3.org/1999/xhtml';
const wrap=body=>`<html xmlns="${HTML}"><head><title>XHTML</title></head><body>${body}</body></html>`;

test('active XHTML owns its XML tree, keeps case/CDATA/PI, and has live location factories',()=>{
  const source=`<?xml version='1.0'?><!--before &amp;--><?test raw &amp; > data?><!DOCTYPE html PUBLIC "STAFF" "never.dtd" [<?inside ignored?>]><html xmlns="${HTML}"><head/><body><DIV Foo="A"/><div/><p>one<![CDATA[<two>&amp;]]>three</p><template><span>inside</span></template></body></html>`;
  const {window,document}=parseXHTMLDocument(source,'https://xhtml.test/path/page','https://xhtml.test/from');
  try {
    expect([document.contentType,window.document===document,document.defaultView===window,document.URL,document.referrer]).toEqual(['application/xhtml+xml',true,true,'https://xhtml.test/path/page','https://xhtml.test/from']);
    expect([...document.childNodes].map(n=>n.nodeType)).toEqual([8,7,10,1]);
    expect([document.firstChild.data,document.childNodes[1].target,document.childNodes[1].data]).toEqual(['before &amp;','test','raw &amp; > data']);
    expect([document.doctype.name,document.doctype.publicId,document.doctype.systemId]).toEqual(['html','STAFF','never.dtd']);
    const div=document.body.firstElementChild,p=document.querySelector('p');
    expect([div.localName,div.attributes[0].name,div.attributes[0].ownerDocument===document,div.nextElementSibling.localName]).toEqual(['DIV','Foo',true,'div']);
    expect([...p.childNodes].map(n=>[n.nodeType,n.data])).toEqual([[3,'one'],[4,'<two>&amp;'],[3,'three']]);
    for(const node of [document.createElement('New'),document.createElementNS(HTML,'x:input'),document.createTextNode('x'),document.createComment('x'),document.createCDATASection('x'),document.createProcessingInstruction('x','y'),document.createDocumentFragment()]) expect(node.ownerDocument===document).toBeTrue();
    expect(document.querySelector('template').content.firstChild.ownerDocument===document).toBeTrue();
    window.location.hash='next';expect(document.URL).toBe('https://xhtml.test/path/page#next');
    const clone=document.cloneNode(true);expect([clone.URL,clone.defaultView,clone.contentType,clone.body.firstChild.ownerDocument===clone]).toEqual(['https://xhtml.test/path/page#next',null,'application/xhtml+xml',true]);
  } finally {window.happyDOM.close();}
});

test('tag-name collections preserve XML qualified-name case and stay live across mutation and adoption',()=>{
  const xml=parseXHTMLDocument(wrap('<DIV/><div/><x:item xmlns:x="urn:x"/><x:ITEM xmlns:x="urn:x"/>'),'https://xhtml.test/');
  const html=parseHTMLDocument('');
  try {
    const root=xml.document.body,upper=root.getElementsByTagName('DIV'),lower=root.getElementsByTagName('div');
    expect([upper.length,lower.length,root.getElementsByTagName('x:item').length,root.getElementsByTagName('x:ITEM').length,root.getElementsByTagName('X:ITEM').length]).toEqual([1,1,1,1,0]);
    const added=xml.document.createElement('div');root.appendChild(added);expect(lower.length).toBe(2);added.remove();expect(lower.length).toBe(1);
    const foreign=html.document.createElementNS('urn:x','Upper');html.document.body.append(foreign);
    expect([html.document.getElementsByTagName('Upper').length,html.document.getElementsByTagName('UPPER').length,html.document.getElementsByTagName('BODY').length]).toEqual([1,0,1]);
    html.document.adoptNode(root);html.document.body.append(root);
    expect([upper.length,lower.length,root.getElementsByTagName('x:ITEM').length]).toEqual([1,1,1]);
  } finally {xml.window.happyDOM.close();html.window.happyDOM.close();}
});

test('prefixed XHTML elements use the correct interfaces and head/body require exact HTML children',()=>{
  const page=parseXHTMLDocument(`<h:html xmlns:h="${HTML}"><h:head/><h:BODY/><h:div><h:body/></h:div><body xmlns="urn:foreign"/><h:body><h:input value="hello"/><h:script>source</h:script><input xmlns="${HTML}" value="repeated"/><script xmlns="${HTML}">repeated</script></h:body></h:html>`,'https://xhtml.test/');
  try {
    const {window,document}=page;
    expect([document.head.localName,document.head.prefix,document.body.localName,document.body.prefix]).toEqual(['head','h','body','h']);
    const input=document.body.firstChild,script=input.nextSibling;
    expect([input instanceof window.HTMLInputElement,input.value,script instanceof window.HTMLScriptElement,script.localName,script.prefix]).toEqual([true,'hello',true,'script','h']);
    expect([script.nextSibling.localName,script.nextSibling.value,script.nextSibling.nextSibling.localName,script.nextSibling.nextSibling instanceof window.HTMLScriptElement]).toEqual(['input','repeated','script',true]);
    document.body.remove();expect(document.body).toBeNull();document.head.remove();expect(document.head).toBeNull();
  } finally {page.window.happyDOM.close();}
});

test('malformed XHTML discards the partial tree and produces an inert visible error document',()=>{
  for(const source of [wrap('<script>bad()</script><p>broken'),wrap('<x xmlns:a="urn:x" xmlns:b="urn:x" a:a="1" b:a="2"/>'),'<html xmlns="urn:x"><p></html>']) {
    const {window,document}=parseXHTMLDocument(source,'https://xhtml.test/bad');
    try {
      expect(document.contentType).toBe('application/xhtml+xml');expect(document.querySelectorAll('script').length).toBe(0);
      expect(document.body.textContent.startsWith('XML parsing error:')).toBeTrue();expect(document.defaultView===window).toBeTrue();
    } finally {window.happyDOM.close();}
  }
  const html=parseHTMLDocument('<P><![CDATA[not XML]]></P>');
  try {expect(html.document.contentType).toBe('text/html');expect(html.document.querySelector('p').firstChild.nodeType).toBe(8);}finally{html.window.happyDOM.close();}
});

test('XHTML navigation executes eligible scripts with normal lifecycle, bindings and CDATA paint',async()=>{
  const requests=[],host=new RendererHost({network:new NetworkService({fetch:async url=>{
    const path=new URL(url).pathname;requests.push(path);
    return new Response(`globalThis.externalRan=(globalThis.externalRan||0)+1;globalThis.externalCurrent=document.currentScript.localName`,{headers:{'content-type':'text/javascript'}});
  }})});
  const run=source=>host.call('evaluate',source),shot=()=>host.call('screenshot',{format:'png'});
  try {
    await host.start();
    const source=wrap(`<style>body{font:20px monospace}#out{color:green}</style><div id="out">initial</div><script><![CDATA[globalThis.events=[];globalThis.inlineCurrent=document.currentScript.localName;document.addEventListener('DOMContentLoaded',()=>events.push('dom'));window.addEventListener('load',()=>events.push('load'));document.getElementById('out').textContent=2<3?'CDATA visible':'bad';]]></script><script src="/external.js"/><script xmlns="${HTML}">globalThis.entity=1 &lt; 2;</script><script xmlns="urn:foreign" src="/foreign.js">globalThis.bad=1</script><SCRIPT src="/uppercase.js">globalThis.bad=2</SCRIPT><style xmlns="urn:foreign">#out{display:none}</style><link xmlns="urn:foreign" rel="stylesheet" href="/foreign.css"/><div xmlns="urn:foreign" id="foreign" onclick="globalThis.bad=3"/>`);
    await host.call('loadDocument',{url:'https://xhtml.test/page',contentType:'Application/XHTML+XML; charset=utf-8',source});await host.call('whenLoaded');
    expect(await run(`(()=>{const d=document;return [d.contentType,d instanceof XMLDocument,d.defaultView===window,d===window.document,d.readyState,d.currentScript,inlineCurrent,externalCurrent,externalRan,entity,typeof bad,events,d.getElementById('out').textContent]})()`)).toEqual(['application/xhtml+xml',true,true,true,'complete',null,'script','script',1,true,'undefined',['dom','load'],'CDATA visible']);
    expect(requests).toEqual(['/external.js']);
    expect(await run(`(()=>{document.getElementById('foreign').dispatchEvent(new Event('click'));for(const [ns,name] of [['urn:foreign','script'],['${HTML}','SCRIPT'],['${HTML}','script']]){const s=document.createElementNS(ns,name);s.textContent='globalThis.dynamic=(globalThis.dynamic||0)+1';document.body.append(s)}return [typeof bad,dynamic,document.createCDATASection('x') instanceof CDATASection]})()`)).toEqual(['undefined',1,true]);
    expect(await run(`(()=>{const script=document.createElementNS('${HTML}','h:script');script.textContent='globalThis.prefixedInserted=true';document.body.append(script);return prefixedInserted})()`)).toBeTrue();
    const before=await shot();await run(`document.getElementById('out').firstChild.data='changed visible text'`);expect(await shot()).not.toBe(before);
    await host.call('loadDocument',{url:'https://xhtml.test/bad',contentType:'application/xhtml+xml',source:wrap('<script src="/bad.js"/><p>mismatch')});await host.call('whenLoaded');
    expect(await run(`({type:document.contentType,error:document.body.textContent.startsWith('XML parsing error:'),previous:typeof externalRan})`)).toEqual({type:'application/xhtml+xml',error:true,previous:'undefined'});
    expect(requests).toEqual(['/external.js']);expect(await shot()).not.toBe(before);
    await host.call('loadDocument',{url:'https://xhtml.test/prefixed',contentType:'application/xhtml+xml',source:`<h:html xmlns:h="${HTML}"><h:head/><h:body><h:script>globalThis.prefixedParser=document.currentScript.prefix</h:script></h:body></h:html>`});await host.call('whenLoaded');
    expect(await run(`[prefixedParser,document.body.prefix,document.body.firstChild instanceof HTMLScriptElement]`)).toEqual(['h','h',true]);
    await host.call('loadDocument',{url:'https://xhtml.test/html' ,contentType:'text/html',source:'<DIV id=out>HTML</DIV><SCRIPT>globalThis.htmlRan=true</SCRIPT>'});await host.call('whenLoaded');
    expect(await run(`[document.contentType,document.getElementById('out').tagName,htmlRan,typeof dynamic]`)).toEqual(['text/html','DIV',true,'undefined']);
  } finally {await host.close();}
},30000);
