import { strict as assert } from 'node:assert';
import { LayoutEngine } from '../../lib/layout/text-layout.js';
import { StyleEngine } from '../../lib/style/computed-style.js';
import { createPageRenderer } from '../../lib/renderer/page-renderer.js';

// Host scripting and prototype counters stay in this isolated child process.
const layout=LayoutEngine.prototype.layout,compute=StyleEngine.prototype.compute;
let layouts=0,styles=0;
LayoutEngine.prototype.layout=function(...args){layouts++;return layout.apply(this,args);};
StyleEngine.prototype.compute=function(...args){styles++;return compute.apply(this,args);};
const renderer=await createPageRenderer({});
try {
  renderer.setScripting('host');
  await renderer.resize(500,400,1);
  await renderer.loadDocument({url:'https://client-metrics.test/',contentType:'text/html',source:
    '<!doctype html><style>body{margin:0}#box{height:20px}</style><div id=box style="width:100px"></div>'});
  await renderer.whenLoaded();
  globalThis.__metricCalls=()=>({layouts,styles});
  const result=await renderer.evaluate(`(()=>{
    const root=document.documentElement,box=document.getElementById('box');
    const before=__metricCalls(),sizes=[];
    for(let i=0;i<40;i++){
      box.style.width=(100+i)+'px';
      sizes.push([root.clientWidth,root.clientHeight]);
    }
    const after=__metricCalls(),width=box.clientWidth,flushed=__metricCalls();
    return {sizes,rootLayouts:after.layouts-before.layouts,rootStyles:after.styles-before.styles,
      childLayouts:flushed.layouts-after.layouts,childStyles:flushed.styles-after.styles,width};
  })()`);
  assert.deepEqual(result,{sizes:Array.from({length:40},()=>[500,400]),rootLayouts:0,rootStyles:0,
    childLayouts:1,childStyles:1,width:139});

  // A synchronous client read can leave paint pending. Hit testing and
  // scrolling immediately afterwards must use the latest box and overflow.
  assert.deepEqual(await renderer.evaluate(`(()=>{
    const box=document.getElementById('box');
    box.style.width='1300px';
    const wide=box.clientWidth,hit=document.elementFromPoint(450,10)===box;
    window.scrollTo(700,0);
    const scrolled=window.scrollX;
    box.style.width='100px';
    const narrow=box.clientWidth;
    return [wide,hit,scrolled,narrow,window.scrollX,document.elementFromPoint(450,10)===box];
  })()`),[1300,true,700,100,0,false]);

  // Read the root border and a boxless wrapper while modifying its child.
  // The first read of the child's own width must still perform pending layout.
  assert.deepEqual(await renderer.evaluate(`(()=>{
    const box=document.getElementById('box'),root=document.documentElement;
    const wrapper=document.createElement('div');
    wrapper.style.display='contents';
    box.before(wrapper);wrapper.append(box);
    box.style.width='117px';root.style.borderLeft='6px solid';
    const before=__metricCalls().layouts;
    const borders=[root.clientLeft,root.clientTop],sizes=[wrapper.clientWidth,wrapper.clientHeight];
    const after=__metricCalls().layouts,width=box.clientWidth;
    return [borders,sizes,after-before,width,__metricCalls().layouts-after];
  })()`),[[6,0],[0,0],0,117,1]);

  // Root border offsets remain live geometry queries; hiding the root does
  // not change its viewport dimensions, but still hides descendants.
  assert.deepEqual(await renderer.evaluate(`(()=>{
    const root=document.documentElement;
    root.style.cssText='border-left:7px solid;border-top:3px solid';
    const visible=[root.clientWidth,root.clientHeight,root.clientLeft,root.clientTop];
    root.style.display='none';
    const hidden=[root.clientWidth,root.clientHeight,root.clientLeft,root.clientTop,
      document.getElementById('box').clientWidth];
    root.style.cssText='';return [visible,hidden];
  })()`),[[500,400,7,3],[500,400,0,0,0]]);

  await renderer.resize(600,450,2);
  assert.deepEqual(await renderer.evaluate('[document.documentElement.clientWidth,document.documentElement.clientHeight]'),[600,450]);
  assert.deepEqual(await renderer.evaluate(`(()=>{
    const detached=document.implementation.createHTMLDocument('').documentElement;
    return [detached.clientWidth,detached.clientHeight];
  })()`),[0,0]);
}finally{
  renderer.dispose();
  delete globalThis.__metricCalls;
  LayoutEngine.prototype.layout=layout;
  StyleEngine.prototype.compute=compute;
}
