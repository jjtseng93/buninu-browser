import {test,expect} from 'bun:test';

test('disposed modules stop waiting for worker, fetch and top-level await',async()=>{
  const child=Bun.spawn([process.execPath,Bun.fileURLToPath(new URL('./fixtures/module-disposal.js',import.meta.url))],{stdout:'pipe',stderr:'pipe'});
  const [code,out,error]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect({code,error}).toEqual({code:0,error:''});
  expect(out).toContain('module disposal passed');
},20000);
