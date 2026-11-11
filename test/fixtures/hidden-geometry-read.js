import assert from 'node:assert/strict';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
import {StyleEngine} from '../../lib/style/computed-style.js';
const getStyle=StyleEngine.prototype.get;
let observe=false,hiddenChildReads=0;
StyleEngine.prototype.get=function(element){
 if(observe&&element?.getAttribute('id')==='child')hiddenChildReads++;
 return getStyle.call(this,element);
};
const write=process.stdout.write.bind(process.stdout);
const traces=[];
const renderer=await createPageRenderer({trace:s=>traces.push(s)});
try{
 renderer.setScripting('host');renderer.resize(400,300,1);
 await renderer.loadDocument({url:'https://geometry.test/',contentType:'text/html',source:'<body style="margin:0"><div id="hidden" style="display:none"><div id="child" style="width:30px;height:40px"></div></div><div id="visible" style="width:50px;height:60px"></div></body>'});
 await renderer.whenLoaded();traces.length=0;
 observe=true;
 const result=await renderer.evaluate(`(()=>{
  const hidden=document.getElementById('hidden'),child=document.getElementById('child'),visible=document.getElementById('visible');
  child.style.height='80px';visible.style.width='90px';
  const absent=[hidden.offsetWidth,child.offsetHeight,child.getBoundingClientRect().width,child.clientWidth,child.clientHeight,child.clientTop,child.clientLeft];
  return absent;
 })()`);
 observe=false;
 assert.deepEqual(result,[0,0,0,0,0,0,0]);
 assert.equal(hiddenChildReads,0,'geometry must not resolve styles below a hidden ancestor');
 assert.equal(await renderer.evaluate("getComputedStyle(document.getElementById('child')).height"),'80px');
 assert.equal(traces.filter(s=>/restyle and relayout \((?:script read|getComputedStyle)/.test(s)).length,0);
 assert.equal(await renderer.evaluate("document.getElementById('visible').offsetWidth"),90);
 assert.equal(await renderer.evaluate("document.getElementById('hidden').style.display='block';document.getElementById('child').offsetHeight"),80);
 assert.equal(await renderer.evaluate("document.getElementById('hidden').style.display='none';document.getElementById('child').offsetHeight"),0);
 assert.equal(await renderer.evaluate("document.getElementById('hidden').style.display='block';document.getElementById('child').offsetHeight"),80);
 write(JSON.stringify({pass:true})+'\n');
}finally{observe=false;StyleEngine.prototype.get=getStyle;renderer.dispose()}
