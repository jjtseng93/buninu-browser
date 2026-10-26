import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
let frames=0;
const r=await createPageRenderer({onFrame:()=>frames++});
try {
  r.resize(400,300,1);
  r.setScripting('host');
  await r.loadDocument({url:'https://paint.test/',contentType:'text/html',source:`
    <body style="margin:0"><canvas width="400" height="300"></canvas><script>
    globalThis.moves=0;
    const c=document.querySelector('canvas'),ctx=c.getContext('2d');
    c.onmousemove=e=>{moves++;ctx.fillRect(e.clientX,e.clientY,2,2)};
    </script>`});
  await r.whenLoaded();
  await Bun.sleep(100);
  frames=0;
  for(let i=0;i<50;i++)r.move(20+i,30);
  assert.equal(frames,0,'input must not synchronously rasterize each motion');
  await Bun.sleep(100);
  assert.ok(frames>0 && frames<50,'queued canvas changes must reach the compositor');
  assert.equal(await r.evaluate('moves'),50,'all drawing points must be delivered');
  assert.equal(await r.evaluate("document.querySelector('canvas').getContext('2d').getImageData(69,30,1,1).data[3]"),255);
} finally {r.dispose()}
