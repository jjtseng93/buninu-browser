import {test,expect} from 'bun:test';
test('partial paint matches full paint for affine rounding, glyphs and borders across DPRs',async()=>{
  const child=Bun.spawn([process.execPath,new URL('./fixtures/paint-damage-geometry.js',import.meta.url).pathname],
    {stdout:'pipe',stderr:'pipe'});
  const [code,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
  expect(stderr).toBe('');expect(code).toBe(0);
},20000);
