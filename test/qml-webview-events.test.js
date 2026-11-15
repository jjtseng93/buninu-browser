import {test,expect} from 'bun:test';
import Window from '../vendor/happy-dom/packages/happy-dom/src/window/Window.ts';
import {createQmlMedia} from '../lib/qml/media.js';

test('late remote nodes own their listeners, transfer focus and release drags outside canvas',()=>{
 const window=new Window(),document=window.document;
 const owner=document.createElement('div');document.body.append(owner);
 const v={width:200,height:100,visible:true},elements=new WeakMap([[v,owner]]);
 const effects=[],cleanups=[],states=[],calls=[],views=[];
 let registrations=0;
 const media=createQmlMedia({document,elements,effect:fn=>effects.push(fn),untrack:fn=>fn(),watchWrite:()=>{},
  cleanup:fn=>cleanups.push(fn),listen:()=>{throw Error('Late listener used global scope');},resolve:(_,url)=>url,
  emit:(_,name,value)=>states.push([name,value]),
  registerFocusInput:()=>{registrations++;return ()=>registrations--;},
  host:{webview(frame,state){const view={state,dispose:()=>calls.push(['dispose']),navigate:()=>{},resize:()=>{},visible:()=>{},input:(...args)=>calls.push(args)};views.push(view);return view;}},
 });
 media.defaults(v,'WebEngineView');media.start(v,'WebEngineView');
 // Remote content is created only on a later URL binding run, outside setup scope.
 v.url='http://localhost/one';for(const effect of effects)effect();
 const canvas=owner.querySelector('canvas'),input=owner.querySelector('textarea');
 canvas.getBoundingClientRect=()=>({left:0,top:0,width:200,height:100});
 canvas.focus();expect(document.activeElement).toBe(input);
 canvas.dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true,clientX:10,clientY:10,button:0,buttons:1}));
 document.body.dispatchEvent(new window.MouseEvent('mousemove',{bubbles:true,clientX:250,clientY:150,buttons:1}));
 document.body.dispatchEvent(new window.MouseEvent('mouseup',{bubbles:true,clientX:250,clientY:150,button:0}));
 expect(calls.filter(c=>c[0]==='button').map(c=>c[1].phase)).toEqual(['down','up']);
 expect(calls.find(c=>c[0]==='move')[1].x).toBe(250);
 views[0].state({url:'http://localhost/two',loaded:true});expect(v.url).toBe('http://localhost/two');expect(v.loadProgress).toBe(100);
 views[0].state({error:'network failed'});expect(v.loadProgress).toBe(0);
 v.loadHtml('<p>local</p>');expect(registrations).toBe(0);
 const count=calls.length;
 input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'x'}));
 canvas.dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true}));
 expect(calls.length).toBe(count);
 views[0].state({url:'http://localhost/stale',loaded:true});expect(v.url).toBe('http://localhost/two');
 v.url='http://localhost/three';for(const effect of effects)effect();expect(registrations).toBe(1);
 for(const dispose of cleanups)dispose();expect(registrations).toBe(0);
});
