import {animationShorthand} from '../style/animation-values.js';
import {extractAnimationKeyframes} from '../style/computed-style.js';

const milliseconds = value => parseFloat(value) * (String(value).endsWith('ms') ? 1 : 1000);
const properties = {width:'width',height:'height',opacity:'opacity'};

// Basic CSS animation timeline and numeric px/opacity interpolation. Unsupported
// visual value types keep their underlying style; lifecycle events still run.
// No DOM style attributes are changed by sampling an animation.
export function createCSSAnimations({invalidate,dispatch,now=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout}) {
  let states=new Map(),definitions=new Map(),sources=null,environment='',timer=null;
  const queued=new Set();
  function emit(element,type,state,elapsed) {
    const detail={animationName:state.config.name,elapsedTime:Math.max(0,elapsed)/1000,pseudoElement:''};
    const task=setTimer(()=>{
      queued.delete(task);
      dispatch(element,type,detail);
    },0);
    queued.add(task);
  }
  function arm() {
    if(timer!==null)return;
    if(![...states.values()].some(list=>list.some(s=>!s.ended&&s.config.playState!=='paused')))return;
    timer=setTimer(()=>{
      timer=null;
      for(const [element,list] of states) {
        if(!element.isConnected){cancel(element,list);states.delete(element);continue;}
        if(list.some(s=>!s.ended&&s.config.playState!=='paused'))invalidate(element);
      }
    },16);
  }
  function cancel(element,list) {
    for(const state of list)if(state.started&&!state.ended)emit(element,'animationcancel',state,now()-state.start-state.delay);
  }
  return {
    setSheets(sheets,viewport) {
      for(const [element,list] of states)if(!element.isConnected){cancel(element,list);states.delete(element);}
      const key=`${viewport.width}:${viewport.height}:${viewport.mobile}`;
      if(sources===sheets&&environment===key)return;
      sources=sheets;environment=key;definitions=new Map();
      for(const sheet of sheets)for(const entry of extractAnimationKeyframes(sheet,viewport))definitions.set(...entry);
    },
    sample(element,style) {
      if(style.display==='none')for(const [child,list] of states)if(child===element||element.contains?.(child)) {
        cancel(child,list);states.delete(child);
      }
      if(!style.cssAnimations&&!style.cssAnimationLonghands&&!states.has(element))return style;
      const longhands=style.cssAnimationLonghands??{};
      const base=style.cssAnimations??animationShorthand('none');
      const names=longhands.name??base.map(item=>item.name);
      const configs=names.map((name,index)=>{
        const config={...base[index%base.length],name};
        for(const [key,values] of Object.entries(longhands))config[key]=values[index%values.length];
        return config;
      }).filter(config=>config.name!=='none'&&definitions.has(config.name)&&style.display!=='none');
      const previous=states.get(element)??[],next=[];
      let result=style;
      const time=now();
      for(let index=0;index<configs.length;index++) {
        const config=configs[index],frames=definitions.get(config.name);
        let state=previous[index];
        // Timeline does not restart for duration/delay changes. Pause freezes
        // local time; resume moves the origin instead of jumping ahead.
        if(!state||state.config.name!==config.name) {
          if(state)cancel(element,[state]);
          state={config,start:time,started:false,ended:false,iteration:0};
        }
        if(state.config.playState!=='paused'&&config.playState==='paused')state.pausedAt=time;
        else if(state.config.playState==='paused'&&config.playState!=='paused') {
          state.start+=time-(state.pausedAt??time);state.pausedAt=null;
        }
        if(config.playState==='paused'&&state.pausedAt==null)state.pausedAt=time;
        state.config=config;state.delay=milliseconds(config.delay)||0;
        const duration=Math.max(0,milliseconds(config.duration)||0);
        const count=config.iterationCount==='infinite'?Infinity:Math.max(0,Number(config.iterationCount)||0);
        const total=duration===0?0:duration*count;
        const elapsed=(state.pausedAt??time)-state.start-state.delay;
        if(elapsed>=0&&!state.started){state.started=true;emit(element,'animationstart',state,Math.min(total,Math.max(0,-state.delay)));}
        const finished=elapsed>=total;
        const iteration=duration>0?Math.floor(Math.max(0,elapsed)/duration):0;
        if(state.started&&!state.ended&&!finished&&iteration>state.iteration)emit(element,'animationiteration',state,iteration*duration);
        state.iteration=iteration;
        if(finished&&!state.ended&&state.started){state.ended=true;emit(element,'animationend',state,total);}
        next.push(state);
        if(elapsed<0&&!['both','backwards'].includes(config.fillMode))continue;
        if(finished&&!['both','forwards'].includes(config.fillMode))continue;
        let progress=elapsed<0?0:finished?(count%1||1):duration?elapsed/duration%1:1;
        const cycle=finished?Math.max(0,Math.ceil(count)-1):iteration;
        if(config.direction==='reverse'||config.direction==='alternate'&&cycle%2===1||config.direction==='alternate-reverse'&&cycle%2===0)progress=1-progress;
        progress=ease(progress,config.timingFunction);
        for(const [property,field] of Object.entries(properties)) {
          const stops=frames.flatMap(frame=>{
            const value=frame.declarations.get(property)?.value;
            if(value==null)return [];
            if(!/^-?(?:\d*\.)?\d+(?:px)?$/.test(value))return [];
            if(property!=='opacity'&&!value.endsWith('px')&&Number(value)!==0)return [];
            return [{offset:frame.offset,value:Number.parseFloat(value)}];
          });
          if(!stops.length)continue;
          if(stops[0].offset!==0&&typeof style[field]==='number')stops.unshift({offset:0,value:style[field]});
          if(stops.at(-1).offset!==1&&typeof style[field]==='number')stops.push({offset:1,value:style[field]});
          const left=stops.findLast(stop=>stop.offset<=progress)??stops[0];
          const right=stops.find(stop=>stop.offset>=progress)??stops.at(-1);
          const portion=right.offset===left.offset?0:(progress-left.offset)/(right.offset-left.offset);
          if(result===style)result={...style};
          result[field]=left.value+(right.value-left.value)*portion;
        }
      }
      cancel(element,previous.slice(configs.length));
      if(next.length)states.set(element,next);else states.delete(element);
      arm();return result;
    },
    dispose() {
      clearTimer(timer);timer=null;
      for(const task of queued)clearTimer(task);
      queued.clear();states.clear();definitions.clear();sources=null;
    },
  };
}

function ease(progress,name) {
  if(progress<=0)return 0;
  if(progress>=1)return 1;
  if(name==='linear')return progress;
  if(name==='step-start')return 1;
  if(name==='step-end')return progress<1?0:1;
  const presets={ease:[.25,.1,.25,1],'ease-in':[.42,0,1,1],'ease-out':[0,0,.58,1],'ease-in-out':[.42,0,.58,1]};
  const curve=presets[name]??(/^cubic-bezier\(([^)]+)\)$/.exec(name)?.[1].split(',').map(Number));
  if(!curve||curve.length!==4||!curve.every(Number.isFinite))return progress;
  const [x1,y1,x2,y2]=curve;
  const at=(t,a,b)=>3*(1-t)**2*t*a+3*(1-t)*t*t*b+t**3;
  let low=0,high=1;
  for(let n=0;n<16;n++){const middle=(low+high)/2;if(at(middle,x1,x2)<progress)low=middle;else high=middle;}
  return at((low+high)/2,y1,y2);
}
