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

test('Windows also uses Bun.which-resolved xclip before its platform fallback',async()=>{
 const seen=[];
 await writeClipboard('Windows 中文',{platform:'win32',which:name=>{seen.push(name);return name==='xclip'?'C:/bin/xclip.exe':null;},spawn:(args,opts)=>{expect(args).toEqual(['C:/bin/xclip.exe','-selection','clipboard']);expect(opts.stdin.toString()).toBe('Windows 中文');return {exited:Promise.resolve(0),kill(){}};}});
 expect(seen).toEqual(['xclip']);
});

test('clipboard read is one-shot, preserves empty/text values, and prefers xclip on Windows too',async()=>{
 const {readClipboard}=await import('../lib/clipboard.js');
 const calls=[];let value='中文\n';
 const options={platform:'win32',which:name=>name==='xclip'?'/bin/xclip':null,spawn:(args)=>{
   calls.push(args);return {stdout:new Response(value).body,exited:Promise.resolve(0),kill(){}};
 }};
 expect(await readClipboard(options)).toBe('中文\n');
 expect(calls).toEqual([['/bin/xclip','-selection','clipboard','-o']]);
 value='';expect(await readClipboard(options)).toBe('');
 await Bun.sleep(30);expect(calls).toHaveLength(2);
 await expect(readClipboard({...options,which:()=>null})).rejects.toThrow('No working');
});

test('execCommand copy snapshots a temporary selected textarea and uses the existing host clipboard',async()=>{
 const copies=[];const host=new RendererHost({clipboardWrite:async text=>{await Bun.sleep(10);copies.push(text);}});
 try {
  await host.call('loadDocument',{url:'http://clipboard.test/',contentType:'text/html',source:`<body style="margin:0"><button style="width:200px;height:60px" onclick="copyText()">Copy</button><script>
  function copyText(){const field=document.createElement('textarea');field.value='line 1\\n中文 😀';document.body.append(field);field.select();window.copied=document.execCommand('copy');field.remove();}
  </script>`});
  await host.call('whenLoaded');
  expect(await host.call('evaluate',`document.queryCommandSupported('copy')`)).toBe(true);
  await host.call('evaluate','copyText()');expect(await host.call('evaluate','copied')).toBe(false);expect(copies).toEqual([]);
  await host.call('click',30,20);
  for(let i=0;i<40&&!copies.length;i++)await Bun.sleep(25);
  expect(copies).toEqual(['line 1\n中文 😀']);
  expect(await host.call('evaluate','copied')).toBe(true);
 }finally{host.close();}
},20000);
