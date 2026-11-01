import {test,expect} from 'bun:test';
test('silent video waits for a slow decoder and retains its final frame',async()=>{
 const child=Bun.spawn([process.execPath,new URL('./fixtures/video-slow-end.js',import.meta.url).pathname],{stdout:'pipe',stderr:'pipe'});
 const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect({code,err}).toEqual({code:0,err:''});expect(out).toContain('slow video end integration passed');
},15000);
