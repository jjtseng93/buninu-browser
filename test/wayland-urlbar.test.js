import {test,expect} from 'bun:test';
import {WaylandUrlBar,WAYLAND_COMMANDS} from '../frontends/wayland/urlbar.js';
const history={list:()=>[],add(){}};
test('Wayland chrome retains Casty selection, insert-paste, mode switch and commands',async()=>{
 let copied='',quit=false;const navigated=[];
 const context={url:'https://example.com/',navigate:async url=>navigated.push(url)};
 const bar=new WaylandUrlBar(context,{history,close:()=>quit=true,clipboard:{read:async()=>'/x',write:async text=>copied=text}});
 try{
  bar.updateURL(context.url);bar.open();
  expect(bar.editor.selectedText).toBe(context.url);
  await bar.press('ArrowRight');expect(bar.editor.selectedText).toBe('');
  await bar.press('ArrowLeft',{modifiers:8});expect(bar.editor.selectedText).toBe('/');
  await bar.press('c',{modifiers:2});expect(copied).toBe('/');
  await bar.press('v',{modifiers:2});expect(bar.editor.text).toBe('https://example.com/x');
  await bar.press('ArrowRight');await bar.press('v',{modifiers:2});
  expect(bar.editor.text).toBe('https://example.com/x/x');
  await bar.press('ArrowLeft',{modifiers:8});
  await bar.press('c',{modifiers:1});expect(copied).toBe('x');
  await bar.press('Tab');expect(bar.editor.mode).toBe('cmd');
  await bar.press('Tab');expect(bar.editor.mode).toBe('url');
  await bar.press('Escape');expect(bar.editor.editing).toBe(false);
  await bar.command('open https://example.org/');expect(navigated).toEqual(['https://example.org/']);
  expect(WAYLAND_COMMANDS.some(c=>c.name==='cdp')).toBe(false);
  await bar.command('q');expect(quit).toBe(true);
 }finally{bar.dispose();}
});
test('Toolbar raster cache and horizontal scrolling preserve page-independent rendering',async()=>{
 const bar=await new WaylandUrlBar({},{history}).initialize();
 try{
  bar.updateURL('https://example.com/'+'long-path/'.repeat(20));
  const pixels=bar.pixels(320);expect(pixels.length).toBe(320*32*4);expect(bar.pixels(320)).toBe(pixels);
  bar.open();await bar.press('ArrowRight');bar.pixels(320);
  expect(bar.editor._scrollX).toBeGreaterThan(0);
  await bar.press('Home');bar.pixels(320);expect(bar.editor._scrollX).toBe(0);
  bar.editor.pointerDown(5,1000);bar.editor.pointerMove(10);bar.editor.pointerUp();
  expect(bar.editor.selectedText.length).toBeGreaterThan(0);
 }finally{bar.dispose();}
});

test('Wayland chrome forwards page click counts through zoom and bar offset',async()=>{
 const clicks=[];
 const bar=new WaylandUrlBar({url:'about:blank',click:(...args)=>clicks.push(args)},{history,close(){},clipboard:{read:async()=>'',write:async()=>{}}});
 try{
  bar.zoom=2;
  await bar.pointerButton(40,bar.height+60,272,1,{clickCount:2});
  await bar.pointerButton(40,bar.height+60,272,0,{clickCount:2});
  expect(clicks).toEqual([[20,30,{clickCount:2}]]);
 }finally{bar.dispose()}
});

test('Wayland toolbar forwards right/middle page clicks but ignores them on chrome',async()=>{
 const clicks=[];const bar=new WaylandUrlBar({click:(...a)=>clicks.push(a)},{history});
 try{
  for(const code of [273,274]){
   await bar.pointerButton(40,bar.height+60,code,1);
   await bar.pointerButton(40,bar.height+60,code,0);
   await bar.pointerButton(40,5,code,0);
  }
  expect(clicks.map(c=>c[2].button)).toEqual(['right','middle']);
 }finally{bar.dispose()}
});

test('Wayland address Ctrl-U/K survive page focus, and Escape/navigation discard only the draft',async()=>{
 const bar=new WaylandUrlBar({pointerButton(){}},{history});
 try{
  bar.updateURL('https://example.com/');bar.open(false,'前😀後尾');
  bar.editor.moveCursor(2);
  await bar.press('u',{modifiers:2});await bar.press('k',{modifiers:2});
  expect(bar.editor.text).toBe('');
  await bar.pointerButton(40,80,272,1);await bar.pointerButton(40,80,272,0);
  bar.open();expect(bar.editor.text).toBe('');expect(bar.editor.cursor).toBe(0);
  await bar.press('u',{modifiers:2});await bar.press('k',{modifiers:2});
  expect(bar.editor.text).toBe('前😀後尾');
  await bar.press('Escape');bar.open();expect(bar.editor.text).toBe('https://example.com/');
  bar.editor._setText('draft');await bar.press('u',{modifiers:2});
  await bar.pointerButton(40,80,272,1);await bar.pointerButton(40,80,272,0);
  bar.updateURL('https://new.example/');bar.open();
  expect(bar.editor.text).toBe('https://new.example/');expect(bar.editor._savedHead).toBe('draft');
 }finally{bar.dispose();}
});

test('Wayland address copy/paste/quit honor Casty bindings without forwarding to the page',async()=>{
 let copied='',quit=0,reads=0;
 const bar=new WaylandUrlBar({press(){throw Error('Editor key leaked to page');}},{history,close:()=>quit++,
  clipboard:{write:async text=>copied=text,read:async()=>{reads++;return '中😀';}}});
 try{
  bar.open(false,'abcdef');bar.editor.moveCursor(2);bar.editor.moveCursor(4,true);
  await bar.press('c',{modifiers:2});expect(copied).toBe('cd');
  await bar.press('v',{modifiers:2});expect(bar.editor.text).toBe('ab中😀ef');
  bar.editor.moveCursor(2);await bar.press('v',{modifiers:2});expect(bar.editor.text).toBe('ab中😀中😀ef');
  await bar.press('c',{modifiers:2});expect(copied).toBe(bar.editor.text);
  // Remapped editor actions use the same configuration as page actions.
  bar.bindings['ctrl+y']='copy';bar.bindings['ctrl+b']='paste';bar.bindings['ctrl+j']='quit';
  await bar.press('y',{modifiers:2});expect(copied).toBe(bar.editor.text);
  await bar.press('b',{modifiers:2});expect(reads).toBe(3);
  await bar.press('q',{modifiers:2});expect(quit).toBe(1);
  await bar.press('j',{modifiers:2});expect(quit).toBe(2);
 }finally{bar.dispose();}
});
