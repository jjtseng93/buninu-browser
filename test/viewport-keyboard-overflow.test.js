import {test,expect} from 'bun:test';
import {createBrowser} from '../lib/headless-shell.js';

test('root/body overflow blocks keyboard scrolling without blocking script scrolling for hidden overflow',async()=>{
 const browser=await createBrowser({spareRenderer:false}),ctx=browser.context;
 try{
  await ctx.resize(400,300);
  for(const rule of ['body{overflow:hidden}','html{overflow:hidden}','html{overflow:clip}','body{overflow-y:hidden}']){
   await ctx.navigate('data:text/html,'+encodeURIComponent(`<style>body{margin:0}${rule}</style><div style="height:1500px">content</div>`));
   for(const key of [' ','ArrowDown','PageDown','End']){
    await ctx.press(key);expect(await ctx.evaluate('scrollY')).toBe(0);
   }
   if(!rule.includes('clip')){
    await ctx.evaluate('scrollTo(0,100)');expect(await ctx.evaluate('scrollY')).toBe(100);
    await ctx.press('Home');expect(await ctx.evaluate('scrollY')).toBe(100);
   }
  }
  await ctx.navigate('data:text/html,'+encodeURIComponent('<style>body{margin:0}</style><div style="height:1500px">content</div>'));
  await ctx.press(' ');expect(await ctx.evaluate('scrollY')).toBeGreaterThan(0);
  await ctx.evaluate('scrollTo(0,0); document.body.style.overflow="hidden"');
  await ctx.press(' ');expect(await ctx.evaluate('scrollY')).toBe(0);
  await ctx.evaluate('document.body.style.overflow="auto"');
  await ctx.press(' ');expect(await ctx.evaluate('scrollY')).toBeGreaterThan(0);
 }finally{browser.close();}
},30000);
