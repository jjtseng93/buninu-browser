import {test, expect} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Inject only a graphics or decoder loader, leaving the real renderer entry and worker
// startup running. A delayed failure must not become a nonfatal page error.
async function launch(mode, target = 'graphics') {
  const dir=await mkdtemp(join(tmpdir(),'renderer-startup-'));
  const preload=join(dir,'preload.js');
  const filter = target === 'graphics' ? /[\\/]page-renderer\.js$/ : /[\\/]wasmpeg[\\/]src[\\/]js[\\/]index\.js$/;
  const load = `function load(){process.send({type:'test-loader-started'});return new Promise((resolve,reject)=>{${mode==='fail' ? "setTimeout(()=>reject(Error('injected startup failure')),10)" : ''}})}`;
  const contents = target === 'graphics' ? `${load};export {load as loadGraphics};export function createPageRenderer(){throw Error('must not build before graphics')}` : `${load};export default {load};`;
  await Bun.write(preload, `import {plugin} from 'bun';
plugin({name:'startup-test',setup(build){build.onLoad({filter:${filter}},()=>({loader:'js',contents:${JSON.stringify(contents)}}));}});`);
  const started=Promise.withResolvers();
  const child=Bun.spawn([process.execPath,'--preload',preload,Bun.fileURLToPath(new URL('../lib/renderer/main.js',import.meta.url))],{stdout:'ignore',stderr:'pipe',ipc(message){if(message?.type==='test-loader-started')started.resolve();}});
  return {child,started:started.promise,async cleanup(){child.kill();await child.exited;await rm(dir,{recursive:true,force:true});}};
}
async function boundedExit(child) {
  let timer;
  try{return await Promise.race([child.exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('renderer did not exit')),5000)})]);}
  finally{clearTimeout(timer);}
}
for (const target of ['graphics','decoder']) test(`${target} startup rejection exits rather than being treated as a page rejection`,async()=>{
  const app=await launch('fail',target);
  try{expect(await boundedExit(app.child)).toBe(1);expect(await new Response(app.child.stderr).text()).toContain(`renderer startup ${target} failed: Error: injected startup failure`);}
  finally{await app.cleanup();}
},10000);
test('controller disconnect exits while graphics initialization is pending',async()=>{
  const app=await launch('pending');
  try{await Promise.race([app.started,app.child.exited.then(()=>{throw Error('renderer exited before loader started')})]);app.child.disconnect();expect(await boundedExit(app.child)).toBe(0);}
  finally{await app.cleanup();}
},10000);
