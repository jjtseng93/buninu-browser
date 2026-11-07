import {test,expect} from 'bun:test';

test('CSSOM notifications follow current sheet contents without hiding unrelated shadow state',async()=>{
  const child=Bun.spawn([process.execPath,new URL('./fixtures/stylesheet-provenance.js',import.meta.url).pathname],
    {stdout:'pipe',stderr:'pipe'});
  const [code,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
},30000);
