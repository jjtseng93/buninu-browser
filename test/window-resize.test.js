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
