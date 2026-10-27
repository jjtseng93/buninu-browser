import {test,expect} from 'bun:test';

test('spare warmup follows document load with bounded fallback and safe cancellation',async()=>{
  const child=Bun.spawn([process.execPath,new URL('./fixtures/spare-renderer-scheduling.js',import.meta.url).pathname],{stdout:'pipe',stderr:'pipe'});
  const [out,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect({code,error}).toEqual({code:0,error:''});
  expect(out).toContain('spare scheduling lifecycle, isolation, cancellation and failure checks passed');
},15000);
