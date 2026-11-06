import {animationShorthand} from '../style/animation-values.js';
import {extractAnimationKeyframes,parseTransform} from '../style/computed-style.js';
import {computedEasing,sampleEasing} from '../style/easing-values.js';

const milliseconds = value => parseFloat(value) * (String(value).endsWith('ms') ? 1 : 1000);
const properties = {width:'width',height:'height',opacity:'opacity'};

// CSS animation timeline with numeric and compatible transform interpolation. Unsupported
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
    // Retained-style passes still resample every established animation from
    // its underlying computed values, including paused/finished timelines.
    sampleTargets() { return new Set(states.keys()); },
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
        const reversed=config.direction==='reverse'||config.direction==='alternate'&&cycle%2===1||config.direction==='alternate-reverse'&&cycle%2===0;
        if(reversed)progress=1-progress;
        const before=elapsed<0&&!reversed||finished&&reversed;

        for(const [property,field] of Object.entries(properties)) {
          const stops=frames.flatMap(frame=>{
            const value=frame.declarations.get(property)?.value;
            if(value==null)return [];
            if(!/^-?(?:\d*\.)?\d+(?:px)?$/.test(value))return [];
            if(property!=='opacity'&&!value.endsWith('px')&&Number(value)!==0)return [];
            return [{offset:frame.offset,value:Number.parseFloat(value),timing:frame.declarations.get("animation-timing-function")?.value}];
          });
          if(!stops.length)continue;
          if(stops[0].offset!==0&&typeof style[field]==='number')stops.unshift({offset:0,value:style[field]});
          if(stops.at(-1).offset!==1&&typeof style[field]==='number')stops.push({offset:1,value:style[field]});
          const [left,right]=segment(stops,progress,before);
          const portion=sampleEasing(right.offset===left.offset?0:(progress-left.offset)/(right.offset-left.offset),computedEasing(left.timing??config.timingFunction,style),before);
          if(result===style)result={...style};
          result[field]=left.value+(right.value-left.value)*portion;
        }
        const transforms=frames.flatMap(frame=>{
          const raw=frame.declarations.get('transform')?.value;
          if(raw==null)return [];
          const value=raw==='none'?null:parseTransform(raw,style);
          return value===undefined?[]:[{offset:frame.offset,value,timing:frame.declarations.get('animation-timing-function')?.value}];
        });
        if(transforms.length){
          if(transforms[0].offset!==0)transforms.unshift({offset:0,value:style.transform??null});
          if(transforms.at(-1).offset!==1)transforms.push({offset:1,value:style.transform??null});
          const [left,right]=segment(transforms,progress,before);
          const portion=sampleEasing(right.offset===left.offset?0:(progress-left.offset)/(right.offset-left.offset),computedEasing(left.timing??config.timingFunction,style),before);
          const transform=interpolateTransform(left.value,right.value,portion);
          if(transform!==undefined){if(result===style)result={...style};result.transform=transform;}
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

// At a discontinuity choose the following segment, or its preceding segment
// for a before flag. Exact stops still need two endpoints for a step jump.
function segment(stops,progress,before) {
  let left=stops.findLast(stop=>before?stop.offset<progress:stop.offset<=progress)??stops[0];
  let right=stops.find(stop=>before?stop.offset>=progress:stop.offset>progress)??stops.at(-1);
  if(left===right&&stops.length>1) {
    if(progress>=stops.at(-1).offset)left=stops.findLast(stop=>stop.offset<right.offset)??left;
    else right=stops.find(stop=>stop.offset>left.offset)??right;
  }
  return [left,right];
}

// Keep percentages as symbolic lengths until layout knows the reference box.
function mixLength(a,b,t){
  if(typeof a==='number'&&typeof b==='number')return a+(b-a)*t;
  return {unit:'math',kind:'sum',values:[{unit:'math',kind:'scale',value:a,factor:1-t},{unit:'math',kind:'scale',value:b,factor:t}]};
}
function interpolateTransform(a,b,t){
  if(t===0)return a;if(t===1)return b;
  if(!a&&!b)return null;
  if(!a?.affine&&!b?.affine){
    return {x:mixLength(a?.x??0,b?.x??0,t),y:mixLength(a?.y??0,b?.y??0,t),
      scaleX:(a?.scaleX??1)+((b?.scaleX??1)-(a?.scaleX??1))*t,
      scaleY:(a?.scaleY??1)+((b?.scaleY??1)-(a?.scaleY??1))*t};
  }
  const identity=op=>op.kind==='translate'?{kind:op.kind,x:0,y:0}:op.kind==='scale'?{kind:op.kind,x:1,y:1}:{kind:op.kind,angle:0};
  const x=a?.affine?.operations??(!a?b.affine.operations.map(identity):null);
  const y=b?.affine?.operations??(!b?a.affine.operations.map(identity):null);
  if(!x||!y||x.length!==y.length||x.some((op,i)=>op.kind!==y[i].kind))return undefined;
  const operations=x.map((op,i)=>op.kind==='translate'||op.kind==='scale'
    ?{kind:op.kind,x:mixLength(op.x,y[i].x,t),y:mixLength(op.y,y[i].y,t)}
    :{kind:op.kind,angle:op.angle+(y[i].angle-op.angle)*t});
  return {x:0,y:0,affine:{operations}};
}
