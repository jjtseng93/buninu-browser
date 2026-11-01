import {test,expect} from 'bun:test';
import {createCSSAnimations} from '../lib/renderer/css-animations.js';
import {extractAnimationKeyframes,StyleEngine} from '../lib/style/computed-style.js';
import {animationShorthand,animationProperty} from '../lib/style/animation-values.js';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';

function timeline() {
 let time=0,next=0;const tasks=new Map(),events=[];
 const element={isConnected:true};
 const animation=createCSSAnimations({now:()=>time,invalidate:()=>{},dispatch:(_e,type,detail)=>events.push({type,...detail}),
  setTimer:(fn,delay)=>{tasks.set(++next,{fn,at:time+delay});return next;},clearTimer:id=>tasks.delete(id)});
 animation.setSheets(['@keyframes grow {from{width:10px;opacity:0} to{width:110px;opacity:1}}'],{});
 const style={width:200,height:20,opacity:1,display:'block',cssAnimations:animationShorthand('grow 1s linear both')};
 return {animation,element,style,events,tasks,setTime:value=>time=value,
  flush:()=>{for(const [id,task] of [...tasks])if(task.at<=time){tasks.delete(id);task.fn();}}};
}

test('CSS keyframes use balanced blocks, media filtering and prefix aliases',()=>{
 const frames=extractAnimationKeyframes('@media (min-width:500px){@-webkit-keyframes move{from{width:10px}50%,to{width:20px}}} @media (max-width:400px){@keyframes absent{to{opacity:0}}}',{width:800});
 expect([...frames.keys()]).toEqual(['move']);expect(frames.get('move').map(f=>f.offset)).toEqual([0,.5,1]);
 expect(animationProperty('webkitAnimationDuration')).toBe('animation-duration');
 expect(animationProperty('-webkit-animation')).toBe('animation');expect(animationProperty('--MyVar')).toBe('--MyVar');
});

test('numeric animations interpolate without changing DOM declarations, and end once',()=>{
 const t=timeline();
 expect(t.animation.sample(t.element,t.style).width).toBe(10);t.flush();
 t.setTime(500);expect(t.animation.sample(t.element,t.style).width).toBe(60);
 expect(t.animation.sample(t.element,t.style).opacity).toBe(.5);expect(t.style.width).toBe(200);
 t.setTime(1000);expect(t.animation.sample(t.element,t.style).width).toBe(110);t.flush();
 t.setTime(2000);t.animation.sample(t.element,t.style);t.flush();
 expect(t.events.map(e=>[e.type,e.animationName,e.elapsedTime])).toEqual([['animationstart','grow',0],['animationend','grow',1]]);
 t.animation.dispose();expect(t.tasks.size).toBe(0);
});

test('delay, repeat, pause/resume, cancellation and missing definitions',()=>{
 const t=timeline();t.style.cssAnimations=animationShorthand('grow 1s 200ms linear 2');
 expect(t.animation.sample(t.element,t.style).width).toBe(200);t.flush();expect(t.events).toEqual([]);
 t.setTime(700);expect(t.animation.sample(t.element,t.style).width).toBe(60);t.flush();
 t.style.cssAnimations=[{...t.style.cssAnimations[0],playState:'paused'}];t.animation.sample(t.element,t.style);
 t.setTime(1700);expect(t.animation.sample(t.element,t.style).width).toBe(60);
 t.style.cssAnimations=[{...t.style.cssAnimations[0],playState:'running'}];t.animation.sample(t.element,t.style);
 t.setTime(2300);t.animation.sample(t.element,t.style);t.flush();
 expect(t.events.some(e=>e.type==='animationiteration')).toBe(true);
 t.animation.sample(t.element,{display:'block'});t.flush();expect(t.events.at(-1).type).toBe('animationcancel');
 t.animation.sample(t.element,{display:'block',cssAnimations:animationShorthand('missing 1s')});t.flush();
 expect(t.events.filter(e=>e.type==='animationstart')).toHaveLength(1);
 t.animation.dispose();expect(t.tasks.size).toBe(0);
});

test('cascade retains shorthand and longhand timing with vendor aliases',()=>{
 const {document,window}=parseHTMLDocument('<div id=a style="animation-delay:2s; -webkit-animation:grow 1s linear; animation-duration:3s"></div>');
 try{const engine=new StyleEngine().compute(document);const style=engine.get(document.getElementById('a'));
 expect(style.cssAnimations[0].delay).toBe('0s');expect(style.cssAnimationLonghands).toEqual({duration:['3s']});
 }finally{window.happyDOM.close();}
});
