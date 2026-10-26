import {test,expect} from 'bun:test';
test('live title reads do not flush pending layout and paint, including empty titles',async()=>{
 const child=Bun.spawn([process.execPath,new URL('./fixtures/title-no-paint.js',import.meta.url).pathname],{stdout:'pipe',stderr:'pipe'});
 const [exit,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
 expect(stderr).toBe('');expect(exit).toBe(0);
},15000);
