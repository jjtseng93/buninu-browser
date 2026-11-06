import {strict as assert} from 'node:assert';
import '../../vendor/ses/dist/ses.mjs';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';

let frames = 0;
const errors = [];
const childSource = `<style>body{margin:0}button{position:absolute;left:0;top:0;width:120px;height:80px;border:0}</style>
  <button id="button">Child</button><script>
  const button=document.getElementById('button');globalThis.events=[];globalThis.ready=true;
  button.onmousedown=e=>e.preventDefault();
  button.onmouseup=()=>{events.push('up');button.style.left='90px'};
  button.onclick=e=>events.push(['click',e.clientX,e.clientY,e.offsetX,button.getBoundingClientRect().left]);
  </script>`;
const renderer = await createPageRenderer({
  onFrame: () => frames++,
  reportError: error => errors.push(String(error)),
  fetchResource: async url => ({ok:true,status:200,url,contentType:'text/html',body:new TextEncoder().encode(childSource)}),
});
lockdown({errorTaming:'safe',overrideTaming:'severe',consoleTaming:'unsafe',localeTaming:'unsafe',stackFiltering:'concise',reporting:'none'});
const run = expression => renderer.evaluate(expression);
const load = async (body, script = '') => {
  await renderer.loadDocument({url:'https://release.test/',contentType:'text/html',source:`
    <style>body{margin:0}button{padding:0;border:0;position:absolute;left:0;top:0;width:120px;height:80px}</style>
    <body id="body">${body}<script>
    globalThis.events=[];document.addEventListener('mousedown',e=>e.preventDefault());
    ${script}</script></body>`});
  await renderer.whenLoaded();
  assert.deepEqual(errors,[],'page scripts must load without errors');
};
const down = (x=20,y=20,button=272) => renderer.pointerButton(x,y,button,1);
const up = (x=20,y=20,button=272) => renderer.pointerButton(x,y,button,0);
try {
  renderer.resize(500,300,1);
  renderer.setScripting('ses');

  await load('<button id="button">Button</button>', `
    const button=document.getElementById('button');
    button.onmouseup=()=>{events.push('up');button.style.backgroundColor='red'};
    button.onclick=()=>{events.push('click');button.style.backgroundColor='blue'};`);
  down();frames=0;up();
  assert.equal(frames,1,'mouseup and click mutations are presented together, without an intermediate frame');
  assert.deepEqual(await run('events'),['up','click']);
  assert.equal(await run("getComputedStyle(document.getElementById('button')).backgroundColor"),'rgb(0, 0, 255)');

  await load('<button id="button">Button</button><div id="cover"></div>', `
    const button=document.getElementById('button'),cover=document.getElementById('cover');
    button.onmouseup=()=>{button.style.left='160px';button.style.width='200px';
      cover.style.cssText='position:absolute;left:0;top:0;width:100px;height:80px;background:red'};
    button.onclick=e=>events.push([e.target.id,e.offsetX,e.offsetY,button.getBoundingClientRect().left,
      getComputedStyle(button).width,document.elementFromPoint(20,20).id]);`);
  down();frames=0;up();
  assert.equal(frames,1,'geometry reads update layout without painting before the click finishes');
  assert.deepEqual(await run('events'),[['button',-140,20,160,'200px','cover']],
    'the existing release target receives click, while all geometry APIs see mouseup mutations');

  await load('<a id="old" href="/old"><span id="hit" style="display:block;width:120px;height:80px">Hit</span></a><a id="new" href="/new"></a>', `
    const hit=document.getElementById('hit'),destination=document.getElementById('new');
    hit.onmouseup=()=>{destination.appendChild(hit);destination.setAttribute('href','/after-up')};
    hit.onclick=e=>events.push(e.target.parentElement.id);`);
  down();
  assert.equal(up(),'https://release.test/after-up','mouseup reparenting updates the activation anchor');
  assert.deepEqual(await run('events'),['new']);

  await load('<a id="link" href="/retained"><span id="hit" style="display:block;width:120px;height:80px">Hit</span></a>', `
    const hit=document.getElementById('hit');hit.onclick=()=>{hit.parentElement.textContent='Replacement'};`);
  down();assert.equal(up(),'https://release.test/retained','click may replace descendants of the captured anchor');

  await load('<div id="box"><span id="a" style="display:inline-block;width:100px;height:80px">A</span><span id="b" style="display:inline-block;width:100px;height:80px">B</span></div><div id="other"></div>', `
    const b=document.getElementById('b');b.onmouseup=()=>document.getElementById('other').appendChild(b);
    document.onclick=e=>events.push(e.target.id);`);
  down();up(140,20);
  assert.deepEqual(await run('events'),['body'],'common ancestor is computed after mouseup DOM mutations');

  await load('<button id="button">Remove</button>', `
    const button=document.getElementById('button');button.onmouseup=()=>button.remove();
    document.onclick=()=>events.push('click');`);
  down();frames=0;up();
  assert.equal(frames,1,'a removed press target still flushes the release mutation');
  assert.deepEqual(await run('events'),[],'removed press targets do not activate');

  await load('<button id="button">Disable</button>', `
    const button=document.getElementById('button');button.onmouseup=()=>{button.disabled=true;button.style.backgroundColor='red'};
    button.onclick=()=>events.push('click');`);
  down();frames=0;up();
  assert.equal(frames,1,'disabled activation still flushes mouseup mutations');
  assert.deepEqual(await run('events'),[]);

  for (const buttonCode of [273,274]) {
    await load('<a id="link" href="/must-not-navigate" style="display:block;width:120px;height:80px">Auxiliary</a>', `
      const link=document.getElementById('link');
      for(const type of ['pointerdown','mousedown','contextmenu','pointerup','mouseup','auxclick','click'])
        link.addEventListener(type,e=>{events.push([type,e.button,e.buttons]);
          if(type==='mouseup')link.style.backgroundColor='red';
          if(type==='auxclick')link.style.backgroundColor='blue'});`);
    down(20,20,buttonCode);frames=0;
    assert.equal(up(20,20,buttonCode),null,'auxclick does not run primary navigation');
    assert.equal(frames,1,'auxclick and release paint together');
    const button=buttonCode===273?2:1, buttons=button===2?2:4;
    assert.deepEqual(await run('events'),[
      ['pointerdown',button,buttons],['mousedown',button,buttons],
      ...(button===2?[['contextmenu',button,buttons]]:[]),
      ['pointerup',button,0],['mouseup',button,0],['auxclick',button,0],
    ]);
  }

  await load('<details id="details"><p>Hidden</p></details>');
  down(10,5);up(10,5);
  assert.equal(await run("document.getElementById('details').open"),true,'generated summary phases toggle once');
  await load('<details id="details"><p>Hidden</p></details>', `
    const details=document.getElementById('details');
    details.onmouseup=()=>{const summary=document.createElement('summary');summary.textContent='Explicit';details.prepend(summary)};`);
  down(10,5);up(10,5);
  assert.equal(await run("document.getElementById('details').open"),false,
    'adding an explicit summary during mouseup must not activate the obsolete generated summary');
  await load('<details id="details"><summary>Explicit</summary><p>Hidden</p></details>');
  down(10,5);up(10,5);
  assert.equal(await run("document.getElementById('details').open"),true,'explicit summary phases toggle once');

  await load('<button id="button">One shot</button>', `
    const button=document.getElementById('button');
    for(const type of ['pointerdown','mousedown','pointerup','mouseup','click','dblclick'])
      button.addEventListener(type,e=>events.push(type));`);
  renderer.click(20,20,{clickCount:2});
  assert.deepEqual(await run('events'),['pointerdown','mousedown','pointerup','mouseup','click','dblclick'],
    'the public one-shot click API keeps its event sequence');

  await load('<iframe id="frame" src="/child" style="position:absolute;left:50px;top:30px;width:200px;height:150px;border:0"></iframe>',
    'document.onclick=()=>events.push("parent-click")');
  let ready=false;
  for(let i=0;i<100;i++) {
    if(await run("document.getElementById('frame').contentWindow.ready")){ready=true;break;}
    await Bun.sleep(10);
  }
  assert.equal(ready,true,'child frame loaded');
  down(70,50);up(70,50);
  assert.deepEqual(await run('events'),[],'child clicks stay in the child document');
  assert.deepEqual(await run("document.getElementById('frame').contentWindow.events"),['up',['click',20,20,-70,90]],
    'iframe coordinate conversion and synchronous geometry remain correct across release mutations');
} finally { renderer.dispose(); }
