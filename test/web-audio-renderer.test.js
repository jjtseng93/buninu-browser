import {test,expect} from 'bun:test';

for(const mode of ['ses','host'])test(`${mode} pages synthesize audio through the existing output and release it on navigation`,async()=>{
  const child=Bun.spawn([process.execPath,new URL('./fixtures/web-audio-renderer.js',import.meta.url).pathname,mode],{stdout:'pipe',stderr:'pipe'});
  const [out,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect({code,error}).toEqual({code:0,error:''});
  expect(out).toContain(`${mode} Web Audio page PCM and disposal passed`);
},15000);
