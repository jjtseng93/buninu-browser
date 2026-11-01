import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

test('inline prefixed animation runs, bubbles real AnimationEvents and can be cleared in the end handler',async()=>{
 const renderer=new RendererHost({timeout:20000});
 try{
  await renderer.start();
  await renderer.call('loadDocument',{url:'https://animation.test/',contentType:'text/html',source:`<!doctype html>
   <style>@-webkit-keyframes expand {from{width:10px}to{width:110px}}</style>
   <div id="box" style="width:200px;height:20px"></div><script>
   var box=document.getElementById('box'),events=[];
   document.addEventListener('animationend',e=>events.push([e.type,e.animationName,e.elapsedTime,e.pseudoElement,e instanceof AnimationEvent,e.target===box]));
   box.addEventListener('webkitAnimationEnd',e=>{events.push([e.type,e.animationName,e.elapsedTime]);box.style.webkitAnimation='';});
   box.style.webkitAnimation='expand .1s linear 1 both';
   </script>`});
  await renderer.call('whenLoaded');
  for(let n=0;n<100;n++){
   if(await renderer.call('evaluate','events.length>=2'))break;
   await Bun.sleep(30);
  }
  expect(JSON.parse(await renderer.call('evaluate','JSON.stringify(events)'))).toEqual([
   ['animationend','expand',.1,'',true,true],['webkitAnimationEnd','expand',.1],
  ]);
  expect(await renderer.call('evaluate',"box.style.animation")).toBe('');
  expect(await renderer.call('evaluate',"getComputedStyle(box).width")).toBe('200px');
  expect(await renderer.call('evaluate',"new AnimationEvent('animationend',{animationName:'test',elapsedTime:2}).elapsedTime")).toBe(2);
 }finally{await renderer.close();}
},20000);
