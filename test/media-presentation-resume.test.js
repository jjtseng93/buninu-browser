import {test,expect} from 'bun:test';
const cases=['visible','unchanged','file','file-eof','hidden','removed','rotated','multiple','epoch','backward','forward','silent','audio-done'];
for(const mode of cases)test(`paused presentation resume: ${mode}`,async()=>{
 const fixture=mode==='silent'||mode==='audio-done'?'media-presentation-resume-clock.js':'media-presentation-resume.js';
 const child=Bun.spawn([process.execPath,new URL('./fixtures/'+fixture,import.meta.url).pathname,mode],{stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect({code,stderr}).toEqual({code:0,stderr:''});
 expect(JSON.parse(stdout).pass).toBe(true);
},30_000);
