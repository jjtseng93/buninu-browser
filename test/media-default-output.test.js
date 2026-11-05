import {afterAll,beforeAll,test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
let host;
beforeAll(async()=>{host=new RendererHost({timeout:20000});await host.start();});afterAll(()=>host?.close());
async function load(url){await host.call('loadDocument',{url,contentType:'text/html',source:'<!doctype html><audio></audio><video></video><div></div>'});await host.call('whenLoaded');}
test('secure media uses default output and rejects nonexistent devices without changing playback',async()=>{
 await load('https://test.local/');
 await host.call('evaluate',`globalThis.result=null;(async()=>{const a=document.querySelector('audio'),v=document.querySelector('video');const r=[a.sinkId,v.sinkId,await a.setSinkId(''),a.paused];for(const action of [()=>a.setSinkId('missing'),()=>a.setSinkId(),()=>a.setSinkId(Symbol()),()=>a.setSinkId.call(document.querySelector('div'),'')]){try{await action();r.push('unexpected success')}catch(e){r.push(e.name)}}r.push(a.sinkId,'setSinkId' in document.querySelector('div'));globalThis.result=JSON.stringify(r)})();`);
 let result;for(let i=0;i<50;i++){result=await host.call('evaluate','globalThis.result');if(result)break;await Bun.sleep(20);}
 expect(JSON.parse(result)).toEqual(['','',null,true,'NotFoundError','TypeError','TypeError','TypeError','',false]);
});
test('audio output routing is absent in insecure contexts',async()=>{await load('http://test.local/');expect(await host.call('evaluate',`'setSinkId' in HTMLMediaElement.prototype || 'sinkId' in document.querySelector('audio')`)).toBe(false);});
