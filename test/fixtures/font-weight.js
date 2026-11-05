import {strict as assert} from 'node:assert';
  const {createPageRenderer}=await import('../../lib/renderer/page-renderer.js');
  const [sans,mono]=await Promise.all(['Roboto-Regular.ttf','DejaVuSansMono.ttf'].map(name=>Bun.file(new URL('../../usr/share/fonts/'+name,import.meta.url)).bytes()));
  const requests=[];
  const renderer=await createPageRenderer({fetchResource:async url=>({ok:false,status:404,url,body:new Uint8Array()}),pageFetch:async request=>{requests.push(request.url);return {status:200,body:request.url.endsWith('/mono.ttf')?mono:sans};}});
  try {
    renderer.setScripting('host');
    await renderer.loadDocument({url:'https://font.test/',contentType:'text/html',source:`<!doctype html><style>@font-face{font-family:Weight;src:url(/sans.ttf);font-weight:100 399.5}@font-face{font-family:Weight;src:url(/mono.ttf);font-weight:400 700}body{font:349 30px Weight}#light{font-weight:lighter}#bold{font-weight:bolder}#fraction{font-weight:400.5}#math{font-weight:calc(100.5*3 + 50.5)}#numeric{font-weight:352}canvas{font-weight:349}</style><span id=light>iiii</span><span id=bold>iiii</span><span id=fraction>iiii</span><span id=math>iiii</span><span id=numeric>iiii</span><canvas id=c></canvas>`});await renderer.whenLoaded();
    const widths=renderer.inspect('span').map(s=>s.box.width);assert.ok(widths[1]>widths[0]*2);assert.ok(Math.abs(widths[2]-widths[1])<0.00001);assert.ok(Math.abs(widths[3]-widths[4])<0.00001);assert.ok(widths[3]<widths[1]/2);assert.equal(requests.length,2);
    const result=await renderer.evaluate(`(()=>{const c=document.getElementById('c'),ctx=c.getContext('2d');ctx.font='lighter 30px Weight';const a=ctx.measureText('iiii').width;ctx.font='bolder 30px Weight';const b=ctx.measureText('iiii').width;ctx.font='400.5 30px Weight';const d=ctx.measureText('iiii').width;return [a,b,d,getComputedStyle(document.getElementById('bold')).fontWeight]})()`);
    assert.ok(result[1]>result[0]*2);assert.ok(Math.abs(result[2]-result[1])<0.00001);assert.equal(result[3],'400');
  }finally{renderer.dispose();}
