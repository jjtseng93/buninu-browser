import {test,expect} from 'bun:test';

test('HTML link href preserves resource replacement and scoped style invalidation',async()=>{
  const child=Bun.spawn([process.execPath,new URL('./fixtures/link-href-provenance.js',import.meta.url).pathname],
    {stdout:'pipe',stderr:'pipe'});
  const [code,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
},30000);
