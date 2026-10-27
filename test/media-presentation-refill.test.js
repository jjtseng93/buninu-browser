import {test,expect} from 'bun:test';

test('presentation refill avoids duplicate page decoding and retains local fallbacks',async()=>{
  const child=Bun.spawn([process.execPath,new URL('./fixtures/media-presentation-refill.js',import.meta.url).pathname],{stdout:'pipe',stderr:'pipe'});
  const [out,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect({code,error}).toEqual({code:0,error:''});
  expect(out).toContain('presentation refill avoids duplicate page decode and preserves fallbacks');
},15000);
