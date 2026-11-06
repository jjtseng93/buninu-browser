import {test,expect} from 'bun:test';

test('incremental shadow documents match a full verifier and update rendered pixels', async () => {
  const child=Bun.spawn([process.execPath,Bun.fileURLToPath(new URL('./fixtures/shadow-incremental-renderer.js',import.meta.url))],{stdout:'pipe',stderr:'pipe'});
  const [code,out,error]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect({code,error}).toEqual({code:0,error:''});
  expect(out).toContain('shadow incremental rendering passed');
},20000);
