import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

test('HTML controls share selection, clipboard and blinking; API reads require user activation',async()=>{
 let clipboard='貼上!',reads=0;
 const host=new RendererHost({clipboardRead:async()=>{reads++;return clipboard;},clipboardWrite:async text=>{clipboard=text;}});
 const run=s=>host.call('evaluate',s);
 const wait=async predicate=>{for(let i=0;i<60;i++){if(await predicate())return;await Bun.sleep(25);}throw Error('Timed out');};
 try {
  await host.start();await host.call('resize',400,200,1);
  await host.call('loadDocument',{url:'https://input.test/',contentType:'text/html',source:`<input id="i" value="abc😀xyz" style="width:300px;height:30px"><textarea id="t">abcd\nxy\n12345</textarea><button id="b">read</button><script>document.getElementById('b').onclick=async()=>{try{window.result=await navigator.clipboard.readText()}catch(e){window.result=e.name}}</script>`});
  await host.call('whenLoaded');
  await run(`document.getElementById('i').focus()`);
  const state=()=>run(`(()=>{let e=document.getElementById('i');return [e.selectionStart,e.selectionEnd,e.value]})()`);
  await host.call('press','a',{modifiers:2});expect((await state()).slice(0,2)).toEqual([0,8]);
  await host.call('press','ArrowRight');expect((await state()).slice(0,2)).toEqual([8,8]);
  await host.call('press','ArrowLeft',{modifiers:8});expect((await state()).slice(0,2)).toEqual([7,8]);
  await host.call('press','c',{modifiers:2});await wait(()=>clipboard==='z');
  await host.call('press','x',{modifiers:2});await wait(async()=>(await state())[2]==='abc😀xy');
  clipboard='漢';await host.call('press','v',{modifiers:2});await wait(async()=>(await state())[2]==='abc😀xy漢');
  await run(`document.getElementById('i').onkeydown=e=>{if(e.ctrlKey)e.preventDefault()}`);
  await host.call('press','a',{modifiers:2});expect((await state()).slice(0,2)).toEqual([8,8]);
  await run(`document.getElementById('t').focus();document.getElementById('t').setSelectionRange(3,3)`);
  await host.call('press','ArrowDown',{modifiers:8});
  expect(await run(`[document.getElementById('t').selectionStart,document.getElementById('t').selectionEnd]`)).toEqual([3,7]);
  await host.call('press','ArrowDown',{modifiers:8});
  expect(await run(`[document.getElementById('t').selectionStart,document.getElementById('t').selectionEnd]`)).toEqual([3,11]);
  await run(`window.result='';document.getElementById('b').click()`);await wait(async()=>(await run('window.result'))!=='');
  // The prior user action has already been consumed by paste, but arrow presses
  // are also user activation. Consume once, then a synthetic click must fail.
  await run(`window.result='';document.getElementById('b').click()`);await wait(async()=>(await run('window.result'))!=='');
  expect(await run('window.result')).toBe('NotAllowedError');
  const b=await run(`document.getElementById('b').getBoundingClientRect().toJSON()`);
  await host.call('click',b.x+b.width/2,b.y+b.height/2);
  await wait(async()=>(await run('window.result'))==='漢');
  expect(reads).toBeGreaterThan(1);
  await run(`document.getElementById('i').onkeydown=null;document.getElementById('i').focus();document.getElementById('i').select();document.getElementById('i').onbeforeinput=e=>e.preventDefault()`);
  clipboard='blocked';await host.call('press','v',{modifiers:2});await Bun.sleep(100);
  expect((await state())[2]).toBe('abc😀xy漢');
  await run(`document.getElementById('i').type='password'`);
  await host.call('press','c',{modifiers:2});await Bun.sleep(100);expect(clipboard).toBe('blocked');
  await run(`document.getElementById('i').type='text'`);
  await run(`document.getElementById('i').focus();document.getElementById('i').setSelectionRange(1,1)`);
  const on=await host.call('screenshot',{format:'png'});await Bun.sleep(550);
  const off=await host.call('screenshot',{format:'png'});expect(off).not.toBe(on);
 } finally {host.close();}
},30000);
