import {expect,test} from 'bun:test';

test('renderer resumes audio output after seeking across a missing WebM range',async()=>{
  const child=Bun.spawn([process.execPath,new URL('./fixtures/media-webm-seek.js',import.meta.url).pathname],{stdout:'pipe',stderr:'pipe'});
  const timeout=setTimeout(()=>child.kill(),15_000);
  try{
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({code,stderr}).toEqual({code:0,stderr:''});
    expect(stdout).toContain('sparse WebM seek and playback passed');
  }finally{clearTimeout(timeout);}
},20_000);
