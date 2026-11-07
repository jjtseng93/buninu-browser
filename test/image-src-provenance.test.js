import {test,expect} from 'bun:test';

test('HTML image src keeps image lifecycle and targeted style invalidation',async()=>{
  const child=Bun.spawn([process.execPath,new URL('./fixtures/image-src-provenance.js',import.meta.url).pathname],
    {stdout:'pipe',stderr:'pipe'});
  const [code,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
},30000);
