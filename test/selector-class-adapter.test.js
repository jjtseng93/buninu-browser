import {test,expect} from 'bun:test';

test('class selector fast path agrees with the unmodified matcher across every attribute mutation path',async()=>{
  // A fresh process captures the vendor reference before parser adapters are
  // installed, independently of which other suites have imported the parser.
  const child=Bun.spawn([process.execPath,new URL('./fixtures/selector-class-adapter.js',import.meta.url).pathname],
    {stdout:'pipe',stderr:'pipe'});
  const [code,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
},10000);
