// Network integration check against the unchanged Three.js example. Not a CI
// unit test: it needs the website and (optionally) local floor/wall images.
// bun test/manual-threejs-scene.js [/path/to/3D素材] [/tmp/threejs-check]
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {launch} from '../tools/browser-lab.js';
const assets=process.argv[2]&&resolve(process.argv[2]),out=resolve(process.argv[3]??'/tmp/buninu-threejs-check');
const browser=await launch('buninu',out),c=browser.cdp;
async function wait(expression){for(let i=0;i<300;i++){if(await c.evaluate(expression,180000))return;await Bun.sleep(100);}throw Error('Not ready: '+expression);}
async function click(text){
 const expression=`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})`;
 await c.evaluate(`(${expression}).scrollIntoView({block:'center'})`);
 const point=await c.evaluate(`(()=>{const r=(${expression}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 for(const type of['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point},180000);
 console.log('clicked',text);
}
async function pick(names){
 await wait('!!document.getElementById("path")');
 // Exercise the same controller actions as the browser-owned chooser buttons.
 const action=async value=>{await c.evaluate(`window.__fileAction=${JSON.stringify(value)}`);await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Shift'});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Shift'});};
 await action({kind:'browse',path:assets});
 for(const name of names){const index=await c.evaluate(`[...document.querySelectorAll('.entry')].findIndex(e=>e.textContent.endsWith(${JSON.stringify(name)}))`);assert(index>=0,'missing '+name);await action({kind:'select',index});}
 await action({kind:'open'});
}
try{
 await c.send('Page.navigate',{url:'https://drjohnjstest.blogspot.com/2023/11/3dsbsthreejsdemo.html'});
 await wait('typeof te!=="undefined"&&!!te.openo');
 if(assets){
  await c.evaluate('window.bgReady=false;te.selectbg().then(()=>window.bgReady=true);true');
  await pick(['floor.jpg','wall.jpg']);await wait('window.bgReady&&te.floor.material.map.image.complete&&te.wallr.material.map.image.complete');
 }
 const initialCount=await c.evaluate('te.obj.length');
 for(const name of['+人','+複製','+球','+立方']){
  const count=await c.evaluate('te.obj.length');await click(name);assert.equal(await c.evaluate('te.obj.length'),count+1);
 }
 assert.equal(await c.evaluate('te.obj.filter(o=>o.type==="Group"&&o.children.length===7).length'),2);
 const typing=click('+字');await wait('!!document.getElementById("answer")');await c.send('Page.handleJavaScriptDialog',{accept:true,promptText:'Hello 文字'});await typing;
 assert.equal(await c.evaluate('te.obj.length'),initialCount+5);
 const active=await c.evaluate('te.cv.active');await click('Next Element');assert.notEqual(await c.evaluate('te.cv.active'),active);await click('Previous Element');assert.equal(await c.evaluate('te.cv.active'),active);
 const visible=await c.evaluate('te.ca.obj.visible');await click('Toggle');assert.equal(await c.evaluate('te.ca.obj.visible'),!visible);await click('Toggle');
 await click('直向');assert.equal(await c.evaluate('getComputedStyle(te.cv).transform'),'none');await click('橫向');assert.equal(await c.evaluate('getComputedStyle(te.cv).transform'),'matrix(0, 1, -1, 0, 0, 0)');
 await c.evaluate('te.cv.scrollIntoView()');const r=await c.evaluate('(()=>{const r=te.cv.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width}})()');
 const point=(x,y)=>({x:r.x+r.width-y,y:r.y+x});
 const before=await c.evaluate('te.ca.obj.position.toArray()');
 for(const [x,y]of[[150,30],[30,150],[270,150],[150,270]])for(const type of['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point(x,y)},180000);
 assert.deepEqual(await c.evaluate('te.ca.obj.position.toArray()'),before);
 const rotation=await c.evaluate('te.ca.obj.rotation.y');
 await c.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,...point(40,40)});
 for(const x of[70,200])await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'none',buttons:1,...point(x,40)},180000);
 await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,...point(200,40)},180000);assert.notEqual(await c.evaluate('te.ca.obj.rotation.y'),rotation);
 if(assets&&await Bun.file(join(assets,'小凱L.png')).exists()&&await Bun.file(join(assets,'小凱R.png')).exists()){
  const adding=click('+立體圖');await wait('!!document.getElementById("ok")');await c.send('Page.handleJavaScriptDialog',{accept:true});await adding;await pick(['小凱L.png','小凱R.png']);await wait('te.opensbs_success&&te.sbsl[0].obj.material.map.image.complete&&te.sbsr[0].obj.material.map.image.complete');
 }
 await c.evaluate('tdebug.value="window.smokeRun=123"');await click('Run');assert.equal(await c.evaluate('window.smokeRun'),123);
 await click('→');await c.evaluate('tdebug.value="second slot"');await click('←');assert.equal(await c.evaluate('tdebug.value'),'window.smokeRun=123');await click('→');assert.equal(await c.evaluate('tdebug.value'),'second slot');
 const clearing=click('Clear');await wait('!!document.getElementById("ok")');await c.send('Page.handleJavaScriptDialog',{accept:true});await clearing;assert.equal(await c.evaluate('tdebug.value'),'');
 // Copy uses the existing browser clipboard bridge. Its non-destructive mocked
 // host contract is covered separately; do not replace the user's clipboard.
 await click('Open Console');await wait('typeof eruda!=="undefined"&&!!document.querySelector("#eruda")');
 await c.evaluate('eruda.hide();te.cv.scrollIntoView();te.rd()');
 const shot=await c.send('Page.captureScreenshot',{format:'png'},180000);await Bun.write(join(out,'scene.png'),Buffer.from(shot.data,'base64'));
 assert.deepEqual(c.events.filter(e=>e.method==='Runtime.exceptionThrown'),[]);
 console.log('PASS; screenshot:',join(out,'scene.png'));
}finally{await browser.stop();}
