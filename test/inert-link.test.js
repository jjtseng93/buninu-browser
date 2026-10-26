import {test, expect} from 'bun:test';
import Window from '../vendor/happy-dom/packages/happy-dom/src/window/Window.ts';
import {createInertWindow} from '../lib/happy-dom/parser.js';

test('inert links leave existing and subsequent ordinary windows resource loading intact', async () => {
  const requests=[];
  const server=Bun.serve({port:0,fetch(req){requests.push(new URL(req.url).pathname);return new Response('body{color:red}',{headers:{'content-type':'text/css'}})}});
  const windows=[];
  const ordinary=()=>{const w=new Window({url:server.url.href});windows.push(w);return w};
  const addLink=(w,path)=>{
    const link=w.document.createElement('link'),events=[];
    link.rel='stylesheet';link.href=path;
    link.onload=()=>events.push('load');link.onerror=()=>events.push('error');
    w.document.head.append(link);return {link,events};
  };
  try {
    const before=ordinary();
    const inert=createInertWindow(server.url.href);windows.push(inert);
    const after=ordinary();
    // Repeated setup must not replace the saved native hooks with wrappers.
    windows.push(createInertWindow(server.url.href));
    for(const [w,path] of [[before,'/before.css'],[after,'/after.css']]){
      const {link,events}=addLink(w,path);
      await w.happyDOM.waitUntilComplete();
      expect(events).toEqual(['load']);expect(link.sheet).not.toBeNull();
      link.href=path+'?changed';await w.happyDOM.waitUntilComplete();
      expect(events).toEqual(['load','load']);
    }
    const {link,events}=addLink(inert,'/inert.css');
    link.href='/inert-changed.css';
    await inert.happyDOM.waitUntilComplete();
    expect(events).toEqual([]);expect(link.sheet).toBeNull();
    expect(requests).toEqual(['/before.css','/before.css','/after.css','/after.css']);
  } finally {
    await Promise.all(windows.map(w=>w.happyDOM.abort()));server.stop(true);
  }
});
