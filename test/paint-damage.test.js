import {test, expect} from 'bun:test';
import {displayListDamage} from '../lib/paint/paint-damage.js';

const tile = {x:0,y:0,width:400,height:300};
const box = (x, y, width, height, extra = {}) => ({op:'fillRect',bounds:{x,y,width,height},color:'red',...extra});
const list = (items, images = []) => ({items,images});
const recolor = item => ({...item,color:'blue'});

test('damage covers both positions, added/removed items and replaced image resources', () => {
  const old = box(10,20,10,15), next = box(50,30,10,15);
  expect(displayListDamage(list([old]),list([next]),tile)).toEqual({x:8,y:18,right:62,bottom:47});
  expect(displayListDamage(list([]),list([old]),tile)).toEqual({x:8,y:18,right:22,bottom:37});
  expect(displayListDamage(list([old]),list([]),tile)).toEqual({x:8,y:18,right:22,bottom:37});
  const image = box(10,20,10,15,{op:'drawImage',image:0}), first = {}, second = {};
  expect(displayListDamage(list([image],[first]),list([image],[second]),tile)).not.toBeNull();
  expect(displayListDamage(list([image],[first]),list([image],[first]),tile)).toBeNull();
});

test('negative or overflowing bounds cannot keep expansion running', () => {
  const item = box(0,40,30,10), shadow = box(20,20,-20,60,{op:'drawShadow'});
  expect(displayListDamage(list([shadow,item]),list([shadow,recolor(item)]),tile)).toBeNull();
  for (const bounds of [{x:Infinity,y:0,width:10,height:10},
    {x:Number.MAX_VALUE,y:0,width:Number.MAX_VALUE,height:10},
    {x:0,y:0,width:10,height:-1}]) {
    const curve = {...shadow,bounds};
    expect(displayListDamage(list([curve,item]),list([curve,recolor(item)]),tile)).toBeNull();
  }
});

test('a small changed box includes overlapping curved paint without spanning the tile', () => {
  const item = box(70,50,10,10), rounded = box(40,40,60,50,{radii:{x:8,y:8}});
  const damage = displayListDamage(list([rounded,item]),list([rounded,recolor(item)]),tile);
  expect(damage).toEqual({x:38,y:38,right:102,bottom:92});
});

test('long reverse-ordered curve chains have a bounded full-repaint fallback', () => {
  const changed = box(0,5,1,1);
  const curves = Array.from({length:2000},(_,i)=>box((1999-i)*10,0,10,10,{radii:{x:1,y:1}}));
  expect(displayListDamage(list([...curves,changed]),list([...curves,recolor(changed)]),
    {x:0,y:0,width:40000,height:100})).toBeNull();
});

test('off-tile curve chains cannot drag a local update into distant content', () => {
  const changed = box(0,5,1,1);
  const curves = Array.from({length:2000},(_,i)=>box((1999-i)*10+20,0,10,10,{radii:{x:1,y:1}}));
  const damage = displayListDamage(list([...curves,changed]),list([...curves,recolor(changed)]),
    {x:0,y:0,width:10,height:100});
  expect(damage).toEqual({x:0,y:3,right:3,bottom:8});
});

test('damage covering the tile and video/fixed changes use complete paint', () => {
  const item = box(0,0,400,300);
  expect(displayListDamage(list([item]),list([recolor(item)]),tile)).toBeNull();
  for (const extra of [{fixed:true},{op:'drawVideo'}]) {
    const item = box(20,20,10,10,extra);
    expect(displayListDamage(list([item]),list([recolor(item)]),tile)).toBeNull();
  }
});

test('unchanged fixed curves use viewport coordinates after scrolling', () => {
  const fixed = box(10,10,50,50,{fixed:true,radii:{x:8,y:8}}), item = box(120,120,5,5);
  const region = {x:100,y:100,width:100,height:100};
  expect(displayListDamage(list([fixed,item]),list([fixed,recolor(item)]),region,1,{x:100,y:100})).toBeNull();
});

test('zooming out keeps at least two physical pixels of edge padding', () => {
  const item = box(20,20,10,10);
  expect(displayListDamage(list([item]),list([recolor(item)]),tile,.5)).toEqual({x:16,y:16,right:34,bottom:34});
  expect(displayListDamage(list([item]),list([recolor(item)]),tile,0)).toBeNull();
});

test('affine transforms scale glyph overhang and rounded-coordinate padding', () => {
  const image = box(100,100,10,10,{op:'drawImage',transform:{a:8,b:0,c:3,d:.5}});
  const damage = displayListDamage(list([image]),list([recolor(image)]),{...tile,width:1000,height:1000});
  expect(damage).toEqual({x:78,y:78,right:132,bottom:132});
  const text = box(100,100,10,10,{op:'drawText',font:{size:10},transform:{a:2,b:1,c:1,d:2}});
  expect(displayListDamage(list([text]),list([recolor(text)]),{...tile,width:1000,height:1000}))
    .toEqual({x:40,y:40,right:170,bottom:170});
});

test('square borders are also sensitive to clipping through their antialiased paint', () => {
  const border = box(30,30,50,50,{op:'border'}), item = box(30,30,5,5);
  expect(displayListDamage(list([border,item]),list([border,recolor(item)]),tile))
    .toEqual({x:28,y:28,right:82,bottom:82});
});

test('native scissors stay inside the finite tile even for distant CSS bounds', () => {
  const item = box(-1e100,20,1e100,10);
  expect(displayListDamage(list([item]),list([recolor(item)]),tile))
    .toEqual({x:0,y:18,right:2,bottom:32});
});
