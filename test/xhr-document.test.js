import {afterAll, beforeAll, expect, test} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
import {NetworkService} from '../lib/network/network-service.js';
import {createInertWindow} from '../lib/happy-dom/parser.js';
import {xhrDocumentResponse} from '../lib/renderer/xhr-document.js';
import {xhrResponseMetadata} from '../lib/renderer/xhr-response.js';
import {documentEncoding, setDocumentEncoding} from '../lib/renderer/document-constructor.js';

const encode = text => new TextEncoder().encode(text);
test('XHR parses XML with a private error result, never an authored parsererror heuristic', () => {
  const window = createInertWindow('https://xhr.test/source');
  const parse = (text, mime = 'application/xml', responseType = 'document') => xhrDocumentResponse({
    bytes:encode(text), responseType, metadata:xhrResponseMetadata(mime), window,
    url:'https://xhr.test/final/data.xml', sourceDocument:window.document,
  });
  try {
    for (const source of ['', '<root>', '<x></x', '<x>&amp</x>', '<x>&unknown;</x>', '<x>\0</x>',
      '<x/><y/>', '<x><y></x></y>', '<p:x/>', '<x a="1" a="2"/>',
      '<x xmlns:a="urn:a" xmlns:b="urn:a" a:v="1" b:v="2"/>',
      '<x xmlns:xml="urn:wrong"/>', '<x xmlns:xmlns="urn:wrong"/>',
      '<x xmlns="http://www.w3.org/XML/1998/namespace"/>',
      '<x xmlns:p=""/>', '<x a:v="1"/>', '<x><a xmlns:p="urn:a"/><p:y/></x>',
      '<?xml version="1.0" encoding="not-real"?><x/>',
      '<?xml version="1.0" encoding="' + 'a'.repeat(200) + '"?><x/>']) expect(parse(source)).toBeNull();
    const author = parse('<parsererror xmlns="http://www.w3.org/1999/xhtml">real content</parsererror>');
    expect(author.documentElement.localName).toBe('parsererror');
    expect(author.documentElement.textContent).toBe('real content');
    expect(author.defaultView).toBeNull();
    expect(author.location).toBeNull();
    expect(author.URL).toBe('https://xhr.test/final/data.xml');
    expect(author.readyState).toBe('complete');
    expect(author.contentType).toBe('application/xml');
    expect(parse("<?xml version = '1.0'?><x/>").documentElement.localName).toBe('x');
    expect(parse('<template xmlns="http://www.w3.org/1999/xhtml"><x/></template>').documentElement.content.firstChild.localName).toBe('x');
    const namespaced = parse('<x xmlns:p="urn:a"><y p:v="1"/><z xmlns:p="urn:b" p:v="2"/><z p:v="3" xml:lang="en"/></x>');
    expect(namespaced.documentElement.children[0].getAttributeNS('urn:a','v')).toBe('1');
    expect(namespaced.documentElement.children[1].getAttributeNS('urn:b','v')).toBe('2');
    expect(namespaced.documentElement.children[2].getAttributeNS('urn:a','v')).toBe('3');
    expect(namespaced.documentElement.children[2].getAttributeNode('xml:lang').prefix).toBe('xml');
    expect(parse('<xml:x/>').documentElement.namespaceURI).toBe('http://www.w3.org/XML/1998/namespace');
    const defaults = parse('<x xmlns="urn:a"><p:y xmlns:p="urn:p" xmlns="urn:b"><z/></p:y><b xmlns=""><c/></b><d/></x>');
    expect(defaults.documentElement.children[0].namespaceURI).toBe('urn:p');
    expect(defaults.documentElement.children[0].firstChild.namespaceURI).toBe('urn:b');
    expect(defaults.documentElement.children[1].namespaceURI).toBeNull();
    expect(defaults.documentElement.children[1].firstChild.namespaceURI).toBeNull();
    expect(defaults.documentElement.children[2].namespaceURI).toBe('urn:a');
    expect(parse('<x/>', 'text/plain')).toBeNull();
    expect(parse('<x/>', 'text/html', '')).toBeNull();
    expect(parse('', 'text/html').documentElement.localName).toBe('html');
    const html = parse('<script>globalThis.XHR_PARSED_SCRIPT_RAN=true</script><img src="https://unreachable.invalid/image"><iframe src="https://unreachable.invalid/frame"></iframe>', 'text/html');
    expect(window.XHR_PARSED_SCRIPT_RAN).toBeUndefined();
    expect(html.defaultView).toBeNull();
    expect(html.querySelector('iframe').contentWindow).toBeNull();
  } finally { window.happyDOM.close(); }
});

test('XHR XML document decoding records the effective encoding', () => {
  const window = createInertWindow();
  try {
    const text = "<?xml version='1.0' encoding='windows-1252'?><x>é</x>";
    const parsed = xhrDocumentResponse({bytes:Uint8Array.from(text,c=>c.charCodeAt(0)), responseType:'document',
      metadata:xhrResponseMetadata('application/xml'), url:'https://xhr.test/latin', sourceDocument:window.document, window});
    expect(parsed.documentElement.textContent).toBe('é');
    expect(documentEncoding(parsed)).toBe('windows-1252');
    expect(documentEncoding(parsed.cloneNode(true))).toBe('windows-1252');
    for (const [label, expected] of [['shift_jis','Shift_JIS'],['gbk','GBK'],['big5','Big5'],['iso-8859-2','ISO-8859-2'],['euc-jp','EUC-JP'],['utf-16be','UTF-16BE']]) {
      setDocumentEncoding(parsed,label); expect(documentEncoding(parsed)).toBe(expected);
    }
    const invalid = Uint8Array.from([...encode('<x>'),255,...encode('</x>')]);
    expect(xhrDocumentResponse({bytes:invalid,responseType:'document',metadata:xhrResponseMetadata('application/xml'),
      url:'https://xhr.test/invalid',sourceDocument:window.document,window})).toBeNull();
  } finally { window.happyDOM.close(); }
});

let renderer;
const requests = [];
beforeAll(async () => {
  renderer = new RendererHost({timeout:20_000, network:new NetworkService({fetch:async (url, init) => {
    const path = new URL(url).pathname;
    requests.push({path, headers:[...new Headers(init.headers)]});
    if (path === '/slow') await Bun.sleep(90);
    if (path === '/broken') return new Response(new ReadableStream({start(controller) {
      controller.enqueue(encode('<root>'));
      setTimeout(()=>controller.error(new Error('broken response body')), 15);
    }}), {headers:{'content-type':'application/xml'}});
    if (path === '/html') return new Response('<!doctype html><script>globalThis.XHR_PARSED_SCRIPT_RAN=true;setInterval(()=>{},1)</script><script src="/script.js"></script><link rel="stylesheet" href="/style.css"><img src="/image.png"><iframe src="/frame.html"></iframe><a href="child">link</a>', {headers:{'content-type':'text/html'}});
    if (path === '/bad') return new Response('<x>', {headers:{'content-type':'application/xml'}});
    if (path === '/invalid-byte') return new Response(Uint8Array.from([...encode('<x>'),255,...encode('</x>')]),{headers:{'content-type':'application/xml'}});
    if (path === '/plain') return new Response('plain', {headers:{'content-type':'text/plain'}});
    if (path === '/empty') return new Response(null, {status:204, headers:{'content-type':'text/html'}});
    if (path === '/latin') return new Response(Uint8Array.from("<?xml version='1.0' encoding='windows-1252'?><x>é</x>", c=>c.charCodeAt(0)),{headers:{'content-type':'application/xml'}});
    if (path === '/external') return new Response('<!DOCTYPE x SYSTEM "https://unreachable.invalid/external.dtd"><x/>',{headers:{'content-type':'application/xml'}});
    if (path === '/author') return new Response('<parsererror xmlns="http://www.w3.org/1999/xhtml">authored</parsererror>',{headers:{'content-type':'application/xml'}});
    return new Response('<root><child>ok</child></root>', {headers:{'content-type':'application/xml','x-test':'yes'}});
  }})});
  await renderer.start();
  await renderer.call('loadDocument', {url:'https://xhr.test/source',source:'<!doctype html><p>XHR documents</p>',contentType:'text/html',status:200});
  await renderer.call('evaluate',`globalThis.requestDocument=(url,type='document')=>new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('GET',url);x.responseType=type;x.onload=()=>resolve(x);x.onerror=reject;x.send()})`);
});
afterAll(()=>renderer?.close());
const evaluate = source => renderer.call('evaluate',source);

test('responseXML and document response cache one detached document with page bindings', async () => {
  expect(await evaluate(`(async()=>{const x=await requestDocument('/xml'),d=x.responseXML;return {
    same:d===x.response&&d===x.responseXML, xml:d instanceof XMLDocument, doc:d instanceof Document,
    root:d.documentElement.tagName, text:d.documentElement.textContent, url:d.URL, uri:d.documentURI,
    base:d.baseURI, origin:d.domain, view:d.defaultView, location:d.location, state:d.readyState,
    mime:d.contentType, encoding:d.characterSet, current:document.URL,
  }})()`)).toEqual({same:true,xml:true,doc:true,root:'root',text:'ok',url:'https://xhr.test/xml',uri:'https://xhr.test/xml',
    base:'https://xhr.test/xml',origin:'xhr.test',view:null,location:null,state:'complete',mime:'application/xml',encoding:'UTF-8',current:'https://xhr.test/source'});
  expect(await evaluate(`(async()=>{const x=await requestDocument('/xml','');return [typeof x.response,x.responseText===x.response,x.responseXML.documentElement.localName]})()`)).toEqual(['string',true,'root']);
  expect(await evaluate(`(async()=>{const x=await requestDocument('/author');return x.responseXML.documentElement.textContent})()`)).toBe('authored');
  expect(await evaluate(`(async()=>{const x=await requestDocument('/latin');return [x.responseXML.documentElement.textContent,x.responseXML.characterSet,x.responseXML.charset,x.responseXML.inputEncoding]})()`)).toEqual(['é','windows-1252','windows-1252','windows-1252']);
});

test('response getters respect type and state, and invalid enum assignments leave responseType alone', async () => {
  expect(await evaluate(`(()=>{const x=new XMLHttpRequest(),result=[];for(const type of ['', 'text','json','arraybuffer','blob','document']){
    x.responseType=type;let xml,text;try{xml=x.responseXML}catch(e){xml=e.name}try{text=x.responseText}catch(e){text=e.name}
    result.push([type,x.response,xml,text]);}x.responseType='text';x.responseType='JSON';let symbol;try{x.responseType=Symbol()}catch(e){symbol=e instanceof TypeError}
    return [result,x.responseType,symbol]})()`)).toEqual([
      [['','',null,''],['text','','InvalidStateError',''],['json',null,'InvalidStateError','InvalidStateError'],
        ['arraybuffer',null,'InvalidStateError','InvalidStateError'],['blob',null,'InvalidStateError','InvalidStateError'],['document',null,null,'InvalidStateError']], 'text',true]);
  expect(await evaluate(`(async()=>{const x=await requestDocument('/xml');let error;try{x.responseType='text'}catch(e){error=e.name}x.responseType='bogus';return [error,x.responseType]})()`)).toEqual(['InvalidStateError','document']);
  for (const path of ['/bad','/plain','/empty','/invalid-byte']) expect(await evaluate(`requestDocument(${JSON.stringify(path)}).then(x=>[x.responseXML,x.response])`)).toEqual([null,null]);
  expect(await evaluate(`requestDocument('/invalid-byte','').then(x=>[x.responseText,x.responseXML])`)).toEqual(['<x>\ufffd</x>',null]);
});

test('HTML response documents stay inert and default text mode does not create HTML documents', async () => {
  expect(await evaluate(`(async()=>{const x=await requestDocument('/html'),d=x.response;await new Promise(r=>setTimeout(r,30));return [d instanceof HTMLDocument,d.contentType,d.defaultView,d.querySelector('a').href,typeof globalThis.XHR_PARSED_SCRIPT_RAN]})()`)).toEqual([true,'text/html',null,'https://xhr.test/child','undefined']);
  expect(requests.some(({path})=>['/script.js','/style.css','/image.png','/frame.html'].includes(path))).toBeFalse();
  expect(await evaluate(`requestDocument('/html','').then(x=>[typeof x.response,x.responseXML])`)).toEqual(['string',null]);
  expect(await evaluate(`requestDocument('/external').then(x=>x.responseXML.documentElement.localName)`)).toBe('x');
  expect(requests.some(({path})=>path==='/external.dtd')).toBeFalse();
});

test('reopening an XHR discards an old completion and document cache, while preserving MIME override', async () => {
  expect(await evaluate(`new Promise(resolve=>{const x=new XMLHttpRequest(),events=[];x.responseType='document';x.overrideMimeType('application/xml');
    x.onload=()=>{events.push(x.responseXML.documentElement.localName);setTimeout(()=>resolve([events,x.responseXML.documentElement.localName,x.responseURL]),140)};
    x.open('GET','/slow');x.send();x.open('GET','/xml');x.send();})`)).toEqual([['root'],'root','https://xhr.test/xml']);
  expect(await evaluate(`new Promise(resolve=>{const x=new XMLHttpRequest();let first;
    x.onload=()=>{if(!first){first=x.responseXML;x.open('GET','/author');const cleared=x.responseXML===null&&x.response===null;x.onload=()=>resolve([cleared,first!==x.responseXML,first.documentElement.localName,x.responseXML.documentElement.localName]);x.send()}};
    x.open('GET','/xml');x.responseType='document';x.send()})`)).toEqual([true,true,'root','parsererror']);
});

test('reentrant header/LOADING callbacks may reopen or abort without stale body completion', async () => {
  for (const phase of [2,3]) {
    expect(await evaluate(`new Promise(resolve=>{const x=new XMLHttpRequest(),events=[];let switched=false;
      x.onreadystatechange=()=>{events.push(x.readyState);if(x.readyState===${phase}&&!switched){switched=true;x.open('GET','/author');x.send()}};
      x.onload=()=>setTimeout(()=>resolve([events,x.responseXML.documentElement.localName]),30);
      x.open('GET','/xml');x.responseType='document';x.send()})`)).toEqual([phase===2?[1,2,1,2,3,4]:[1,2,3,1,2,3,4],'parsererror']);
    expect(await evaluate(`new Promise(resolve=>{const x=new XMLHttpRequest(),events=[];
      x.onreadystatechange=()=>{events.push(x.readyState);if(x.readyState===${phase})x.abort()};
      x.onload=()=>events.push('load');x.onabort=()=>events.push('abort');x.onloadend=()=>setTimeout(()=>resolve([events,x.readyState,x.status,x.responseXML]),30);
      x.open('GET','/xml');x.responseType='document';x.send()})`)).toEqual([phase===2?[1,2,4,'abort']:[1,2,3,4,'abort'],0,0,null]);
  }
});

test('abort is synchronous, loadstart can reopen, and old request timers cannot cancel the replacement', async () => {
  expect(await evaluate(`new Promise(resolve=>{const x=new XMLHttpRequest(),events=[];let stage=0;
    x.onreadystatechange=()=>{if(stage===1&&x.readyState===4){stage=2;x.open('GET','/author');x.timeout=0;x.send()}};
    x.onloadstart=()=>{events.push('start');if(stage===0){stage=1;x.abort();events.push('after:'+x.readyState)}};
    x.onabort=()=>events.push('abort:'+x.readyState);x.onload=()=>setTimeout(()=>resolve([events,x.responseXML.documentElement.localName]),70);
    x.open('GET','/slow');x.responseType='document';x.timeout=30;x.send()})`)).toEqual([['start','start','abort:1','after:1'],'parsererror']);
  expect(await evaluate(`new Promise(resolve=>{const x=new XMLHttpRequest(),events=[];x.open('GET','/slow');x.responseType='document';x.timeout=5;
    x.ontimeout=()=>events.push('timeout');x.onload=()=>events.push('load');x.onloadend=()=>setTimeout(()=>resolve([events,x.status,x.responseXML]),120);x.send()})`)).toEqual([['timeout'],0,null]);
});

test('body errors clear the response and open resets headers/send state without clearing MIME override', async () => {
  expect(await evaluate(`new Promise(resolve=>{const x=new XMLHttpRequest(),events=[];x.open('GET','/broken');x.responseType='document';
    x.onerror=()=>events.push('error');x.onload=()=>events.push('load');x.onloadend=()=>resolve([events,x.readyState,x.status,x.response,x.responseXML,x.getAllResponseHeaders()]);x.send()})`)).toEqual([['error'],4,0,null,null,'']);
  expect(await evaluate(`new Promise(resolve=>{const x=new XMLHttpRequest();let error;
    x.open('GET','/slow');x.setRequestHeader('x-old','one');x.send();try{x.send()}catch(e){error=e.name}
    x.open('GET','/header-reset');x.setRequestHeader('x-new','two');x.onload=()=>resolve(error);x.send()})`)).toBe('InvalidStateError');
  const headers = new Headers(requests.find(({path})=>path==='/header-reset').headers);
  expect(headers.get('x-old')).toBeNull();
  expect(headers.get('x-new')).toBe('two');
});
