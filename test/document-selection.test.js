import {test,expect} from 'bun:test';
import {createBrowser} from '../lib/headless-shell.js';
test('drag selects document text and controls without stealing canceled mouse gestures',async()=>{
 let copied='';const b=await createBrowser({spareRenderer:false,clipboard:{read:async()=>copied,write:async text=>{copied=text}}});
 const c=b.context,run=s=>c.evaluate(s);
 const down=(x,y)=>c.pointerButton(x,y,272,1),up=(x,y)=>c.pointerButton(x,y,272,0);
 try{
 await c.resize(500,300,1);await c.navigate('data:text/html,'+encodeURIComponent('<style>body{margin:0;font:20px monospace}p{margin:0;height:30px}input{font:20px monospace;padding:0;border:0}</style><p id=a>abcdefghij</p><p id=b>klmnopqrst</p><input value="abcdefghij">'));
 await down(12,12);await c.move(60,12);await up(60,12);
 expect(await run('getSelection().toString()')).toBe('bcde');
 await c.press('c',{modifiers:2});for(let i=0;i<50&&!copied;i++)await Bun.sleep(10);expect(copied).toBe('bcde');
 await down(60,12);await c.move(12,12);await up(12,12);expect(await run('getSelection().toString()')).toBe('bcde');
 await down(12,12);await c.move(36,42);await up(36,42);expect(await run('getSelection().toString()')).toContain('klm');
 await down(12,72);await c.move(60,72);await up(60,72);
 expect(await run('(()=>{const e=document.querySelector("input");return [e.selectionStart,e.selectionEnd]})()')).toEqual([1,5]);
 await run('document.getElementById("a").onmousedown=e=>e.preventDefault();getSelection().removeAllRanges()');
 await down(12,12);await c.move(60,12);await up(60,12);expect(await run('getSelection().toString()')).toBe('');
 await run('getSelection().selectAllChildren(document.getElementById("a"))');expect(await run('getSelection().toString()')).toBe('abcdefghij');
 expect(await run('document.getSelection()===window.getSelection()')).toBe(true);
 await run('document.getElementById("a").onmousedown=null;document.getElementById("a").style.userSelect="none";getSelection().removeAllRanges()');
 await down(12,12);await c.move(60,12);await up(60,12);expect(await run('getSelection().toString()')).toBe('');
 await run('document.getElementById("a").style.userSelect="text";getSelection().selectAllChildren(document.getElementById("a"))');
 await run('globalThis.selectedRange=getSelection().getRangeAt(0);getSelection().removeAllRanges();getSelection().addRange(selectedRange)');
 expect(await run('getSelection().toString()')).toBe('abcdefghij');
 await Bun.write('/tmp/document-selection.png'  ,Buffer.from(await c.screenshot({format:'png'}),'base64'));
 }finally{b.close()}
},30000);
