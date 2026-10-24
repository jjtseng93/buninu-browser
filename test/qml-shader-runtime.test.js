import {test,expect} from 'bun:test';
test('local QML fragment paints and reactive uniforms repaint on software HTML canvas',async()=>{
 const child=Bun.spawn([process.execPath,new URL('./fixtures/qml-shader-check.mjs',import.meta.url).pathname],{stdout:'pipe',stderr:'pipe'});
 const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect({exit,stderr}).toEqual({exit:0,stderr:''});
},30000);
