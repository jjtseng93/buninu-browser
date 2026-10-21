import {test,expect} from 'bun:test';
import {writeClipboard} from '../lib/clipboard.js';
import {RendererHost} from '../lib/renderer/host.js';

test('clipboard prefers xclip, preserves exact stdin, and falls back on failure',async()=>{
 const calls=[];let fail=false;
 const options={platform:'linux',which:name=>'/bin/'+name,spawn:(args,opts)=>{calls.push({args,opts});return {exited:Promise.resolve(fail&&args[0].endsWith('xclip')?1:0),kill(){}};}};
 const text='中文\n$(do not execute) `literal`';
 await writeClipboard(text,options);
 expect(calls[0].args).toEqual(['/bin/xclip','-selection','clipboard']);
 expect(calls[0].opts.stdin.toString()).toBe(text);expect(calls).toHaveLength(1);
 fail=true;calls.length=0;await writeClipboard('',options);
 expect(calls.map(c=>c.args[0])).toEqual(['/bin/xclip','/bin/wl-copy']);
 await expect(writeClipboard('x',{...options,which:()=>null})).rejects.toThrow('No working');
});

test('a real button click writes through controller; page-only calls cannot overwrite clipboard',async()=>{
 const copies=[];const host=new RendererHost({clipboardWrite:async text=>{copies.push(text);}});
 try{
  await host.start();await host.call('resize',400,200,1);
  await host.call('loadDocument',{url:'https://clipboard.test/',contentType:'text/html',source:`<body style="margin:0"><button id="b" style="width:200px;height:60px">Copy</button><script>
    window.copyStatus='idle';document.getElementById('b').onclick=async()=>{
      try{await navigator.clipboard.writeText('npx buninu 中文');window.copyStatus='copied';}
      catch(e){window.copyStatus=e.name;}
    };</script>`});
  await host.call('whenLoaded');
  await host.call('evaluate',"document.getElementById('b').click()");await Bun.sleep(30);
  expect(copies).toEqual([]);expect(await host.call('evaluate','window.copyStatus')).toBe('NotAllowedError');
  await host.call('click',30,25);
  for(let i=0;i<40 && !copies.length;i++)await Bun.sleep(25);
  expect(copies).toEqual(['npx buninu 中文']);
  for(let i=0;i<40 && await host.call('evaluate','window.copyStatus')!=='copied';i++)await Bun.sleep(25);
  expect(await host.call('evaluate','window.copyStatus')).toBe('copied');
 }finally{host.close();}
},20000);
