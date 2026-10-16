import { afterAll, beforeAll, expect, test } from "bun:test";
import { RendererHost } from "../lib/renderer/host.js";

let renderer;
beforeAll(async () => {
  renderer = new RendererHost({ timeout: 20_000 });
  await renderer.start();
  await renderer.call("resize", 400, 300, 1);
});
afterAll(() => renderer?.close());

const load = async (body) => {
  await renderer.call("loadDocument", {
    url: "https://page.test/",
    source: `<!doctype html><html><head></head><body>${body}</body></html>`,
    contentType: "text/html", status: 200,
  });
  await renderer.call("whenLoaded");
};
const evaluate = (source) => renderer.call("evaluate", source);
const eventually = async (expression, expected) => {
  let value;
  for (let attempt = 0; attempt < 100; attempt++) {
    value = await evaluate(expression);
    if (value === expected) return;
    await Bun.sleep(20);
  }
  expect(value).toBe(expected);
};

test("dataset is a DOMStringMap with live named properties and a mutable page prototype", async () => {
  await load('<div id="test" data-async-css="1" data-name="before"></div>');
  expect(await evaluate(`JSON.stringify((() => {
    const element = document.getElementById('test');
    const data = element.dataset;
    const result = [data instanceof DOMStringMap, Object.prototype.toString.call(data), data === element.dataset,
      Object.getPrototypeOf(data) === DOMStringMap.prototype, data.asyncCss, data['async-css'], Object.keys(data)];
    data.name = 'after';
    result.push(element.getAttribute('data-name'));
    element.setAttribute('data-new-value', 'live');
    result.push(data.newValue);
    delete data.name;
    result.push(element.hasAttribute('data-name'));
    try { data['bad-name'] = 'x'; } catch (error) { result.push(error.name); }
    try { new DOMStringMap(); } catch (error) { result.push(error.name); }
    DOMStringMap.prototype.extension = 7;
    result.push(data.extension, 'extension' in data, Object.hasOwn(data, 'extension'));
    data.constructor = 'data attribute';
    result.push(data.constructor, element.getAttribute('data-constructor'));
    delete data.constructor;
    result.push(data.constructor === DOMStringMap);
    return result;
  })())`)).toBe(JSON.stringify([true, "[object DOMStringMap]", true, true, "1", undefined, ["asyncCss", "name"],
    "after", "live", false, "SyntaxError", "TypeError", 7, true, false, "data attribute", "data attribute", true]));
});

test("IntersectionObserver batches targets and updates as scrolling crosses thresholds", async () => {
  await load(`<div id="first" style="position:absolute;left:0;top:400px;width:100px;height:100px"></div>
    <div id="second" style="position:absolute;left:120px;top:400px;width:100px;height:100px"></div>
    <div style="height:1200px"></div>`);
  await evaluate(`window.observations = []; window.observer = new IntersectionObserver(entries => {
    observations.push(entries.map(e => [e.target.id, e.isIntersecting, e.intersectionRatio]));
  }, {threshold: [0, 0.5, 1]});
  observer.observe(document.getElementById('first')); observer.observe(document.getElementById('second'));`);
  await eventually("observations.length", 1);
  expect(await evaluate("JSON.stringify(observations[0])")).toBe(JSON.stringify([["first", false, 0], ["second", false, 0]]));
  await renderer.call("scrollTo", 0, 150);
  await eventually("observations.length", 2);
  expect(await evaluate("JSON.stringify(observations[1])")).toBe(JSON.stringify([["first", true, 0.5], ["second", true, 0.5]]));
  await renderer.call("scrollTo", 0, 200);
  await eventually("observations.length", 3);
  expect(await evaluate("JSON.stringify(observations[2])")).toBe(JSON.stringify([["first", true, 1], ["second", true, 1]]));
  await renderer.call("scrollTo", 0, 220);
  await Bun.sleep(60);
  expect(await evaluate("observations.length")).toBe(3);
  await evaluate("observer.disconnect()");
  await renderer.call("scrollTo", 0, 0);
  await Bun.sleep(60);
  expect(await evaluate("observations.length")).toBe(3);
});

test("ResizeObserver reports content and border boxes again after size changes", async () => {
  await load('<div id="box" style="width:100px;height:50px;padding:10px;border:2px solid"></div>');
  await evaluate(`window.sizes = []; window.observer = new ResizeObserver(entries => {
    sizes.push(entries.map(e => [e.contentRect.width,e.contentRect.height,e.borderBoxSize[0].inlineSize,e.borderBoxSize[0].blockSize]));
  }); observer.observe(document.getElementById('box'));`);
  await eventually("sizes.length", 1);
  expect(await evaluate("JSON.stringify(sizes[0])")).toBe("[[100,50,124,74]]");
  await evaluate("document.getElementById('box').style.width='150px'");
  await eventually("sizes.length", 2);
  expect(await evaluate("JSON.stringify(sizes[1])")).toBe("[[150,50,174,74]]");
  await evaluate("document.getElementById('box').style.color='red'");
  await Bun.sleep(60);
  expect(await evaluate("sizes.length")).toBe(2);
  await evaluate("document.getElementById('box').style.display='none'");
  await eventually("sizes.length", 3);
  expect(await evaluate("JSON.stringify(sizes[2])")).toBe("[[0,0,0,0]]");
});

test("IntersectionObserver validates options and applies explicit root margins", async () => {
  await load(`<div id="root" style="position:absolute;top:20px;left:20px;width:100px;height:100px;overflow:hidden">
    <div id="target" style="position:absolute;top:150px;left:0;width:100px;height:100px"></div></div>`);
  expect(await evaluate(`JSON.stringify((() => {
    const result=[];
    for(const options of [{threshold:2},{threshold:NaN},{rootMargin:'1em'},{root:{} }]) {
      try { new IntersectionObserver(()=>{},options); } catch(e) { result.push(e.name); }
    }
    window.observations=[];
    window.observer=new IntersectionObserver(e=>observations.push(e[0].intersectionRatio),{
      root:document.getElementById('root'),rootMargin:'0px 0px 100%',threshold:[1,0.5,0]});
    observer.observe(document.getElementById('target'));
    result.push(observer instanceof IntersectionObserver,observer.root.id,observer.rootMargin,observer.thresholds.join(','));
    return result;
  })())`)).toBe(JSON.stringify(["RangeError", "RangeError", "SyntaxError", "TypeError", true, "root", "0px 0px 100% 0px", "0,0.5,1"]));
  await eventually("observations.length", 1);
  expect(await evaluate("observations[0]")).toBe(0.5);
});

test("innerText collects visible text and line boundaries instead of scripts and hidden content", async () => {
  await load(`<div id="text">  hello <span> world </span> !<script type="application/json">secret</script>
    <style>#text b { display:none }</style><b>hidden</b><div>block <i> words </i></div><p>paragraph</p>
    <span style="visibility:hidden">invisible<span style="visibility:visible">visible</span></span><br>end<br></div>
    <div id="hidden" style="display:none">raw <b>hidden</b><script type="application/json">data</script></div>
    <pre id="pre">  pre\n text  </pre>`);
  expect(await evaluate("document.getElementById('text').innerText")).toBe("hello world !\nblock words\n\nparagraph\n\nvisible\nend\n");
  expect(await evaluate("document.getElementById('hidden').innerText")).toBe("raw hiddendata");
  expect(await evaluate("document.getElementById('pre').innerText")).toBe("  pre\n text  ");
  expect(await evaluate(`(()=>{const e=document.createElement('div');e.innerHTML='<b>a</b><br><i>b</i>';return e.innerText})()`)).toBe("ab");
  expect(await evaluate(String.raw`(()=>{const e=document.getElementById('text');e.innerText='a\r\nb\rc\n';return e.innerHTML})()`)).toBe("a<br>b<br>c<br>");
  expect(await evaluate(`(()=>{const e=document.getElementById('text');e.innerText=null;return e.innerHTML})()`)).toBe("");
});

test("Headers instrumentation is page-local and reaches Request and Response headers", async () => {
  await load('<p>fetch interfaces</p>');
  expect(await evaluate(`JSON.stringify((() => {
    const original=Headers.prototype.set;
    window.calls=[];
    Headers.prototype.set=function(name,value){ calls.push(name); return original.call(this,name,value); };
    const headers=new Headers(); headers.set('x-direct','1');
    const request=new Request('/api'); request.headers.set('x-request','2');
    const response=new Response('body'); response.headers.set('x-response','3');
    return [calls,headers instanceof Headers,request.headers instanceof Headers,response.headers instanceof Headers,
      request.clone() instanceof Request,response.clone() instanceof Response,
      Response.error() instanceof Response,Response.json({ok:true}).headers instanceof Headers,
      new Request('/post',{method:'POST',body:'hello'}).headers.get('content-type')];
  })())`)).toBe(JSON.stringify([["x-direct", "x-request", "x-response"], true, true, true, true, true, true, true, "text/plain;charset=UTF-8"]));
  await load('<p>new realm</p>');
  expect(await evaluate("Headers.prototype.set.toString().includes('[native code]')")).toBe(true);
  await evaluate("window.fetchHeaders = null; fetch('data:text/plain,hello').then(response => fetchHeaders = response.headers instanceof Headers)");
  await eventually("fetchHeaders", true);
});

test("fetch and response cloning read internal headers without invoking page instrumentation", async () => {
  await load('<p>internal fetch headers</p>');
  expect(await evaluate(`(async () => {
    const original = Headers.prototype.get;
    let calls = 0;
    Headers.prototype.get = function () { calls++; throw new Error('page header hook'); };
    try {
      const response = await fetch('data:application/octet-stream,media-chunk');
      const copy = response.clone();
      const [blob, copiedText] = await Promise.all([response.blob(), copy.text()]);
      const result = [calls, response.headers instanceof Headers, blob.type, await blob.text(), copiedText];
      try { response.headers.get('content-type'); } catch {}
      result.push(calls);
      return result;
    } finally {
      Headers.prototype.get = original;
    }
  })()`)).toEqual([0, true, 'application/octet-stream', 'media-chunk', 'media-chunk', 1]);
});

test("DOMParser returns separate inert documents with page interfaces and XML namespaces", async () => {
  await load('<main id="main">active page</main>');
  expect(await evaluate(`JSON.stringify((() => {
    window.parsedRan=false; window.customRan=0;
    customElements.define('parser-test',class extends HTMLElement {constructor(){super();customRan++;}});
    const parser=new DOMParser();
    const parsed=parser.parseFromString('<!doctype html><html><head><title>parsed</title></head><body><p id="copy">copy</p><parser-test></parser-test><script>parsedRan=true<\/script></body></html>','text/html');
    const xml=parser.parseFromString('<root xmlns="urn:test"><child data-key="value"/></root>','application/xml');
    const other=document.implementation.createHTMLDocument('other');
    const result=[parsed instanceof Document,parsed.body!==document.body,parsed.body.ownerDocument===parsed,
      parsed.title,parsed.defaultView,parsed.location,parsed.currentScript,parsed.readyState,parsed.contentType,
      document.getElementById('main').textContent,parsedRan,customRan,other.body!==document.body,other.title,
      xml.contentType,xml.documentElement.namespaceURI,xml.documentElement.localName,
      new XMLSerializer().serializeToString(xml)];
    document.body.appendChild(document.importNode(parsed.getElementById('copy'),true));
    result.push(document.getElementById('copy').ownerDocument===document);
    try {parser.parseFromString('x','text/plain');} catch(e){result.push(e.name);}
    return result;
  })())`)).toBe(JSON.stringify([true,true,true,"parsed",null,null,null,"complete","text/html","active page",false,0,true,"other",
    "application/xml","urn:test","root",'<root xmlns="urn:test"><child data-key="value"/></root>',true,"TypeError"]));
});

test("details disclosure is clickable and keyboard accessible, including the generated label", async () => {
  await load('<details id="explicit"><summary id="summary">More options</summary><button id="inside">Inside</button></details><details id="implicit">Hidden content</details><div style="height:1200px"></div>');
  const click = async (id) => {
    const [x,y] = JSON.parse(await evaluate(`JSON.stringify((()=>{const r=document.getElementById('${id}').getBoundingClientRect();return [r.left+10,r.top+5]})())`));
    await renderer.call("click",x,y);
  };
  expect(await evaluate("document.getElementById('inside').getBoundingClientRect().height")).toBe(0);
  await click('summary');
  expect(await evaluate("document.getElementById('explicit').open && document.activeElement.id === 'summary'")).toBe(true);
  await renderer.call('press','Enter');
  expect(await evaluate("document.getElementById('explicit').open")).toBe(false);
  await renderer.call('press',' ');
  expect(await evaluate("document.getElementById('explicit').open")).toBe(true);
  expect(await evaluate('window.scrollY')).toBe(0);
  await evaluate("document.getElementById('summary').addEventListener('click',e=>e.preventDefault(),{once:true})");
  await renderer.call('press','Enter');
  expect(await evaluate("document.getElementById('explicit').open")).toBe(true);
  await click('implicit');
  expect(await evaluate("document.getElementById('implicit').open && document.activeElement.id === 'implicit'")).toBe(true);
  await renderer.call('press',' ');
  expect(await evaluate("document.getElementById('implicit').open")).toBe(false);
});

test("shadow slots assign live named children, flatten fallback content and replace manual assignments", async () => {
  await load('<div id="host">text<!--ignore--><b id="named" slot="name">named</b><i id="default">default</i></div><div id="manual"><b id="one">one</b><i id="two">two</i></div>');
  expect(await evaluate(`JSON.stringify((() => {
    const host=document.getElementById('host');
    const root=host.attachShadow({mode:'open'});
    root.innerHTML='<slot id="default"></slot><slot name="name" id="named"></slot><slot name="name" id="duplicate"></slot><slot name="absent" id="fallback"><em>fallback</em></slot>';
    const slots=[...root.querySelectorAll('slot')];
    const result=[slots[0] instanceof HTMLSlotElement,typeof document.body.assignedNodes,
      slots[0].assignedNodes().map(n=>n.nodeType===3?n.data:n.id),slots[0].assignedElements().map(n=>n.id),
      slots[1].assignedNodes().map(n=>n.id),slots[2].assignedNodes().length,
      slots[3].assignedNodes().length,slots[3].assignedElements({flatten:true}).map(n=>n.textContent),
      host.firstChild.assignedSlot===slots[0],document.getElementById('named').assignedSlot===slots[1]];
    document.getElementById('named').slot='';
    result.push(slots[1].assignedNodes().length,slots[0].assignedElements().map(n=>n.id));
    const manual=document.getElementById('manual'),one=document.getElementById('one'),two=document.getElementById('two');
    const manualRoot=manual.attachShadow({mode:'open',slotAssignment:'manual',delegatesFocus:true});
    manualRoot.innerHTML='<slot></slot><slot></slot>';
    const [a,b]=manualRoot.querySelectorAll('slot');
    a.assign(one,two,one); result.push(a.assignedNodes().map(n=>n.id),one.assignedSlot===a);
    b.assign(one); result.push(a.assignedNodes().map(n=>n.id),b.assignedNodes().map(n=>n.id),one.assignedSlot===b);
    a.assign(); result.push(a.assignedNodes().length,two.assignedSlot,manualRoot.slotAssignment,manualRoot.delegatesFocus);
    try {a.assign(document.createComment('bad'));} catch(e) {result.push(e.name);}
    return result;
  })())`)).toBe(JSON.stringify([true,'undefined',['text','default'],['default'],['named'],0,0,['fallback'],true,true,
    0,['named','default'],['one','two'],true,['two'],['one'],true,0,null,'manual',true,'TypeError']));
});

test("HTML parsing adjusts SVG attribute names while XML and DOM setters preserve case", async () => {
  await load('<svg id="svg" viewbox="0 0 10 10" data-Camel="Keep VALUE" DATA-CAMEL="duplicate" preserveaspectratio="none"></svg>');
  expect(await evaluate(`JSON.stringify((() => {
    const svg=document.getElementById('svg');
    const template=document.createElement('template');
    template.innerHTML='<svg data-nextAction$lit$="Lit VALUE" viewBox$lit$="Marker" viewbox="0 0 2 2"></svg>';
    const inner=template.content.firstChild;
    const xml=new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" data-Camel="XML"/>','image/svg+xml');
    svg.setAttribute('data-Other','DOM');
    return [svg.getAttributeNames(),svg.getAttribute('data-camel'),svg.getAttribute('viewBox'),
      inner.getAttributeNames(),inner.getAttribute('data-nextaction$lit$'),inner.getAttribute('viewbox$lit$'),
      xml.documentElement.getAttribute('data-Camel'),xml.documentElement.getAttribute('data-camel'),
      svg.getAttribute('data-Other'),svg.getAttribute('data-other')];
  })())`)).toBe(JSON.stringify([['id','viewBox','data-camel','preserveAspectRatio','data-Other'],'Keep VALUE','0 0 10 10',
    ['data-nextaction$lit$','viewbox$lit$','viewBox'],'Lit VALUE','Marker','XML',null,'DOM',null]));
});

test("constraint validation exposes live state and honors canceled submissions and novalidate", async () => {
  await load('<form id="form"><input id="input" required><button id="submit">Send</button><button id="plain" type="button">Plain</button></form>');
  expect(await evaluate(`JSON.stringify((()=>{
    const input=document.getElementById('input'),form=document.getElementById('form');
    const state=input.validity;
    const result=[state instanceof ValidityState,state===input.validity,state.valueMissing,state.valid,input.willValidate,form.checkValidity()];
    input.value='ready';result.push(state.valid,input.checkValidity());
    input.setCustomValidity('Please correct');result.push(state.customError,state.valid,input.validationMessage,input.reportValidity());
    input.disabled=true;result.push(input.checkValidity(),input.willValidate);input.disabled=false;
    let submissions=[];form.addEventListener('submit',event=>{submissions.push(event.submitter?.id??null);event.preventDefault()});
    form.requestSubmit();result.push(submissions.length);
    form.noValidate=true;form.requestSubmit();form.requestSubmit(document.getElementById('submit'));
    result.push(submissions);
    try{form.requestSubmit(document.getElementById('plain'));}catch(error){result.push(error.name)}
    input.setCustomValidity('');result.push(state.valid,input.validationMessage);
    return result;
  })())`)).toBe(JSON.stringify([true,true,true,false,true,false,true,true,true,false,'Please correct',false,true,false,0,[null,'submit'],'TypeError',true,'']));
});

test("Error keeps native branding and a page-local extensible constructor after SES lockdown", async () => {
  await load('<p>errors</p>');
  expect(await evaluate(`JSON.stringify((()=>{
    const error=Error('message',{cause:'reason'});
    class CustomError extends Error {}
    const custom=new CustomError('custom');
    let native;try{null.missing}catch(e){native=e}
    Object.defineProperty(Error,'extension',{value:1,configurable:true});
    return [typeof Error.isError,error instanceof Error,error.constructor===Error,error.cause,
      custom instanceof CustomError,custom instanceof Error,native instanceof Error,Error.isError(native),
      Error.isError(error),Error.isError(new Proxy(error,{})),Error.isError({[Symbol.toStringTag]:'Error'}),
      Error.isError(Object.create(Error.prototype)),Error.extension];
  })())`)).toBe(JSON.stringify(['function',true,true,'reason',true,true,true,true,true,false,false,false,1]));
  await load('<p>new realm</p>');
  expect(await evaluate('Error.extension')).toBeUndefined();
});

test("BroadcastChannel delivers cloned asynchronous messages and closes without echoing to itself", async () => {
  await load('<p>broadcast</p>');
  await evaluate(`window.received=[];window.echo=0;window.sender=new BroadcastChannel('platform-test');window.receiver=new BroadcastChannel('platform-test');
    sender.onmessage=()=>echo++;
    receiver.onmessage=e=>received.push([e.data.value,e.origin,e.target===receiver,e.isTrusted,e instanceof MessageEvent]);
    const message={value:'before'};sender.postMessage(message);message.value='after';`);
  await eventually('received.length',1);
  expect(await evaluate('JSON.stringify([received,echo,receiver instanceof BroadcastChannel,receiver instanceof EventTarget,receiver.name])'))
    .toBe(JSON.stringify([[['before','https://page.test',true,true,true]],0,true,true,'platform-test']));
  expect(await evaluate(`JSON.stringify((()=>{const errors=[];try{sender.postMessage(()=>{})}catch(e){errors.push(e.name)}receiver.close();try{receiver.postMessage('closed')}catch(e){errors.push(e.name)}sender.postMessage('ignored');sender.close();return errors})())`))
    .toBe(JSON.stringify(['DataCloneError','InvalidStateError']));
  await Bun.sleep(30);
  expect(await evaluate('received.length')).toBe(1);
});

test("developer diagnostics retain error stacks without exposing privileged stack access to pages", async () => {
  await load('<p>diagnostics</p>');
  expect(await evaluate(`JSON.stringify((()=>{
    function diagnosticMarker(){try{null.missing}catch(error){console.error(error);return error.stack}}
    return [typeof getStackString,diagnosticMarker()];
  })())`)).toBe(JSON.stringify(['undefined','']));
  const entries = await renderer.call('consoleMessages');
  expect(entries.some(entry => entry.text.includes('TypeError') && entry.text.includes('diagnosticMarker'))).toBe(true);
});

test("plain Events allow UI-named expandos without inheriting readonly subclass attributes", async () => {
  await load('<button id="button">Focus</button>');
  expect(await evaluate(`JSON.stringify((()=>{'use strict';
    const event=document.createEvent('Event'),target=document.getElementById('button');
    event.initEvent('afterblur',true,false);
    const result=['relatedTarget' in event,'clientX' in event,Object.getPrototypeOf(Event.prototype)===Object.prototype];
    event.relatedTarget=target;event.clientX=25;event.detail='custom';
    document.addEventListener('afterblur',e=>result.push(e.relatedTarget===target,e.clientX,e.detail));
    document.dispatchEvent(event);
    const mouse=new MouseEvent('click');
    result.push(mouse.relatedTarget,mouse.clientX,Object.hasOwn(MouseEvent.prototype,'relatedTarget'));
    const custom=new CustomEvent('example',{detail:7});
    try{custom.detail=8}catch(error){result.push(error.name)}
    result.push(custom.detail);
    return result;
  })())`)).toBe(JSON.stringify([false,false,true,true,25,'custom',null,0,true,'TypeError',7]));
});

test("innerText excludes SVG accessible descriptions and unpainted resource subtrees", async () => {
  await load('<div id="text">Before<svg><title>Label</title><desc>Description</desc><defs><text>Definition</text></defs><path d="M0 0L10 10"/></svg>After</div>');
  expect(await evaluate("document.getElementById('text').innerText")).toBe('BeforeAfter');
  expect(await evaluate("document.getElementById('text').textContent")).toBe('BeforeLabelDescriptionDefinitionAfter');
});

test("innerText and client rectangles exclude closed disclosure content and elements without boxes", async () => {
  await load('<div id="root"><details id="disclosure"><summary>Title</summary><p id="content">Hidden</p><summary>Other</summary></details><details id="bare"><p>Secret</p></details></div><div id="none" style="display:none">Hidden</div><div id="contents" style="display:contents"><span>Visible</span></div><div id="zero" style="width:0;height:0"></div>');
  expect(await evaluate(`JSON.stringify((()=>{
    const ids=['root','disclosure','content','bare','none','contents','zero'],elements=ids.map(id=>document.getElementById(id));
    const result=elements.map(e=>[e.innerText,e.getClientRects().length]);
    result.push(document.createElement('div').getClientRects().length);
    document.getElementById('disclosure').open=true;
    result.push(document.getElementById('disclosure').innerText,document.getElementById('content').getClientRects().length);
    return result;
  })())`)).toBe(JSON.stringify([['Title',1],['Title',1],['',0],['',1],['Hidden',0],['Visible',0],['',1],0,'Title\n\nHidden\n\nOther',1]));
});

test("scrollIntoView honors nearest, center, end, boolean overloads and fixed-position targets", async () => {
  await load(`<style>body{margin:0}</style><div style="position:relative;width:1000px;height:1000px">
    <div id="visible" style="position:absolute;left:70px;top:60px;width:80px;height:30px"></div>
    <div id="target" style="position:absolute;left:480px;top:420px;width:50px;height:40px"></div>
    <div id="large" style="position:absolute;left:50px;top:40px;width:500px;height:400px"></div>
    <div id="fixed" style="position:fixed;left:10px;top:10px;width:20px;height:20px"></div></div>`);
  expect(await evaluate(`JSON.stringify((()=>{
    const position=()=>[scrollX,scrollY],result=[],target=document.getElementById('target');
    document.getElementById('visible').scrollIntoView({block:'nearest',inline:'nearest'});result.push(position());
    target.scrollIntoView({block:'nearest',inline:'nearest'});result.push(position());
    target.scrollIntoView({block:'nearest',inline:'nearest'});result.push(position());
    target.scrollIntoView({block:'center',inline:'center'});result.push(position());
    scrollTo(0,0);target.scrollIntoView(false);result.push(position());
    scrollTo(0,0);target.scrollIntoView();result.push(position());
    scrollTo(100,100);document.getElementById('large').scrollIntoView({block:'nearest',inline:'nearest'});result.push(position());
    document.getElementById('fixed').scrollIntoView();result.push(position());
    try{target.scrollIntoView({block:'invalid'})}catch(error){result.push(error.name)}
    try{target.scrollIntoView({inline:null})}catch(error){result.push(error.name)}
    return result;
  })())`)).toBe(JSON.stringify([[0,0],[130,160],[130,160],[305,290],[130,160],[130,420],[100,100],[100,100],'TypeError','TypeError']));
});

test("link activation retains its target when click handlers replace the clicked descendants", async () => {
  await load('<a id="link" href="/before"><span id="label" style="display:block;width:120px;height:40px">Open</span></a>');
  await evaluate(`document.getElementById('link').addEventListener('click',event=>{event.currentTarget.href='/after';event.currentTarget.textContent='Changed'})`);
  expect(await renderer.call('click', 25, 25)).toBe('https://page.test/after');
  await load('<a id="link" href="/before"><span style="display:block;width:120px;height:40px">Open</span></a>');
  await evaluate(`document.getElementById('link').addEventListener('click',event=>{event.currentTarget.textContent='Changed';event.preventDefault()})`);
  expect(await renderer.call('click', 25, 25)).toBe(null);
});

test("scripted click is composed, suppresses recursive activation and keeps its original link", async () => {
  await load('<div id="host"></div><button id="disabled" disabled>Disabled</button><a id="link" href="#after"><span id="label">Open</span></a>');
  expect(await evaluate(`JSON.stringify((()=>{
    const result=[],host=document.getElementById('host'),root=host.attachShadow({mode:'open'});
    const button=document.createElement('button');root.append(button);
    button.addEventListener('click',event=>{result.push([event.composed,event.isTrusted]);button.click()});
    host.addEventListener('click',()=>result.push('host'));
    button.click();
    document.getElementById('disabled').addEventListener('click',()=>result.push('disabled'));
    document.getElementById('disabled').click();
    document.getElementById('link').addEventListener('click',event=>event.currentTarget.textContent='Changed');
    document.getElementById('label').click();
    result.push(location.hash);
    return result;
  })())`)).toBe(JSON.stringify([[true,false],'host','#after']));
});

test("upgrading declarative custom elements initializes observed properties before connecting", async () => {
  await load('<date-label ts="2026-10-16" ignored="x"></date-label>');
  expect(await evaluate(`JSON.stringify((()=>{
    const reactions=[],original=document.querySelector('date-label');
    let observedReads=0;
    class DateLabel extends HTMLElement {
      static get observedAttributes(){observedReads++;return ['ts']}
      constructor(){super();this.date='';reactions.push(['constructor',this.getAttribute('ts'),customElements.get('date-label')===DateLabel])}
      attributeChangedCallback(name,before,after,namespace){this.date=after;reactions.push(['attribute',name,before,after,namespace])}
      connectedCallback(){reactions.push(['connected',this.date]);this.textContent=this.date}
    }
    customElements.define('date-label',DateLabel);
    reactions.push(['identity',original===document.querySelector('date-label'),original instanceof DateLabel,observedReads]);
    const created=document.createElement('date-label');created.setAttribute('ts','later');document.body.append(created);
    return reactions;
  })())`)).toBe(JSON.stringify([
    ['constructor','2026-10-16',true],['attribute','ts',null,'2026-10-16',null],['connected','2026-10-16'],['identity',true,true,1],
    ['constructor',null,true],['attribute','ts',null,'later',null],['connected','later'],
  ]));
});

test("upgrade reactions keep initial values and constructor mutations in callback order", async () => {
  await load('<mutable-label count="1"></mutable-label><failed-label count="1"></failed-label>');
  expect(await evaluate(`JSON.stringify((()=>{
    const reactions=[];
    class MutableLabel extends HTMLElement {
      static observedAttributes=['count'];
      constructor(){super();this.setAttribute('count','2');reactions.push('constructor')}
      attributeChangedCallback(name,before,after){reactions.push([before,after]);if(after==='1')this.setAttribute('count','3')}
      connectedCallback(){reactions.push('connected')}
    }
    customElements.define('mutable-label',MutableLabel);
    class FailedLabel extends HTMLElement {
      static observedAttributes=['count'];
      constructor(){super();this.setAttribute('count','2');throw Error('failed constructor')}
      attributeChangedCallback(){reactions.push('failed attribute')}
      connectedCallback(){reactions.push('failed connected')}
    }
    try{customElements.define('failed-label',FailedLabel)}catch{}
    return reactions;
  })())`)).toBe(JSON.stringify(['constructor',[null,'1'],['1','2'],['2','3'],'connected']));
});

test("scrollIntoView aligns nested scrollports and container nearest leaves outer scrolling untouched", async () => {
  await load(`<style>body{margin:0}</style><div style="height:1100px;position:relative">
    <div id="scroll" style="position:absolute;left:20px;top:600px;width:200px;height:100px;overflow:auto;border:2px solid">
      <div style="height:400px;position:relative"><div id="target" style="position:absolute;top:160px;left:0;width:30px;height:20px"></div></div>
    </div></div>`);
  expect(await evaluate(`JSON.stringify((()=>{
    const scroller=document.getElementById('scroll'),target=document.getElementById('target'),result=[];
    target.scrollIntoView({block:'nearest',container:'nearest'});result.push([scroller.scrollTop,scrollY]);
    scroller.scrollTop=0;target.scrollIntoView({block:'start'});result.push([scroller.scrollTop,scrollY,target.getBoundingClientRect().top]);
    return result;
  })())`)).toBe(JSON.stringify([[80,0],[160,602,0]]));
});
