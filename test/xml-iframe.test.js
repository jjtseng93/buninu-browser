import {test,expect} from 'bun:test';
import {parseActiveXMLDocument} from '../lib/renderer/xhtml-document.js';
import {RenderTreeBuilder,renderTreeText} from '../lib/render-tree/index.js';
import {xmlPresentation,XML_PREVIEW_LIMIT} from '../lib/render-tree/xml-presentation.js';
import {StyleEngine} from '../lib/style/computed-style.js';
import {createResourceElements,queryResourceElements} from '../lib/renderer/resource-elements.js';
import {displayDocument} from '../lib/document-types.js';
import {RendererHost} from '../lib/renderer/host.js';
import {NetworkService} from '../lib/network/network-service.js';

const HTML='http://www.w3.org/1999/xhtml',SVG='http://www.w3.org/2000/svg';
test('active ordinary XML keeps the real document and bounds its source presentation without fake DOM',()=>{
  const page=parseActiveXMLDocument('<?pi test?><foo title="&quot;&amp;">Dummy XML document<![CDATA[<x>]]><!--last--></foo>','https://xml.test/doc.xml',{contentType:'text/xml'});
  try {
    const {window,document}=page,builder=new RenderTreeBuilder(),styles=new StyleEngine();
    expect([document.contentType,document.defaultView===window,window.document===document,document.URL,document.body]).toEqual(['text/xml',true,true,'https://xml.test/doc.xml',null]);
    expect([document.documentElement.namespaceURI,document.createElement('Case').localName,document.createElement('Case').namespaceURI]).toEqual([null,'Case',null]);
    styles.compute(document);const first=builder.build(document,styles,null,{xmlRevision:0});
    expect(renderTreeText(first)).toBe('<?pi test?><foo title="&quot;&amp;">Dummy XML document<![CDATA[<x>]]><!--last--></foo>');
    expect(first.root.pseudo).toBe('xml-source');expect(builder.build(document,styles,null,{xmlRevision:0}).root).toBe(first.root);
    const root=document.documentElement;root.setAttribute('data-new','changed');
    expect(renderTreeText(builder.build(document,styles,null,{xmlRevision:1}))).toContain('data-new="changed"');
    expect(document.documentElement===root && document.body===null && root.childNodes.length===3).toBeTrue();
    root.firstChild.data='&'.repeat(200000);const limited=xmlPresentation(document);
    expect(limited.truncated).toBeTrue();expect(limited.text.length).toBeLessThan(XML_PREVIEW_LIMIT+100);expect(root.firstChild.data.length).toBe(200000);
    root.remove();expect(xmlPresentation(document).text).toContain('<?pi test?>');document.firstChild.remove();expect(xmlPresentation(document).text).toBe('(Empty XML document)');
  }finally{page.window.happyDOM.close();}
});

test('XML real presentation and resource discovery respect namespace and local name',()=>{
  const page=parseActiveXMLDocument(`<root xmlns:h="${HTML}" xmlns:s="${SVG}"><img src="wrong"/><style>not CSS</style><script>not JS</script><h:script>JS</h:script></root>`,'https://xml.test/');
  try {
    const {document}=page,cache=createResourceElements(document);
    try {
      expect(xmlPresentation(document).rendered).toBeFalse();
      for(const kind of ['images','media','sheets','frames'])expect(cache.get(kind)).toEqual([]);
      const style=document.createElementNS(HTML,'h:style');style.textContent='root{display:block;color:green}';document.documentElement.append(style);
      expect(cache.get('sheets')).toEqual([style]);expect(xmlPresentation(document).rendered).toBeFalse();
      expect(xmlPresentation(document,true).rendered).toBeTrue();
      const span=document.createElementNS(HTML,'h:span');span.textContent='actual content';document.documentElement.append(span);
      expect(xmlPresentation(document).rendered).toBeTrue();
      const builder=new RenderTreeBuilder(),styles=new StyleEngine();styles.compute(document,[style.textContent]);
      expect(renderTreeText(builder.build(document,styles,null,{styledXML:true}))).toBe('not CSSnot JSactual content');
      const image=document.createElementNS(HTML,'h:img');document.documentElement.append(image);expect(cache.get('images')).toEqual([image]);
      expect(queryResourceElements(document,'sheets')).toEqual([style]);
    }finally{cache.dispose();}
  }finally{page.window.happyDOM.close();}
  const svg=parseActiveXMLDocument(`<svg xmlns="${SVG}" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>`,'https://xml.test/image.svg',{contentType:'image/svg+xml'});
  try{expect(new RenderTreeBuilder().build(svg.document,new StyleEngine().compute(svg.document)).root.type).toBe('image');}finally{svg.window.happyDOM.close();}
  const inert=parseActiveXMLDocument(`<root xmlns:s="${SVG}" xmlns:h="${HTML}"><s:script>source</s:script><s:defs><s:rect/></s:defs><h:template><h:div>inert</h:div></h:template></root>`,'https://xml.test/');
  try{const view=xmlPresentation(inert.document);expect(view.rendered).toBeFalse();expect(view.text).toContain('<h:div>inert</h:div>');}finally{inert.window.happyDOM.close();}
  const shown=displayDocument({url:'https://xml.test/doc.xml',contentType:'application/xml',body:new TextEncoder().encode('<foo>text</foo>')});
  expect(shown.contentType).toBe('text/html');expect(shown.source).toContain('Pretty-print');
});

async function waitFor(host,expression) {
  for(let i=0;i<100;i++){if(await host.call('evaluate',expression))return;await Bun.sleep(20);}
  throw new Error(`Frame did not become ready: ${expression}`);
}
test('XML iframe exposes its active realm, repaints attribute-only mutations and disposes old callbacks',async()=>{
  const requests=[],host=new RendererHost({width:400,height:260,network:new NetworkService({fetch:async url=>{
    requests.push(new URL(url).pathname);
    return new Response('<foo data-label="old">Dummy XML document<script src="/wrong.js">throw 1</script></foo>',{headers:{'content-type':'application/xml'}});
  }})});
  try {
    await host.call('loadDocument',{url:'https://xml.test/',contentType:'text/html',source:'<iframe id="f" src="/doc.xml" style="width:350px;height:200px"></iframe>'});
    await waitFor(host,`document.getElementById('f').contentDocument?.contentType==='application/xml'`);
    expect(await host.call('evaluate',`(()=>{const f=document.getElementById('f'),d=f.contentDocument,w=f.contentWindow;globalThis.child=w;return [d===w.document,d.defaultView===w,d instanceof w.XMLDocument,d.body,d.documentElement.localName,d.documentElement.namespaceURI,d.createElement('CaSe').namespaceURI,d.createElement('CaSe').localName,d.readyState]})()`)).toEqual([true,true,true,null,'foo',null,null,'CaSe','complete']);
    const before=await host.call('screenshot',{format:'png'});
    await host.call('evaluate',`child.document.documentElement.setAttribute('data-label','NEW ATTRIBUTE');child.getComputedStyle(child.document.documentElement).color`);
    await Bun.sleep(40);
    expect(await host.call('screenshot',{format:'png'})).not.toBe(before);
    expect(requests).toEqual(['/doc.xml']);
    expect(await host.call('evaluate',`globalThis.calls=[];child.setTimeout(()=>calls.push('old'),20);document.getElementById('f').remove();child.setTimeout(()=>calls.push('late'),0);true`)).toBeTrue();
    await Bun.sleep(70);expect(await host.call('evaluate','calls')).toEqual([]);
    await host.call('loadDocument',{url:'https://xml.test/direct.xml',contentType:'application/xml',source:'<root only="attribute"/>'});await host.call('whenLoaded');
    await host.call('evaluate',`globalThis.keys=[];document.documentElement.addEventListener('keydown',()=>keys.push('down'));document.documentElement.addEventListener('keyup',()=>keys.push('up'))`);
    await host.call('press','ArrowDown',{eventType:'keydown'});await host.call('press','ArrowDown',{eventType:'keyup'});
    expect(await host.call('evaluate','keys')).toEqual(['down','up']);
    expect(await host.call('evaluate','[document.body,document.documentElement.localName]')).toEqual([null,'root']);
  }finally{await host.close();}
},30000);

test('XML frame byte decoding, malformed input and HTML namespace scripts preserve document semantics',async()=>{
  const host=new RendererHost({network:new NetworkService({fetch:async url=>{
    const path=new URL(url).pathname;
    if(path==='/utf16.xml')return new Response(Buffer.from('\ufeff<?xml version="1.0"?><root>中文</root>','utf16le'),{headers:{'content-type':'text/xml'}});
    if(path==='/invalid.xml')return new Response(new Uint8Array([0x3c,0x72,0x3e,0xff,0x3c,0x2f,0x72,0x3e]),{headers:{'content-type':'application/xml'}});
    return new Response(`<root xmlns:h="${HTML}"><h:script>globalThis.ran=1</h:script><script>globalThis.bad=1</script><h:div style="display:block;background:red;width:20px;height:20px">visible</h:div></root>`,{headers:{'content-type':'application/example+xml'}});
  }})});
  try {
    await host.call('loadDocument',{url:'https://xml.test/',contentType:'text/html',source:'<iframe id="f" src="/utf16.xml"></iframe>'});
    await waitFor(host,`document.getElementById('f').contentDocument?.contentType==='text/xml'`);
    expect(await host.call('evaluate',`(()=>{const d=document.getElementById('f').contentDocument;return [d.characterSet,d.documentElement.textContent,d.body]})()`)).toEqual(['UTF-16LE','中文',null]);
    await host.call('evaluate',`document.getElementById('f').src='/invalid.xml'`);
    await waitFor(host,`document.getElementById('f').contentDocument?.URL.endsWith('/invalid.xml')`);
    expect(await host.call('evaluate',`document.getElementById('f').contentDocument.body.textContent`)).toContain('Invalid XML response encoding');
    await host.call('evaluate',`document.getElementById('f').src='/mixed.xml'`);
    await waitFor(host,`document.getElementById('f').contentWindow?.ran===1`);
    expect(await host.call('evaluate',`(()=>{const w=document.getElementById('f').contentWindow;return [w.document.contentType,w.ran,typeof w.bad,w.document.body,w.document.documentElement.localName]})()`)).toEqual(['application/example+xml',1,'undefined',null,'root']);
  }finally{await host.close();}
},30000);
