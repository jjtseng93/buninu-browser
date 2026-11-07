import {expect, test} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {hitTest, interactiveRegions} from '../lib/input/hit-test.js';

function frame(document, nodes) {
  const all = new Set([...document.querySelectorAll('*'), ...nodes]);
  const ids = new Map([...all].map((node, index) => [node, index + 1]));
  const tree = {nodesById:new Map([...ids].map(([domNode,id]) => [id,{id,domNode,style:{}}]))};
  return {tree, id:node => ids.get(node)};
}

function countAttributeReads(elements) {
  const counts = new Map(), restore = [];
  for (const element of elements) {
    const descriptor = Object.getOwnPropertyDescriptor(element, 'hasAttribute');
    const original = element.hasAttribute;
    counts.set(element, 0);
    Object.defineProperty(element, 'hasAttribute', {configurable:true, value:function(name) {
      counts.set(element, counts.get(element) + 1);
      return original.call(this, name);
    }});
    restore.push(() => descriptor ? Object.defineProperty(element, 'hasAttribute', descriptor)
      : delete element.hasAttribute);
  }
  return {counts, restore:() => restore.forEach(fn => fn())};
}

test('wrapped runs and sibling text reuse their nearest interactive ancestor within one collection', () => {
  const f = parseHTMLDocument('<section id="outer" onclick=""><div id="middle"><span id="one">one</span><span id="two">two</span><em id="nested" tabindex="0">nested</em></div></section>');
  const get = id => f.document.getElementById(id);
  const [outer,middle,one,two,nested] = ['outer','middle','one','two','nested'].map(get);
  const nodes = [one.firstChild,two.firstChild,nested.firstChild];
  const {tree,id} = frame(f.document, nodes);
  const layout = {boxes:[],fragments:Array.from({length:6}, (_,index) => ({y:index*12,height:12,runs:[
    {nodeId:id(nodes[0]),x:0,width:20}, {nodeId:id(nodes[1]),x:30,width:20},
    {nodeId:id(nodes[2]),x:60,width:20},
  ]}))};
  const reads = countAttributeReads([outer,middle,one,two,nested]);
  try {
    const regions = interactiveRegions(tree, layout);
    expect(regions.map(region => region.element)).toEqual([outer,nested]);
    expect(regions.map(region => region.rects.length)).toEqual([12,6]);
    expect(regions[0].rects.slice(0,3).map(rect => [rect.left,rect.top])).toEqual([[0,0],[30,0],[0,12]]);
    // Once per ancestor, including the shared noninteractive middle node.
    expect([...reads.counts.values()]).toEqual([1,2,2,2,2]);
    expect(Object.isFrozen(regions[0])).toBe(true);
    expect(Object.isFrozen(regions[0].rects)).toBe(true);
    expect(Object.isFrozen(regions[0].rects[0])).toBe(true);
  } finally {reads.restore();f.window.happyDOM.abort();}
});

test('interaction attributes and reparenting update immediately with the same retained tree and layout', () => {
  const f = parseHTMLDocument('<section id="outer"><span id="owner">text</span></section><div id="other" tabindex="0"></div>');
  const outer = f.document.getElementById('outer'), owner = f.document.getElementById('owner');
  const other = f.document.getElementById('other'), text = owner.firstChild;
  const {tree,id} = frame(f.document, [text]);
  const layout = {boxes:[],fragments:[{y:10,height:10,runs:[{nodeId:id(text),x:10,width:20}]}]};
  const owners = () => interactiveRegions(tree, layout).map(region => region.element);
  try {
    expect(owners()).toEqual([]);
    owner.setAttribute('tabindex','0');
    expect(owners()).toEqual([owner]);
    owner.removeAttribute('tabindex');outer.setAttribute('onclick','');
    expect(owners()).toEqual([outer]);
    other.appendChild(text);
    expect(owners()).toEqual([other]);
    other.removeAttribute('tabindex');
    expect(owners()).toEqual([]);
    other.setAttribute('onclick','');
    expect(hitTest(tree,layout,11,11)?.element).toBe(other);
  } finally {f.window.happyDOM.abort();}
});

test('closed shadow roots and slotted text follow their composed interactive ancestors', () => {
  const f = parseHTMLDocument('<section id="host" onclick=""><span slot="main">light</span></section>');
  const host = f.document.getElementById('host'), shadow = host.attachShadow({mode:'closed'});
  shadow.innerHTML = '<div id="inner" tabindex="0"><slot name="main"></slot><span>shadow</span></div>';
  const inner = shadow.firstElementChild, slot = inner.firstElementChild;
  const lightText = host.firstElementChild.firstChild, shadowText = inner.lastElementChild.firstChild;
  const {tree,id} = frame(f.document, [inner,slot,inner.lastElementChild,lightText,shadowText]);
  const layout = {boxes:[],fragments:[{y:0,height:10,runs:[
    {nodeId:id(lightText),x:0,width:20}, {nodeId:id(shadowText),x:20,width:20},
  ]}]};
  try {
    const regions = interactiveRegions(tree,layout);
    expect(regions.map(region => region.element)).toEqual([inner]);
    expect(regions[0].rects).toHaveLength(2);
    inner.removeAttribute('tabindex');
    expect(interactiveRegions(tree,layout).map(region => region.element)).toEqual([host]);
  } finally {f.window.happyDOM.abort();}
});

test('viewport rejection preserves exact text edges and partial rectangles before walking the DOM', () => {
  const f = parseHTMLDocument('<span id="visible" tabindex="0">visible</span><span id="outside" tabindex="0">outside</span>');
  const visible = f.document.getElementById('visible'), outside = f.document.getElementById('outside');
  const {tree,id} = frame(f.document, [visible.firstChild,outside.firstChild]);
  const make = (node,left,top,width,height) => ({y:top+30,height,runs:[{nodeId:id(node.firstChild),x:left+20,width}]});
  const layout = {boxes:[],fragments:[
    make(outside,-10,0,10,10), // right == 0
    make(outside,0,-10,10,10), // bottom == 0
    make(outside,100,0,10,10), // left == width
    make(outside,0,80,10,10), // top == height
    make(visible,-3,-4,8,9),
    make(visible,95,75,10,10),
    make(visible,50,50,0,10), // Existing empty text-run geometry is retained.
  ]};
  const reads = countAttributeReads([outside]);
  try {
    const scroll = {x:20,y:30}, viewport = {width:100,height:80};
    const regions = interactiveRegions(tree,layout,scroll,viewport);
    expect(regions.map(region => region.element)).toEqual([visible]);
    expect(regions[0].rects.map(rect => [rect.left,rect.top,rect.right,rect.bottom])).toEqual([
      [-3,-4,5,5], [95,75,105,85], [50,50,50,60],
    ]);
    expect(reads.counts.get(outside)).toBe(0);
    expect(hitTest(tree,layout,0,0,scroll,viewport)?.element).toBe(visible);
    expect(hitTest(tree,layout,5,0,scroll,viewport)).toBe(null); // right edge is exclusive
    expect(hitTest(tree,layout,0,5,scroll,viewport)).toBe(null); // bottom edge is exclusive
  } finally {reads.restore();f.window.happyDOM.abort();}
});

test('control boxes retain dimensions, clipping-independent geometry and per-run hit eligibility', () => {
  const f = parseHTMLDocument('<div id="ancestor" style="overflow:hidden;position:absolute;top:-300px"><button id="fixed" style="position:fixed">fixed</button><button id="off">off</button></div><div id="owner" onclick=""><span id="hidden">hidden</span><span id="shown">shown</span></div>');
  const get = name => f.document.getElementById(name);
  const ancestor=get('ancestor'), fixed=get('fixed'), off=get('off'), owner=get('owner');
  const hidden=get('hidden'), shown=get('shown');
  const {tree,id} = frame(f.document, [fixed.firstChild,hidden.firstChild,shown.firstChild]);
  tree.nodesById.get(id(hidden)).style = {visibility:'hidden'};
  tree.nodesById.get(id(shown)).style = {visibility:'visible'};
  const layout = {boxes:[
    {nodeId:id(ancestor),x:0,y:-300,width:100,height:10},
    {nodeId:id(fixed),x:10,y:10,width:40,height:20},
    {nodeId:id(off),x:-20,y:0,width:20,height:20},
    {nodeId:id(off),x:0,y:-20,width:20,height:20},
    {nodeId:id(off),x:100,y:0,width:20,height:20},
    {nodeId:id(off),x:0,y:80,width:20,height:20},
    {nodeId:id(off),x:0,y:0,width:0,height:20},
    {nodeId:id(off),x:0,y:0,width:20,height:0},
  ],fragments:[{y:10,height:10,runs:[{nodeId:id(fixed.firstChild),x:12,width:20}]},
    {y:40,height:10,runs:[{nodeId:id(hidden.firstChild),x:0,width:20},{nodeId:id(shown.firstChild),x:30,width:20}]}]};
  try {
    const regions = interactiveRegions(tree,layout,{x:0,y:0},{width:100,height:80});
    // Reject each run/box, never its offscreen ancestor: a fixed descendant
    // can still contribute visible geometry. Precise paint clipping is separate.
    expect(regions.map(region => region.element)).toEqual([fixed,owner]);
    expect(regions[0].rects.map(rect => [rect.left,rect.top,rect.width,rect.height])).toEqual([[12,10,20,10],[10,10,40,20]]);
    expect(regions[1].rects).toHaveLength(1);
    expect(regions[1].rects[0].left).toBe(30);
    expect(hitTest(tree,layout,49,29,{x:0,y:0},{width:100,height:80})?.element).toBe(fixed);
  } finally {f.window.happyDOM.abort();}
});
