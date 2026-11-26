import {test,expect} from 'bun:test';
import {fileURLToPath} from 'node:url';
async function runFixture(name, ...args){
 const child=Bun.spawn([process.execPath,fileURLToPath(new URL('./fixtures/'+name,import.meta.url)),...args],{stdout:'pipe',stderr:'pipe'});
 const timer=setTimeout(()=>child.kill(),15000);
 try{
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect({code,stderr}).toEqual({code:0,stderr:''});
  expect(JSON.parse(stdout).pass).toBe(true);
 }finally{clearTimeout(timer);if(child.exitCode===null)child.kill();}
}
for(const mode of ['opening','playing','recreated'])test(`video continues when audio output fails: ${mode}`,
 ()=>runFixture('media-output-failure.js',mode),20000);
test('video worker presents and seeks through the silent tail after audio drains',
 ()=>runFixture('media-short-audio.js'),20000);

test('video advances when a completed media source contains only audio initialization data',
 ()=>runFixture('media-completed-without-audio.js'),20000);
