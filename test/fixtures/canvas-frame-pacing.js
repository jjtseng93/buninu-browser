import assert from 'node:assert/strict';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
import {LayoutEngine} from '../../lib/layout/text-layout.js';
const sleep=Bun.sleep,now=performance.now.bind(performance),layout=LayoutEngine.prototype.layout,write=process.stdout.write.bind(process.stdout);
let slow=false,layouts=0,frames=0;
LayoutEngine.prototype.layout=function(...args){
 layouts++;
 if(slow){slow=false;const until=now()+300;while(now()<until){}}
 return layout.apply(this,args);
};
const renderer=await createPageRenderer({onFrame:()=>frames++});
try{
 renderer.resize(128,96,1);renderer.setScripting('host');
 await renderer.loadDocument({url:'https://canvas.test/pacing',contentType:'text/html',source:`<!doctype html><html><head><style>body{margin:0}</style></head><body><canvas id=c width=128 height=96></canvas><script>var ctx=document.getElementById('c').getContext('2d');</script></body></html>`});
 await renderer.whenLoaded();await renderer.evaluate("var ctx=document.getElementById('c').getContext('2d')");
 // Simulate a slow font/resource-driven reflow, then animate only the bitmap.
 slow=true;renderer.resize(129,96,1);frames=0;const before=layouts;
 await renderer.evaluate("var step=0;var painting=setInterval(()=>{ctx.fillStyle=++step%2?'red':'blue';ctx.fillRect(0,0,128,96)},20)");
 await sleep(350);const presented=frames;
 await renderer.evaluate('clearInterval(painting)');
 assert.ok(presented>=2,`Canvas-only updates must not inherit the old 300ms layout cost; got ${presented} frames`);
 assert.equal(layouts,before,'bitmap animation does not require layout');
 const beforeBatch=frames;
 await renderer.evaluate(`new Promise(resolve=>{
  let count=0;function draw(){
   const end=performance.now()+20;while(performance.now()<end){}
   ctx.fillStyle=++count%2?'green':'yellow';ctx.fillRect(0,0,128,96);
   if(count<5)requestAnimationFrame(draw);else setTimeout(resolve,30);
  }requestAnimationFrame(draw);
 })`);
 const animationPresented=frames-beforeBatch;
 assert.ok(animationPresented>=5,`each expensive Canvas rAF must reach presentation, got ${animationPresented}/5`);

 write(JSON.stringify({presented,animationPresented,layoutsDuringAnimation:layouts-before})+'\n');
}finally{renderer.dispose();LayoutEngine.prototype.layout=layout;}
