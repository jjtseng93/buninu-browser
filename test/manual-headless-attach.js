// Native Termux: bun test/manual-headless-attach.js [output-directory]
// Requires the sibling Casty checkout. Uses a real Casty PTY and a Kitty peer;
// this verifies image delivery and keyboard input, not WebView presentation.
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
import {KittyPeer} from './manual-casty-home-startup.js';
import {CDP} from '../tools/browser-lab.js';
const out=resolve(Bun.argv[2]??join(tmpdir(),'headless-attach-check'));mkdirSync(out,{recursive:true});
const root=resolve(import.meta.dir,'..');
const site=Bun.serve({port:0,fetch:()=>new Response('<title>Headless attach</title><body style="background:#182030;color:white"><h1>Existing headless page</h1><input id="edit" style="font-size:24px"><script>globalThis.starts=(globalThis.starts||0)+1</script>',{headers:{'content-type':'text/html'}})});
let browser,viewer,cdp,terminal,log='',tail='',frame=null,frames=0;
const wait=async predicate=>{const end=Date.now()+30000;while(Date.now()<end){if(await predicate())return;if(viewer&&viewer.exitCode!==null)throw Error('Casty exited: '+tail);await Bun.sleep(40)}throw Error('Timed out: '+tail.slice(-1000)+' '+log.slice(-1000));};
try{
 browser=Bun.spawn([process.execPath,join(root,'index.js'),'--headless','--remote-debugging-port=0','--window-size=640,360',`http://127.0.0.1:${site.port}/`],{stdout:'ignore',stderr:'pipe'});
 void(async()=>{for await(const chunk of browser.stderr)log+=Buffer.from(chunk).toString()})();
 await wait(()=>log.includes('DevTools listening on'));
 const endpoint=log.match(/DevTools listening on (ws:\/\/\S+)/)[1];
 cdp=new CDP(endpoint);await cdp.ready;
 const [{targetId}]=(await cdp.send('Target.getTargets')).targetInfos;
 cdp.sessionId=(await cdp.send('Target.attachToTarget',{targetId,flatten:true})).sessionId;
 await wait(async()=>await cdp.evaluate('document.title')==='Headless attach');
 const peer=new KittyPeer({write:bytes=>terminal.write(bytes),frame(bytes,transport,fields){if(fields.i==='1'){frame=bytes;frames++}}});
 viewer=Bun.spawn([process.execPath,resolve(root,'../casty/index.js'),'--attach',new URL(endpoint).port],{
  cwd:root,env:{...process.env,TERM:'xterm-256color',TMUX:''},
  terminal:{cols:160,rows:40,data(t,bytes){terminal=t;tail=(tail+Buffer.from(bytes).toString()).slice(-60000);peer.feed(bytes);}}
 });
 await wait(()=>frames>0);
 await cdp.evaluate('document.getElementById("edit").focus()');
 terminal.write('z');
 await wait(async()=>await cdp.evaluate('document.getElementById("edit").value')==='z');
 await Bun.write(join(out,'casty-attach.png'),frame);
 assert.equal(await cdp.evaluate('starts'),1);
 assert.equal((await cdp.send('Target.getTargets')).targetInfos.length,1);
 assert.deepEqual((await cdp.send('Page.getLayoutMetrics')).cssVisualViewport.clientWidth,640);
 terminal.write('\x11');await wait(()=>viewer.exitCode!==null);
 assert.equal(browser.exitCode,null);
 assert.equal(await cdp.evaluate('document.getElementById("edit").value'),'z');
 console.log(JSON.stringify({pass:true,frames,targetId,viewport:'640x360',image:join(out,'casty-attach.png'),browserSurvivedDetach:true}));
}finally{
 await Bun.write(join(out,"terminal.txt"),tail);
 cdp?.close();if(viewer?.exitCode===null)viewer.kill();if(viewer){await viewer.exited;viewer.terminal?.close()}
 if(browser?.exitCode===null)browser.kill();if(browser)await browser.exited;site.stop(true);
}
