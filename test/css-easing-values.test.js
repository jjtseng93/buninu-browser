import {test,expect} from 'bun:test';
import {normalizeAnimationEnum,animationEnumValue} from '../lib/style/animation-enum-values.js';
import {computedEasing,sampleEasing} from '../lib/style/easing-values.js';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine,supportsDeclaration} from '../lib/style/computed-style.js';
import {createCSSAnimations} from '../lib/renderer/css-animations.js';
import {animationLists,animationShorthand} from '../lib/style/animation-values.js';

test('shared easing grammar preserves valid CSSOM values and rejects malformed steps and curves atomically',()=>{
  const {window,document}=parseHTMLDocument('<div></div>'),s=document.querySelector('div').style;
  try {
    for(const [source,expected] of [
      ['STEP-START','steps(1, start)'],['step-end','steps(1)'],['steps( 2, end )','steps(2)'],
      ['steps(2,jump-end)','steps(2)'],['steps(2,jump-start)','steps(2, jump-start)'],
      ['steps(calc(5 / 2), start)','steps(calc(2.5), start)'],
      ['steps(calc(1),jump-none)','steps(calc(1), jump-none)'],
      ['steps(1000000000000000000000,start)','steps(2147483647, start)'],
      ['ease, steps(4), linear','ease, steps(4), linear'],
      ['linear(0, 0.5 25% 75%, 1)','linear(0, 0.5 25% 75%, 1)'],
      ['cubic-bezier(calc(-2),calc(.7 / 2),calc(1.5),calc(0))','cubic-bezier(calc(-2), calc(0.35), calc(1.5), calc(0))'],
    ]) {
      s.animationTimingFunction=source;expect(s.animationTimingFunction).toBe(expected);
      expect(normalizeAnimationEnum('animation-timing-function',source)).toBe(expected);
      expect(supportsDeclaration('animation-timing-function',source)).toBe(true);
    }
    s.animationTimingFunction='ease-in';
    for(const source of ['steps(0)','steps(1,jump-none)','steps(2,() start)','steps(2())','steps(2,)','steps(2.0)','steps(1e1)','steps(calc(0/0),jump-none)','ease linear','auto','initial, ease','cubic-bezier(-.1,0,1,1)','cubic-bezier(0,infinity,1,1)','cubic-bezier(0,0,1)','linear(garbage)','linear()','linear(0px,1)','linear(0 10% 20% 30%,1)','linear(0,,1)']) {
      s.animationTimingFunction=source;expect(s.animationTimingFunction).toBe('ease-in');
      expect(supportsDeclaration('animation-timing-function',source)).toBe(false);
    }
  }finally {window.happyDOM.close();}
});

test('computed timing functions apply math ranges after calculation and preserve cascade defaults',()=>{
  const {window,document}=parseHTMLDocument('<main style="animation-timing-function:steps(2,start)"><div id=x style="font-size:20px;animation-timing-function:steps(calc(2 + sign(100em - 1px)))"></div></main>');
  const x=document.getElementById('x'),read=()=>animationEnumValue(new StyleEngine().compute(document).get(x),'animation-timing-function');
  try {
    expect(read()).toBe('steps(3)');
    x.style.animationTimingFunction='inherit';expect(read()).toBe('steps(2, start)');
    x.style.animationTimingFunction='initial';expect(read()).toBe('ease');
    x.style.cssText='--ease:steps(3,jump-both);animation-timing-function:var(--ease)';expect(read()).toBe('steps(3, jump-both)');
    x.style.setProperty('--ease','invalid');expect(read()).toBe('ease');
    expect(computedEasing('steps(calc(-10),start)')).toBe('steps(1, start)');
    expect(computedEasing('steps(calc(5 / 2),start)')).toBe('steps(3, start)');
    expect(computedEasing('steps(calc(1),jump-none)')).toBe('steps(2, jump-none)');
    expect(computedEasing('cubic-bezier(calc(-2), calc(.35), calc(1.5), 0)')).toBe('cubic-bezier(0, 0.35, 1, 0)');
    x.style.cssText='font-size:20px;animation-timing-function:steps(calc(2 + sign(1em - 15px)))';
    expect(read()).toBe('steps(3)');
    x.style.fontSize='10px';expect(read()).toBe('steps(1)');
    x.style.fontSize='20px';expect(read()).toBe('steps(3)');
  }finally {window.happyDOM.close();}
});

test('step sampling implements boundary limits and all four jump positions',()=>{
  const points=[0,.2,1/3,.5,2/3,.9,1];
  for(const [name,expected] of [
    ['steps(3,jump-start)',[1/3,1/3,2/3,2/3,1,1,1]],
    ['steps(3,jump-end)',[0,0,1/3,1/3,2/3,2/3,1]],
    ['steps(3,jump-none)',[0,0,.5,.5,1,1,1]],
    ['steps(3,jump-both)',[.25,.25,.5,.5,.75,.75,1]],
  ])expect(points.map(p=>sampleEasing(p,name))).toEqual(expected);
  expect(sampleEasing(0,'step-start')).toBe(1);
  expect(sampleEasing(0,'step-start',true)).toBe(0);
  expect(sampleEasing(1,'step-end',true)).toBe(0);
  expect(sampleEasing(1/3,'steps(3,start)',true)).toBe(1/3);
  expect(sampleEasing(-.1,'steps(3,end)')).toBe(-1/3);
  expect(sampleEasing(1.1,'steps(3,start)')).toBe(4/3);
  const huge=normalizeAnimationEnum('animation-timing-function','steps(1000000000000000000000000000000000000000000000000,start)');
  expect(normalizeAnimationEnum('animation-timing-function',huge)).toBe(huge);
  expect(sampleEasing(0,huge)).toBe(1/2147483647);
  expect(sampleEasing(0,'linear')).toBe(0);expect(sampleEasing(1,'linear')).toBe(1);
  expect(sampleEasing(.5,'ease-in')).toBeCloseTo(.31536,4);
  expect(sampleEasing(.5,'cubic-bezier(0, 0, 1, 1)')).toBeCloseTo(.5,4);
});

test('nested easing math stays one longhand or shorthand component and samples its resolved curve',()=>{
  const easing='steps(max(2, sign(100em - 1px)), start)';
  expect(animationLists(`${easing}, ease`)).toEqual([easing,'ease']);
  const config=animationShorthand(`move 3s ${easing} both paused, "other, name" 2s linear`);
  expect(config[0].name).toBe('move');expect(config[0].timingFunction).toBe(easing);
  expect(config[1].name).toBe('other, name');
  const {window,document}=parseHTMLDocument(`<div style="font-size:20px;animation-timing-function:${easing},linear"></div>`);
  const style=new StyleEngine().compute(document).get(document.querySelector('div'));
  let task=0;const tasks=new Map();
  const animation=createCSSAnimations({now:()=>0,invalidate(){},dispatch(){},setTimer:fn=>{tasks.set(++task,fn);return task;},clearTimer:id=>tasks.delete(id)});
  try {
    expect(style.cssAnimationLonghands.timingFunction).toEqual(['steps(2, start)','linear']);
    animation.setSheets(['@keyframes move{from{width:0px}to{width:90px}}'],{});
    const sampled=animation.sample({isConnected:true},{fontSize:20,display:'block',width:0,cssAnimations:[config[0]]});
    expect(sampled.width).toBe(45);
  }finally {animation.dispose();window.happyDOM.close();}
});

test('keyframe segments keep step discontinuities at initial, intermediate, reverse and filled endpoints',()=>{
  let time=0,task=0;const tasks=new Map();
  const animation=createCSSAnimations({now:()=>time,invalidate(){},dispatch(){},setTimer:fn=>{tasks.set(++task,fn);return task;},clearTimer:id=>tasks.delete(id)});
  animation.setSheets(['@keyframes move{0%{width:0px;transform:translateX(0px)}50%{width:30px;transform:translateX(30px)}100%{width:90px;transform:translateX(90px)}}'],{});
  const sample=(delay,direction='normal',fill='both')=>{
    const style={display:'block',width:10,transform:null,cssAnimations:animationShorthand(`move 3s step-start ${direction} ${fill} paused`),cssAnimationLonghands:{delay:[`${delay}s`]}};
    return animation.sample({isConnected:true},style);
  };
  try {
    for(const [delay,width] of [[0,30],[-1.5,90],[-3,90],[1,0]]) {
      const s=sample(delay);expect(s.width).toBe(width);expect(s.transform.x).toBe(width);
    }
    expect(sample(0,'reverse').width).toBe(90);
    expect(sample(-3,'reverse').width).toBe(0);
    expect(sample(1,'reverse').width).toBe(90);
    expect(sample(-3,'normal','none').width).toBe(10);
  }finally {animation.dispose();expect(tasks.size).toBe(0);}
});
