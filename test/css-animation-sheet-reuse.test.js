import {test,expect} from 'bun:test';
import {createCSSAnimations} from '../lib/renderer/css-animations.js';
import {animationShorthand} from '../lib/style/animation-values.js';

function timeline() {
  let time=0,id=0;
  const tasks=new Map(),events=[];
  const animations=createCSSAnimations({now:()=>time,invalidate:()=>{},
    dispatch:(_element,type)=>events.push(type),
    setTimer:fn=>{tasks.set(++id,fn);return id;},clearTimer:id=>tasks.delete(id)});
  const element={isConnected:true};
  const style={display:'block',width:999,cssAnimations:animationShorthand('move 1s linear both')};
  return {animations,tasks,events,setTime:value=>time=value,
    sample:()=>animations.sample(element,style).width,
    sheets:(sources,viewport={width:800,height:600,mobile:false})=>animations.setSheets(sources,viewport),
    flush:()=>{for(const [id,fn] of [...tasks]){tasks.delete(id);fn();}}};
}
const small='@keyframes move{from{width:0px}to{width:100px}}';
const large='@keyframes move{from{width:100px}to{width:300px}}';

test('retained keyframes preserve duplicate order, replacements, removal and a running timeline',()=>{
  const t=timeline();
  try {
    t.sheets([small]);expect(t.sample()).toBe(0);t.flush();
    t.setTime(500);expect(t.sample()).toBe(50);
    t.sheets([small,'body{color:red}']);expect(t.sample()).toBe(50);
    t.sheets([small,large]);expect(t.sample()).toBe(200);
    t.sheets([small,large,small]);expect(t.sample()).toBe(50);
    t.sheets([large,small]);expect(t.sample()).toBe(50);
    t.sheets([small,large]);expect(t.sample()).toBe(200);
    t.sheets([large]);expect(t.sample()).toBe(200);
    t.flush();expect(t.events.filter(type=>type==='animationstart')).toHaveLength(1);
    t.sheets([]);expect(t.sample()).toBe(999);t.flush();
    expect(t.events.at(-1)).toBe('animationcancel');
    t.sheets([small]);expect(t.sample()).toBe(0);
    t.setTime(750);expect(t.sample()).toBe(25);
  } finally {t.animations.dispose();}
});

test('keyframe source reuse remains sensitive to media environment changes and empty results',()=>{
  const t=timeline();
  const conditional=`@media (min-width:700px){${large}}
    @media (max-height:400px){@keyframes move{from{width:0px}to{width:400px}}}`;
  try {
    t.sheets([small,conditional],{width:600,height:600});
    expect(t.sample()).toBe(0);t.setTime(500);expect(t.sample()).toBe(50);
    t.sheets([small,conditional,'p{opacity:.5}'],{width:600,height:600});expect(t.sample()).toBe(50);
    t.sheets([small,conditional],{width:800,height:600});expect(t.sample()).toBe(200);
    t.sheets([small,conditional],{width:600,height:300});expect(t.sample()).toBe(200);
    t.sheets([small,conditional],{width:600,height:600});expect(t.sample()).toBe(50);
    t.sheets([small,conditional.replace('300px','500px')],{width:800,height:600});expect(t.sample()).toBe(300);
  } finally {t.animations.dispose();}
});

test('disposing keyframe sheets resets document timelines and queued work',()=>{
  const t=timeline();
  t.sheets([small,large]);expect(t.sample()).toBe(100);
  t.setTime(500);expect(t.sample()).toBe(200);
  t.animations.dispose();expect(t.tasks.size).toBe(0);
  try {
    t.sheets([small]);expect(t.sample()).toBe(0);
    t.setTime(750);expect(t.sample()).toBe(25);
    t.flush();expect(t.events).toEqual(['animationstart']);
  } finally {t.animations.dispose();}
});

test('keyframe cache uses effective viewport aliases and mobile media features',()=>{
  const t=timeline();
  const sources=[small,`@media (min-width:700px){${large}}
    @media (max-height:400px){@keyframes move{from{width:0px}to{width:600px}}}
    @media (pointer:coarse){@keyframes move{from{width:0px}to{width:800px}}}`];
  try {
    t.sheets(sources,{width:800,viewportWidth:600,height:600});
    expect(t.sample()).toBe(0);t.setTime(500);expect(t.sample()).toBe(50);
    t.sheets(sources,{width:800,viewportWidth:800,height:600});expect(t.sample()).toBe(200);
    t.sheets(sources,{width:800,viewportWidth:800,height:600,viewportHeight:300});expect(t.sample()).toBe(300);
    t.sheets(sources,{width:800,viewportWidth:800,height:600,mobile:true});expect(t.sample()).toBe(400);
    t.sheets(sources,{width:800,viewportWidth:600,height:600,mobile:false});expect(t.sample()).toBe(50);
  } finally {t.animations.dispose();}
});
