import {expect,test} from 'bun:test';

for (const mode of ['audio','video','presentation']) {
  test(`new ${mode} output streams start from their positioned sample anchor`,async()=>{
    const child=Bun.spawn([process.execPath,new URL('./fixtures/media-output-anchor.js',import.meta.url).pathname,mode],{
      stdout:'pipe',stderr:'pipe',
    });
    const timeout=setTimeout(()=>child.kill(),15_000);
    try{
      const [stdout,stderr,code]=await Promise.all([
        new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited,
      ]);
      expect({code,stderr}).toEqual({code:0,stderr:''});
      const result=JSON.parse(stdout);
      expect({ok:result.ok,mode:result.mode,streams:result.streams}).toEqual({ok:true,mode,streams:5});
    }finally{
      clearTimeout(timeout);
      if(child.exitCode===null)child.kill();
    }
  },20_000);
}
