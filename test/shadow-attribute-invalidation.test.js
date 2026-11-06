import {test,expect} from 'bun:test';

test('attribute provenance preserves scoped style updates and independent unknown invalidations',async()=>{
  const child=Bun.spawn([process.execPath,new URL('./fixtures/shadow-attribute-invalidation.js',import.meta.url).pathname],
    {stdout:'pipe',stderr:'pipe'});
  const [code,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
},30000);
