// Build smoke test: actual tools, real Flea backend, no compositor required.
import {mkdtemp,rm} from 'node:fs/promises';
const assert=(ok,message)=>{if(!ok)throw Error(message);};
async function run(args,input='',env={}){
 const p=Bun.spawn(args,{env:{...process.env,PATH:'/usr/local/bin:/usr/bin:/bin',...env},stdin:'pipe',stdout:'pipe',stderr:'pipe'});
 p.stdin.write(input);
 p.stdin.end();
 const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 assert(code===0,`${args.join(' ')} exited ${code}: ${err}`);return out;
}
assert(Bun.version==='1.4.4',`Expected Bun 1.4.4, got ${Bun.version}`);
assert(await Bun.file('/usr/share/mime/globs2').exists(),'Missing MIME database');
assert(await Bun.file('/usr/share/omarchy/qs/Commons/Style.qml').exists(),'Missing Omarchy Commons');
const ansi=await run(['bat','--color=always','--style=plain','--paging=never','--file-name=sample.js','-'],'const answer = 42;\n');
assert(ansi.includes('\x1b[')&&Bun.stripANSI(ansi).includes('const answer = 42;'),'bat adapter did not highlight input');
await run([process.execPath,new URL('./check-highlighting.mjs',import.meta.url).pathname]).then(text=>process.stdout.write(text));
const cache=await mkdtemp('/tmp/flea-build-check-');
try{
 const out=await run(['/usr/bin/flea','--backend'],[
  {c:'list',path:'/root/flea-demo',first:20},{c:'thumb',rows:[0,1,2]},{c:'quit'}
 ].map(x=>JSON.stringify(x)+'\n').join(''),{XDG_CACHE_HOME:cache});
 const replies=out.trim().split('\n').map(x=>JSON.parse(x));
 const thumb=replies.find(x=>x.t==='thumbed'&&x.file);
 assert(thumb,'Flea did not accept placeholder thumbnail: '+out);
 assert((await Bun.file(thumb.file).bytes()).subarray(1,4).toString()==='80,78,71','Invalid PNG');
 const {createBrowser}=await import('/opt/buninu-browser/lib/headless-shell.js');
 const page=await createBrowser({spareRenderer:false});
 try {
  const qml=cache+'/check.qml';
  await Bun.write(qml,'import QtQuick\nRectangle {width:320;height:120;color:"white";Text {text:"Flea QML ready";color:"black"}}');
  await page.context.navigate(Bun.pathToFileURL(qml).href);
  assert((await page.context.evaluate('document.body.innerText')).includes('Flea QML ready'),'QML runtime did not render text');
  assert((await page.context.screenshot({format:'png'})).length>100,'QML screenshot is empty');
 } finally {page.close();}
 console.log('PASS: Bun 1.4.4, MIME, Omarchy imports, jsmdcui ANSI and official Flea thumbnail backend, QML rendering');
}finally{await rm(cache,{recursive:true,force:true});}
