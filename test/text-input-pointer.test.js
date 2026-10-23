import {test,expect} from 'bun:test';
import {createBrowser} from '../lib/headless-shell.js';
test('pointer places the caret at shaped text, including selected and scrolled controls',async()=>{
 const b=await createBrowser({spareRenderer:false});const run=s=>b.context.evaluate(s);
 try{
  await b.context.resize(500,400);
  await b.context.navigate('data:text/html,'+encodeURIComponent(`<style>body{margin:0}input,textarea{display:block;margin:10px;padding:0;border:0;font:20px monospace;line-height:24px;width:160px}input{height:24px}textarea{height:72px}</style><input id="i" value="abcdefghij"><textarea id="t">abcde\nfghij\nklmno</textarea><input id="p" type="password" value="a😀bcd">`));
  const pos=()=>run('({start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd})');
  // 20px monospace advances approximately 12px. Click the boundary after b.
  await b.context.click(34,20);expect(await pos()).toEqual({start:2,end:2});
  await b.context.press('a',{modifiers:2});await b.context.click(46,20);expect(await pos()).toEqual({start:3,end:3});
  await b.context.type('X');expect(await run('document.getElementById("i").value')).toBe('abcXdefghij');
  await run('document.getElementById("i").value="abcdefghijklmnopqrstuvwxyz"');
  await b.context.press('End');
  expect(await run('document.getElementById("i").scrollLeft')).toBeGreaterThan(0);
  await b.context.click(45,20);const scrolled=await pos();expect(scrolled.start).toBeGreaterThan(10);expect(scrolled.start).toBeLessThan(26);
  const top=await run('document.getElementById("t").getBoundingClientRect().top');
  await b.context.click(34,top+36);expect(await pos()).toEqual({start:8,end:8});
  await b.context.click(400,top+36); // outside must not reposition
  expect(await pos()).toEqual({start:8,end:8});
  await run('document.getElementById("t").value="abcde ".repeat(20);document.getElementById("t").focus();document.getElementById("t").setSelectionRange(0,0)');
  await b.context.click(34,top+36);const wrapped=await pos();expect(wrapped.start).toBeGreaterThan(10);expect(wrapped.start).toBeLessThan(30);
  await b.context.press('End',{modifiers:2});
  expect(await run('document.getElementById("t").scrollTop')).toBeGreaterThan(0);
  await b.context.click(34,top+12);expect((await pos()).start).toBeGreaterThan(60);expect((await pos()).start).toBeLessThan(120);
  const passTop=await run('document.getElementById("p").getBoundingClientRect().top');
  await b.context.click(34,passTop+12);expect(await pos()).toEqual({start:3,end:3});
  await run('document.getElementById("i").onmousedown=e=>e.preventDefault();document.getElementById("i").focus();document.getElementById("i").setSelectionRange(5,5)');
  await b.context.click(12,20);expect(await pos()).toEqual({start:5,end:5});
 }finally{b.close();}
},30000);
