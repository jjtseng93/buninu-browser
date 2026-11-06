import {test,expect} from 'bun:test';

test('release activates its known target without intermediate painting, preserving mutations and defaults',async()=>{
  const child=Bun.spawn([process.execPath,new URL('./fixtures/pointer-release-activation.js',import.meta.url).pathname],
    {stdout:'pipe',stderr:'pipe'});
  const [code,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
},30000);
