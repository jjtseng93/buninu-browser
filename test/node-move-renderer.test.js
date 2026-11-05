import {test,expect} from 'bun:test';

test('atomic move preserves decoder sessions, advancing media/CSS timelines and iframe timers', async () => {
  const child=Bun.spawn([process.execPath,new URL('./fixtures/node-move-state.js',import.meta.url).pathname],{stdout:'pipe',stderr:'pipe'});
  const [out,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect({code,error}).toEqual({code:0,error:''});
  expect(out).toContain('Atomic move renderer media/animation/iframe preservation passed');
},15000);
