import {expect,test} from 'bun:test';
test('reinserted subtrees keep relational selector caches equivalent to a fresh renderer',async()=>{
  const child=Bun.spawn([process.execPath,Bun.fileURLToPath(new URL('./fixtures/record-inserted-state.js',import.meta.url))],{stdout:'pipe',stderr:'pipe'});
  const [code,out,error]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect({code,error}).toEqual({code:0,error:''});expect(out).toContain('inserted state snapshots passed');
},20000);
