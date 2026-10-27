import {test,expect} from 'bun:test';

test('independent media coalesces page UI painting while pause, seek and native controls remain live',async()=>{
  const child=Bun.spawn([process.execPath,new URL('./fixtures/media-repaint.js',import.meta.url).pathname],{stdout:'pipe',stderr:'pipe'});
  const [out,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect({code,error}).toEqual({code:0,error:''});
  expect(out).toContain('media repaint integration passed');
},15000);
