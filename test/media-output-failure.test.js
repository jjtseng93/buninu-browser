import {test,expect} from 'bun:test';
for(const mode of ['opening','playing','recreated'])test(`video continues when audio output fails: ${mode}`,async()=>{
 const child=Bun.spawn([process.execPath,new URL('./fixtures/media-output-failure.js',import.meta.url).pathname,mode],{stdout:'pipe',stderr:'pipe'});
 const timer=setTimeout(()=>child.kill(),15000);
 try{
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect({code,stderr}).toEqual({code:0,stderr:''});
  expect(JSON.parse(stdout).pass).toBe(true);
 }finally{clearTimeout(timer);if(child.exitCode===null)child.kill();}
},20000);
