import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine} from '../lib/style/computed-style.js';
import {RenderTreeBuilder, renderTreeText} from '../lib/render-tree/index.js';
import {createResourceElements} from '../lib/renderer/resource-elements.js';
import {RendererHost} from '../lib/renderer/host.js';
import {loadGraphics} from '../lib/renderer/page-renderer.js';
import {shadowPublicBoundaries} from './fixtures/shadow-public-boundaries.js';

test('shadow scopes isolate selectors while host, slot and important cascade follow encapsulation', () => {
  const {window, document} = parseHTMLDocument('<body><div id="host" class="host" style="color:red!important"><span slot="main" class="assigned">LIGHT</span><b>UNSLOTTED</b></div><p class="inner">OUTSIDE</p></body>');
  try {
    const host = document.getElementById('host'), shadow = host.attachShadow({mode:'closed'});
    shadow.innerHTML = '<div class="inner"><slot name="main">INACTIVE</slot><slot name="fallback">FALLBACK</slot></div>';
    const scope = new Map([[shadow, [':host{color:blue!important;font-size:23px} .inner{color:purple} .host .inner{color:red} body .inner{color:red} ::SLOTTED(.assigned){color:green!important}']]]);
    const styles = new StyleEngine().compute(document, ['.inner{color:orange}.assigned{color:red}'], {}, null, null, scope);
    expect(styles.get(host).color).toBe('rgba(0, 0, 255, 1)');
    expect(styles.get(shadow.firstElementChild).color).toBe('rgba(128, 0, 128, 1)');
    expect(styles.get(host.firstElementChild).color).toBe('rgba(0, 128, 0, 1)');
    expect(styles.get(host.firstElementChild).fontSize).toBe(23);
    expect(styles.get(document.querySelector('p')).color).toBe('rgba(255, 165, 0, 1)');
    expect(styles.get(host.lastElementChild)).toBeNull();
    expect(renderTreeText(new RenderTreeBuilder().build(document, styles))).toBe('LIGHTFALLBACKOUTSIDE');
    // Inactive fallback and unslotted light DOM never enter layout or pixels.
    expect(shadow.querySelector('slot').childNodes[0].textContent).toBe('INACTIVE');
    host.firstElementChild.removeAttribute('slot');
    styles.compute(document, [], {}, new Set(), null, scope);
    expect(renderTreeText(new RenderTreeBuilder().build(document, styles))).toBe('INACTIVEFALLBACKOUTSIDE');
    host.remove();
    styles.compute(document, [], {}, new Set(), null, new Map());
    expect(styles.incremental).toBeFalse();
    expect(renderTreeText(new RenderTreeBuilder().build(document, styles))).toBe('OUTSIDE');
  } finally {window.happyDOM.close();}
});

test('shared stylesheet text keeps independent scope order and layer ranking', () => {
  const {window, document} = parseHTMLDocument('<div id="a"></div><div id="b"></div><p class="item">O</p>');
  try {
    const roots = ['a','b'].map(id => document.getElementById(id).attachShadow({mode:'open'}));
    for (const root of roots) root.innerHTML = '<span class="item">S</span>';
    const red = '@layer x {.item{color:red!important}}', blue = '@layer y {.item{color:blue!important}}';
    const styles = new StyleEngine();
    for (let i=0;i<4;i++) {
      const order = i%2 ? [blue, red] : [red, blue];
      styles.compute(document, [red, blue], {}, null, null, new Map([[roots[0], order], [roots[1], [...order].reverse()]]));
      expect(styles.get(roots[0].firstChild).color).toBe(i%2 ? 'rgba(0, 0, 255, 1)' : 'rgba(255, 0, 0, 1)');
      expect(styles.get(roots[1].firstChild).color).toBe(i%2 ? 'rgba(255, 0, 0, 1)' : 'rgba(0, 0, 255, 1)');
      expect(styles.get(document.querySelector('p')).color).toBe('rgba(255, 0, 0, 1)');
    }
  } finally {window.happyDOM.close();}
});

test('resource discovery scans new subtrees only and releases detached closed shadow scopes', () => {
  const {window, document} = parseHTMLDocument('<div id="unrelated"><section><span>static</span></section></div><div id="counter"></div>');
  const cache = createResourceElements(document);
  try {
    const counter = document.getElementById('counter'), untouched = document.getElementById('unrelated');
    let scans = 0;
    const children = untouched.children;
    Object.defineProperty(untouched, 'children', {configurable:true,get(){scans++;return children;}});
    const before = cache.get('images');
    for (let i=0;i<20;i++) {
      counter.textContent = String(i);
      counter.append(document.createElement('span'));
      expect(cache.get('images')).toBe(before);
      expect(cache.shadowRoots()).toHaveLength(0);
    }
    expect(scans).toBe(0);
    const host = document.createElement('div'), root = host.attachShadow({mode:'closed'});
    root.innerHTML = '<img src="data:image/png;base64,AA=="><style>span{color:red}</style>';
    document.body.append(host);
    expect(cache.shadowRoots()).toHaveLength(1);
    expect(cache.shadowRoots()[0]).toBe(root);
    expect(cache.get('images')).toHaveLength(1);
    expect(cache.get('images')[0]).toBe(root.firstChild);
    expect(cache.get('sheets')).toHaveLength(0); // no style leakage into document
    host.remove();
    expect(cache.shadowRoots()).toHaveLength(0);
    const removed = cache.get('images');
    root.append(document.createElement('img'));
    expect(cache.get('images')).toBe(removed); // detached root is no longer observed
    document.body.append(host);
    expect(cache.get('images')).toHaveLength(2);
    cache.dispose();
    expect(() => cache.shadowRoots()).toThrow('disposed');
    expect(() => cache.get('images')).toThrow('disposed');
  } finally {cache.dispose();window.happyDOM.close();}
});

test('adopted shadow sheets change real pixels; closed roots, CSSOM and live removal stay isolated', async () => {
  const host = new RendererHost({timeout:20000});
  const {CanvasKit:kit} = await loadGraphics();
  const evaluate = source => host.call('evaluate', source);
  const pixel = async (x,y) => {
    const image = kit.MakeImageFromEncoded(Buffer.from(await host.call('screenshot'), 'base64'));
    try {return [...image.readPixels(x,y,{width:1,height:1,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB})];}
    finally {image.delete();}
  };
  try {
    await host.start();await host.call('resize',160,100,1);
    await host.call('loadDocument',{url:'https://shadow.test/',contentType:'text/html',source:'<!doctype html><style>body{margin:0;background:white}#host{width:80px;height:60px}.box{background:lime}</style><div id="host"><span slot="main">LIGHT</span></div><div class="box" style="width:20px;height:20px"></div>'});
    await host.call('whenLoaded');
    expect(await evaluate(`(()=>{
      globalThis.h=document.getElementById('host');globalThis.r=h.attachShadow({mode:'closed'});
      r.innerHTML='<style>.box{width:80px;height:60px;background:red}</style><div class="box"><slot name="main"></slot><span id="inactive">X</span></div>';
      globalThis.s=new CSSStyleSheet();s.replaceSync('.box{background:blue}');
      globalThis.live=getComputedStyle(r.querySelector('.box'));
      const before=live.backgroundColor;r.adoptedStyleSheets=[s];
      return [before,live.backgroundColor,h.shadowRoot,h.firstChild.assignedSlot,r.styleSheets.length,document.styleSheets.length,r.styleSheets[0].ownerNode===r.firstChild];
    })()`)).toEqual(['rgb(255, 0, 0)','rgb(0, 0, 255)',null,null,1,1,true]);
    expect(await pixel(70,45)).toEqual([0,0,255,255]);
    expect(await pixel(10,70)).toEqual([0,255,0,255]);
    await evaluate(`s.cssRules[0].style.background='purple'`);
    expect(await pixel(70,45)).toEqual([128,0,128,255]);
    await evaluate('r.adoptedStyleSheets.length=0');
    expect(await pixel(70,45)).toEqual([255,0,0,255]);
    await evaluate('h.style.display="none"');
    expect(await pixel(70,45)).toEqual([255,255,255,255]);
    await evaluate('h.style.display="block";h.remove()');
    expect(await evaluate('live.backgroundColor')).toBe('');
    await evaluate('document.body.prepend(h)');
    expect(await evaluate('live.backgroundColor')).toBe('rgb(255, 0, 0)');
    expect(await pixel(70,45)).toEqual([255,0,0,255]);
  } finally {await host.close();}
});

test('shadow overflow clips pixels and input, and wheel chains through the host', async () => {
  const host = new RendererHost({timeout:20000});
  const {CanvasKit:kit} = await loadGraphics();
  const evaluate = source => host.call('evaluate', source);
  try {
    await host.start();await host.call('resize',180,160,1);
    await host.call('loadDocument',{url:'https://shadow.test/',contentType:'text/html',source:'<!doctype html><style>body{margin:0}#host{width:100px;height:80px;overflow:auto}#cover{position:absolute;left:0;top:0;width:30px;height:30px;background:blue}</style><div id="host"></div><div id="cover"></div>'});
    await host.call('whenLoaded');
    await evaluate(`globalThis.events=[];globalThis.targets=[];globalThis.h=document.getElementById('host');globalThis.r=h.attachShadow({mode:'closed'});r.innerHTML='<style>#content{width:100px;height:240px;background:red}button{display:block;width:80px;height:40px;margin:0;border:0;padding:0;background:green}</style><div id="content"><button id="button">CLICK</button></div>';r.querySelector('button').addEventListener('click',e=>{events.push('button');targets.push(['inside',e.target.id,e.srcElement.id]);globalThis.clicked=e});document.getElementById('cover').onclick=()=>events.push('cover');r.querySelector('#content').onclick=()=>events.push('content');document.addEventListener('click',e=>targets.push(['outside',e.target.id,e.srcElement.id]));`);
    const image = kit.MakeImageFromEncoded(Buffer.from(await host.call('screenshot'), 'base64'));
    try {
      const pixel = (x,y) => [...image.readPixels(x,y,{width:1,height:1,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB})];
      expect(pixel(10,10)).toEqual([0,0,255,255]); // later ordinary sibling covers shadow content
      expect(pixel(90,60)).toEqual([255,0,0,255]);
      expect(pixel(60,110)).toEqual([255,255,255,255]); // overflow clipped by the host
    } finally {image.delete();}
    await host.call('click',10,10);expect(await evaluate('events.splice(0)')).toEqual(['cover']);
    expect(await evaluate('targets.splice(0)')).toEqual([['outside','cover','cover']]);
    await host.call('click',60,15);expect(await evaluate('events.splice(0)')).toEqual(['button','content']);
    expect(await evaluate('targets.splice(0)')).toEqual([['inside','button','button'],['outside','host','host']]);
    expect(await evaluate('clicked.target.id')).toBe('host');
    await host.call('click',60,110);expect(await evaluate('events.splice(0)')).toEqual([]);
    // Genuine pointer movement carries native relatedTarget even though the
    // older synthetic MouseEvent constructor does not yet accept that field.
    await host.call('move',10,10);
    await evaluate(`globalThis.moves=[];for(const type of ['mouseover','mouseout']){r.querySelector('button').addEventListener(type,e=>moves.push(['inside',type,e.target.id,e.relatedTarget?.id]));document.addEventListener(type,e=>{moves.push(['outside',type,e.target.id,e.relatedTarget?.id]);if(type==='mouseout'&&e.target.id==='cover')globalThis.departed=e})}`);
    await host.call('move',60,15);await host.call('move',10,10);
    expect(await evaluate('moves')).toEqual([
      ['outside','mouseout','cover','host'],['inside','mouseover','button','cover'],['outside','mouseover','host','cover'],
      ['inside','mouseout','button','cover'],['outside','mouseout','host','cover'],['outside','mouseover','cover','host'],
    ]);
    expect(await evaluate('[departed.target.id,departed.relatedTarget.id]')).toEqual(['cover','host']);
    expect(await host.call('wheel',60,60,0,40)).toEqual({x:0,y:0});
    expect(await evaluate('h.scrollTop')).toBe(40);
    expect(await evaluate('r.querySelector("button").getBoundingClientRect().top')).toBe(-40);
    await evaluate('h.scrollTop=0;r.querySelector("button").scrollIntoView()');
    expect(await evaluate('h.scrollTop')).toBe(0);
  } finally {await host.close();}
});

test('public hits and event targets respect open, closed and nested shadow boundaries', async () => {
  const host=new RendererHost({timeout:20000});
  try {
    await host.start();await host.call('resize',120,120,1);
    await host.call('loadDocument',{url:'https://shadow.test/',contentType:'text/html',source:'<!doctype html><body></body>'});await host.call('whenLoaded');
    const results=await host.call('evaluate',`(${shadowPublicBoundaries})()`);
    for(const record of results.slice(0,6)) {
      expect(record.hits).toEqual(['host',['host','BODY','HTML']]);
      const crossing=[['target','private','private',null],['inner','private','private',null]];
      if(record.modes.length===2)crossing.push(['nested','nested','nested',null],['outer','nested','nested',null]);
      crossing.push(['host','host','host',null],['document','host','host',null]);
      expect(record.crossing).toEqual(crossing);
      expect(record.after).toEqual(['host',null]);
      expect(record.localEvents).toEqual(crossing.slice(0,2));
      expect(record.localAfter).toEqual([null,null]);
    }
    expect(results[6]).toEqual({slotted:['light','light'],hits:['light',['light','slot-host','BODY','HTML']],after:'light'});
    expect(results.slice(7)).toEqual([{moved:false,values:[],after:null},{moved:true,values:['move-host'],after:'move-host'}]);
  } finally {await host.close();}
});

test('closed shadow roots load linked CSS and images without leaking styles into the document', async () => {
  const {CanvasKit:kit} = await loadGraphics();
  const surface = kit.MakeSurface(2,2);
  let png;
  try {
    surface.getCanvas().clear(kit.Color(255,255,0));
    const image = surface.makeImageSnapshot();
    try {png = image.encodeToBytes();} finally {image.delete();}
  } finally {surface.delete();}
  const requested = [];
  const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(request) {
    const path = new URL(request.url).pathname;requested.push(path);
    return path === '/image.png' ? new Response(png,{headers:{'Content-Type':'image/png'}})
      : new Response('.box{width:40px;height:40px;background:blue}img{display:block;width:20px;height:20px}',{headers:{'Content-Type':'text/css'}});
  }});
  const host = new RendererHost({timeout:20000});
  const evaluate = source => host.call('evaluate',source);
  try {
    await host.start();await host.call('resize',120,120,1);
    await host.call('loadDocument',{url:`http://127.0.0.1:${server.port}/`,contentType:'text/html',source:'<!doctype html><style>body{margin:0;background:white}#host{width:80px;height:80px}.box{background:lime}</style><div id="host"></div><div class="box" style="width:20px;height:20px"></div>'});
    await host.call('whenLoaded');
    await evaluate(`globalThis.h=document.getElementById('host');globalThis.r=h.attachShadow({mode:'closed'});r.innerHTML='<link rel="stylesheet" href="/shadow.css"><div class="box"></div><img src="/image.png">'`);
    let ready = false;
    for (let attempt=0;attempt<100;attempt++) {
      ready = await evaluate(`getComputedStyle(r.querySelector('.box')).backgroundColor==='rgb(0, 0, 255)'&&r.querySelector('img').naturalWidth===2`);
      if(ready)break;
      await Bun.sleep(20);
    }
    expect(ready).toBeTrue();
    expect(requested.filter(path=>path==='/shadow.css')).toHaveLength(1);
    expect(requested.filter(path=>path==='/image.png')).toHaveLength(1);
    expect(await evaluate(`[h.shadowRoot,r.styleSheets.length,document.styleSheets.length,r.styleSheets[0].ownerNode===r.firstChild,getComputedStyle(document.querySelector('.box')).backgroundColor]`)).toEqual([null,1,1,true,'rgb(0, 255, 0)']);
    const image = kit.MakeImageFromEncoded(Buffer.from(await host.call('screenshot'),'base64'));
    try {
      const pixel = (x,y) => [...image.readPixels(x,y,{width:1,height:1,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB})];
      expect(pixel(30,20)).toEqual([0,0,255,255]);
      expect(pixel(10,50)).toEqual([255,255,0,255]);
      expect(pixel(10,90)).toEqual([0,255,0,255]);
    } finally {image.delete();}
  } finally {await host.close();server.stop(true);}
});
