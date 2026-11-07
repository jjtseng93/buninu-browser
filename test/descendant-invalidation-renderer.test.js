import {expect, test} from 'bun:test';

test('renderer targeted descendant invalidation matches full style through mixed DOM and scope changes', async () => {
  const child=Bun.spawn([process.execPath,Bun.fileURLToPath(new URL('./fixtures/descendant-invalidation-renderer.js',import.meta.url))],{stdout:'pipe',stderr:'pipe'});
  const [code,out,error]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect({code,error}).toEqual({code:0,error:''});
  expect(out).toContain('targeted descendant rendering passed');
},20000);
