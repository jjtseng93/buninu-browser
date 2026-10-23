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
