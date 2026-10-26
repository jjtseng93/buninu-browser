import {test, expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

test('viewport resize notifies window listeners with fresh geometry and repaints their changes',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();
  await host.call('resize',320,240,1);
  await host.call('loadDocument',{url:'https://resize.test/',contentType:'text/html',
   source:'<body style="margin:0"><div id="box" style="width:100%;height:10px"></div><canvas id="canvas"></canvas></body>'});
  await host.call('whenLoaded');
  await host.call('evaluate',`window.events=[];window.propertyEvents=0;
   window.onresize=()=>window.propertyEvents++;
   window.addEventListener('resize',e=>{
    const c=document.getElementById('canvas');
    c.width=innerWidth;c.height=innerHeight;
    events.push([innerWidth,innerHeight,devicePixelRatio,
      document.getElementById('box').getBoundingClientRect().width,
      e.target===window,e.bubbles,e.cancelable]);
    document.body.style.backgroundColor='rgb(17,34,51)';
   });`);
  await host.call('resize',400,300,1.5);
  expect(await host.call('evaluate','JSON.stringify(events)')).toBe('[[400,300,1.5,400,true,false,false]]');
  expect(await host.call('evaluate','propertyEvents')).toBe(1);
  expect(await host.call('evaluate',`[document.getElementById('canvas').width,document.getElementById('canvas').height].join(',')`)).toBe('400,300');
  const png=Buffer.from(await host.composite('screenshot',{format:'png'}),'base64');
  expect([png.readUInt32BE(16),png.readUInt32BE(20)]).toEqual([600,450]);
  expect(await host.call('evaluate',"getComputedStyle(document.body).backgroundColor")).toBe('rgba(17, 34, 51, 1)');
  await host.call('resize',400,300,1.5);
  await host.call('resize',400,300,2);
  expect(await host.call('evaluate','events.length')).toBe(1);
  await host.call('resize',400,200,2);
  expect(await host.call('evaluate','JSON.stringify(events[1])')).toBe('[400,200,2,400,true,false,false]');
  expect(await host.call('evaluate','propertyEvents')).toBe(2);
 }finally{host.close();}
},30000);

test('same-pixel-size DPR changes relayout a quiet page and update viewport CSS',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.call('resize',1920,1035,1);
  await host.call('loadDocument',{url:'https://resize.test/',contentType:'text/html',source:`
   <style>body{margin:0}#center{width:1000px;margin:0 auto;height:20px}
   #units{width:50vw;height:10vh}#media{width:10px}
   @media(max-width:1400px){#media{width:30px}}</style>
   <div id="center">Contact — Buninu Linux</div><div id="units"></div><div id="media"></div>`});
  await host.call('whenLoaded');
  const geometry=()=>host.call('evaluate',`JSON.stringify(['center','units','media'].map(id=>{
   const r=document.getElementById(id).getBoundingClientRect();return [r.x,r.width,r.height];
  }))`);
  expect(await geometry()).toBe('[[460,1000,20],[0,960,103.5],[0,10,0]]');
  for(const [width,height,dpr,expected] of [
   [1280,690,1.5,'[[140,1000,20],[0,640,69],[0,30,0]]'],
   [1920,1035,1,'[[460,1000,20],[0,960,103.5],[0,10,0]]'],
   [1280,690,1.5,'[[140,1000,20],[0,640,69],[0,30,0]]'],
   // DPR-only changes repaint without changing CSS geometry.
   [1280,690,2,'[[140,1000,20],[0,640,69],[0,30,0]]'],
  ]) {
   await host.call('resize',width,height,dpr);
   expect(await geometry()).toBe(expected);
   const png=Buffer.from(await host.composite('screenshot',{format:'png'}),'base64');
   expect([png.readUInt32BE(16),png.readUInt32BE(20)]).toEqual([width*dpr,height*dpr]);
  }
 }finally{host.close()}
},30000);
