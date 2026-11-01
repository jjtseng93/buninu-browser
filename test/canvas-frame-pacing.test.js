import {test,expect} from 'bun:test';
test('a slow earlier layout does not throttle later Canvas-only frames',async()=>{
 const p=Bun.spawn([process.execPath,new URL('./fixtures/canvas-frame-pacing.js',import.meta.url).pathname],{stdout:'pipe',stderr:'pipe'});
 const [exit,stderr,stdout]=await Promise.all([p.exited,new Response(p.stderr).text(),new Response(p.stdout).text()]);
 expect({exit,stderr}).toEqual({exit:0,stderr:''});
 expect(JSON.parse(stdout).layoutsDuringAnimation).toBe(0);
},15000);
