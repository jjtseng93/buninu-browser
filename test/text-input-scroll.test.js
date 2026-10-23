import {test,expect} from 'bun:test';
import {createBrowser} from '../lib/headless-shell.js';
import {loadGraphics} from '../lib/renderer/page-renderer.js';
test('text controls clip overflow, keep long inputs on one line and reveal the caret',async()=>{
 const b=await createBrowser({spareRenderer:false});
 const run=s=>b.context.evaluate(s);
 try {
  await b.context.resize(400,300);
  await b.context.navigate('data:text/html,'+encodeURIComponent(`<style>body{margin:0;background:white}input,textarea{display:block;width:200px;box-sizing:border-box;border:1px solid black;padding:4px;font:18px monospace;margin:10px}input{height:36px}textarea{height:100px}</style><input id="i" value="${'abcdef'.repeat(20)}"><textarea id="t">${Array.from({length:12},(_,i)=>'第'+i+'行 abcdef').join('\n')}</textarea><button id="b">after</button>`));
  const state=id=>run(`(()=>{const e=document.getElementById('${id}');return {x:e.scrollLeft,y:e.scrollTop,w:e.scrollWidth,h:e.scrollHeight,rect:e.getBoundingClientRect().toJSON()}})()`);
  const initial=await state('i'),area=await state('t');
  expect(area.rect.y).toBe(56);
  expect((await run(`document.getElementById('b').getBoundingClientRect().top`))).toBeLessThan(180);
  const {CanvasKit:k}=await loadGraphics();
  const ink=async(x,y,w,h)=>{
   const bytes=Buffer.from(await b.context.screenshot({format:'png'}),'base64'),im=k.MakeImageFromEncoded(bytes);
   try{const p=im.readPixels(x,y,{width:w,height:h,colorType:k.ColorType.RGBA_8888,alphaType:k.AlphaType.Unpremul,colorSpace:k.ColorSpace.SRGB});let count=0;for(let i=0;i<p.length;i+=4)if(p[i]<180&&p[i+1]<180&&p[i+2]<180)count++;return count;}finally{im.delete();}
  };
  expect(await ink(212,10,180,145)).toBe(0);
  for(const id of ['i','t']) {
   await run(`document.getElementById('${id}').focus();document.getElementById('${id}').setSelectionRange(0,0)`);
   await b.context.press('End',{modifiers:2});
   const end=await state(id);expect(id==='i'?end.x:end.y).toBeGreaterThan(0);
   if(id==='i'){expect(end.h).toBe(initial.h);expect(await ink(16,16,180,20)).toBeGreaterThan(100);}
   await b.context.press('Home',{modifiers:2});const home=await state(id);expect(id==='i'?home.x:home.y).toBe(0);
   await b.context.press('End',{modifiers:10});const selected=await state(id);expect(id==='i'?selected.x:selected.y).toBeGreaterThan(0);
  }
 }finally{b.close();}
},30000);
