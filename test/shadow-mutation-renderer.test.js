import {test,expect} from 'bun:test';

test('proven DOM mutations restyle complete shadow hosts without covering unknown state changes',async()=>{
  const child=Bun.spawn([process.execPath,new URL('./fixtures/shadow-mutation-renderer.js',import.meta.url).pathname],
    {stdout:'pipe',stderr:'pipe'});
  const [code,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
},30000);
