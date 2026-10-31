import {expect,test} from 'bun:test';

test('completed audio releases bounded decoders while preserving metadata, replay and background playback',async()=>{
  const child=Bun.spawn([process.execPath,new URL('./fixtures/media-audio-lifetime.js',import.meta.url).pathname],{stdout:'pipe',stderr:'pipe'});
  const [out,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect({code,error}).toEqual({code:0,error:''});
  expect(out).toContain('audio decoder lifetime integration passed');
},15000);
