import {test,expect} from 'bun:test';
test('fractional font sizes retain the final glyph at different device scales',async()=>{
 const child=Bun.spawn([process.execPath,new URL('./fixtures/fractional-text-scale.js',import.meta.url).pathname],{stdout:'pipe',stderr:'pipe'});
 const [exit,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
 expect({exit,stderr}).toEqual({exit:0,stderr:''});
},30000);
