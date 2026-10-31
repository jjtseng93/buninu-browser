import {floatToS16} from './pcm.js';

// A software Web Audio graph. Each running context shares one existing PCM
// output stream, regardless of how many oscillators or gain nodes it owns.
const QUANTUM = 128;
const TAU = 2 * Math.PI;
const finite = value => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError('A finite number is required');
  return number;
};
const timeValue = value => {
  const time = finite(value);
  if (time < 0) throw new RangeError('Time must not be negative');
  return time;
};

export function createWebAudioScope({audio = null, EventTarget = globalThis.EventTarget,
  Event = globalThis.Event, DOMException = globalThis.DOMException,
  schedule = fn => setTimeout(fn, 0), reportError = () => {}} = {}) {
  const contexts = new WeakMap(), nodes = new WeakMap(), params = new WeakMap();
  const live = new Set(), internal = {};
  let disposed = false;
  const get = (map, object) => {
    const state = map.get(object);
    if (!state) throw new TypeError('Illegal invocation');
    return state;
  };
  const contextOf = object => get(contexts, object);
  const nodeOf = object => get(nodes, object);
  const paramOf = object => get(params, object);
  const invalid = message => new DOMException(message, 'InvalidStateError');
  const clock = context => {const state=contextOf(context);return state.frame/state.rate;};
  const notify = (target, type) => schedule(() => {
    if (!disposed) target.dispatchEvent(new Event(type));
  });

  function parameterValue(state, time) {
    // Rendering asks for monotonically increasing sample times. Retain the
    // automation cursor so a long score does not rescan every previous note
    // for every sample. Edits and backward queries restart that cursor.
    let cursor=state.cursor;
    if (!cursor || time<cursor.time) cursor={index:0,value:state.initial,anchor:0,target:null,time:-Infinity};
    let {index,value,anchor,target}=cursor;
    const at=end=>target ? target.value+(value-target.value)*Math.exp(-(end-anchor)/target.constant) : value;
    for(;index<state.events.length;index++) {
      const event=state.events[index];
      if(time<event.time)break;
      value=at(event.time);anchor=event.time;
      target=event.kind==='target'&&event.constant>0?event:null;
      if(!target)value=event.value;
    }
    Object.assign(cursor,{index,value,anchor,target,time});state.cursor=cursor;
    const next=state.events[index];
    if(next && next.time>anchor){
      const fraction=Math.max(0,(time-anchor)/(next.time-anchor));
      if(next.kind==='linear')return value+(next.value-value)*fraction;
      if(next.kind==='exponential'&&value*next.value>0)return value*(next.value/value)**fraction;
    }
    return at(time);
  }

  class AudioParam {
    constructor(context, value, min, max, token) {
      if (token !== internal) throw new TypeError('Illegal constructor');
      params.set(this, {context, initial:value, defaultValue:value, min, max, events:[], inputs:new Set(), automationRate:'a-rate'});
    }
    get value() {const state=paramOf(this);return parameterValue(state, clock(state.context));}
    set value(value) {this.setValueAtTime(value, clock(paramOf(this).context));}
    get defaultValue() {return paramOf(this).defaultValue;}
    get minValue() {return paramOf(this).min;}
    get maxValue() {return paramOf(this).max;}
    get automationRate() {return paramOf(this).automationRate;}
    set automationRate(value) {
      if (!['a-rate','k-rate'].includes(value)) throw new TypeError('Invalid automation rate');
      paramOf(this).automationRate=value;
    }
    setValueAtTime(value, time) {return addEvent(this, 'set', value, time);}
    linearRampToValueAtTime(value, time) {return addEvent(this, 'linear', value, time);}
    exponentialRampToValueAtTime(value, time) {
      if (finite(value) === 0) throw new RangeError('An exponential ramp cannot target zero');
      return addEvent(this, 'exponential', value, time);
    }
    setTargetAtTime(value, time, constant) {
      constant=finite(constant);
      if (constant < 0) throw new RangeError('Time constant must not be negative');
      return addEvent(this, 'target', value, time, constant);
    }
    cancelScheduledValues(time) {
      time=timeValue(time);
      const state=paramOf(this);
      state.events=state.events.filter(event=>event.time<time);
      state.cursor=null;
      return this;
    }
    cancelAndHoldAtTime(time) {
      time=timeValue(time);
      const state=paramOf(this), value=parameterValue(state,time);
      const next=state.events.find(event=>event.time>=time);
      this.cancelScheduledValues(time);
      // Keep the part of a ramp before the cancellation point, then hold.
      if (next && ['linear','exponential'].includes(next.kind)) addEvent(this,next.kind,value,time);
      return this.setValueAtTime(value,time);
    }
  }

  function addEvent(param, kind, value, time, constant) {
    const state=paramOf(param);
    value=Math.max(state.min,Math.min(state.max,finite(value)));
    time=timeValue(time);
    const event={kind,value,time,constant};
    const existing=state.events.findIndex(item=>item.kind===kind&&item.time===time);
    if (existing>=0) state.events.splice(existing,1);
    state.events.push(event);
    state.events.sort((a,b)=>a.time-b.time);state.cursor=null;
    return param;
  }

  function disconnectOutputs(node) {
    const state=nodeOf(node);
    for(const target of state.outputs)(nodes.get(target)??params.get(target)).inputs.delete(node);
    state.outputs.clear();
  }

  class AudioNode extends EventTarget {
    constructor(context, kind, token) {
      super();
      if (token !== internal) throw new TypeError('Illegal constructor');
      contextOf(context);
      nodes.set(this,{context,kind,inputs:new Set(),outputs:new Set(),channelCount:2,channelCountMode:'max',channelInterpretation:'speakers',handlers:new Map()});
    }
    get context() {return nodeOf(this).context;}
    get numberOfInputs() {return nodeOf(this).kind==='oscillator'?0:1;}
    get numberOfOutputs() {return nodeOf(this).kind==='destination'?0:1;}
    get channelCount() {return nodeOf(this).channelCount;}
    set channelCount(value) {
      value=Number(value);
      if (!Number.isInteger(value)||value<1||value>2) throw new DOMException('Only mono and stereo are supported','NotSupportedError');
      const state=nodeOf(this);
      if (state.kind==='destination' && value!==2) throw new DOMException('The output is stereo','NotSupportedError');
      state.channelCount=value;
    }
    get channelCountMode() {return nodeOf(this).channelCountMode;}
    set channelCountMode(value) {
      if (!['max','clamped-max','explicit'].includes(value)) throw new TypeError('Invalid channel count mode');
      nodeOf(this).channelCountMode=value;
    }
    get channelInterpretation() {return nodeOf(this).channelInterpretation;}
    set channelInterpretation(value) {
      if (!['speakers','discrete'].includes(value)) throw new TypeError('Invalid channel interpretation');
      nodeOf(this).channelInterpretation=value;
    }
    connect(destination, output=0, input=0) {
      const state=nodeOf(this), target=nodes.get(destination)??params.get(destination);
      if (!target) throw new TypeError('An AudioNode or AudioParam is required');
      if (target.context!==state.context) throw new DOMException('Nodes belong to different contexts','InvalidAccessError');
      if (output!==0||this.numberOfOutputs===0||input!==0||nodes.has(destination)&&destination.numberOfInputs===0) throw new DOMException('Invalid port index','IndexSizeError');
      state.outputs.add(destination);target.inputs.add(this);
      return nodes.has(destination)?destination:undefined;
    }
    disconnect(destination, output=0, input=0) {
      const state=nodeOf(this);
      if (destination===undefined||typeof destination==='number') {
        if (typeof destination==='number'&&destination!==0) throw new DOMException('Invalid port index','IndexSizeError');
        disconnectOutputs(this);return;
      }
      if (output!==0||input!==0) throw new DOMException('Invalid port index','IndexSizeError');
      if (!nodes.has(destination)&&!params.has(destination)) throw new TypeError('An AudioNode or AudioParam is required');
      if (!state.outputs.delete(destination)) throw new DOMException('The connection does not exist','InvalidAccessError');
      (nodes.get(destination)??params.get(destination)).inputs.delete(this);
    }
  }

  class AudioDestinationNode extends AudioNode {
    constructor(context, token) {if(token!==internal)throw new TypeError('Illegal constructor');super(context,'destination',internal);}
    get maxChannelCount() {nodeOf(this);return 2;}
  }
  class GainNode extends AudioNode {
    constructor(context, options={}) {
      super(context,'gain',internal);
      options ??= {};
      nodeOf(this).gain=new AudioParam(context,1,-3.4028234663852886e38,3.4028234663852886e38,internal);
      if(options.gain!==undefined)this.gain.value=options.gain;
    }
    get gain() {return nodeOf(this).gain;}
  }
  class AudioScheduledSourceNode extends AudioNode {
    constructor(context, token) {if(token!==internal)throw new TypeError('Illegal constructor');super(context,'oscillator',internal);}
    start(when=0) {
      const state=nodeOf(this);
      if (state.start!==null) throw invalid('The source has already been started');
      state.start=Math.max(timeValue(when),clock(this.context));
      contextOf(this.context).sources.add(this);
    }
    stop(when=0) {
      const state=nodeOf(this);
      if(state.start===null)throw invalid('The source has not been started');
      state.stop=Math.max(timeValue(when),clock(this.context));
    }
  }
  class OscillatorNode extends AudioScheduledSourceNode {
    constructor(context, options={}) {
      super(context,internal);
      options ??= {};
      Object.assign(nodeOf(this),{start:null,stop:Infinity,ended:false,phase:0,type:'sine',
        frequency:new AudioParam(context,440,-context.sampleRate/2,context.sampleRate/2,internal),
        detune:new AudioParam(context,0,-153600,153600,internal)});
      if(options.type!==undefined)this.type=options.type;
      if(options.frequency!==undefined)this.frequency.value=options.frequency;
      if(options.detune!==undefined)this.detune.value=options.detune;
    }
    get type() {return nodeOf(this).type;}
    set type(value) {
      if(value==='custom')throw invalid('A periodic wave has not been supplied');
      if(!['sine','square','sawtooth','triangle'].includes(value))throw new TypeError('Invalid oscillator type');
      nodeOf(this).type=value;
    }
    get frequency() {return nodeOf(this).frequency;}
    get detune() {return nodeOf(this).detune;}
  }

  function stopOutput(state) {
    const id=state.stream;
    state.stream=null;
    state.pending=null;
    state.pendingAt=0;
    return id===null?Promise.resolve():Promise.resolve(audio?.close(id));
  }
  function startOutput(context) {
    const state=contextOf(context);
    if (!audio||state.stream!==null||state.state!=='running') return;
    const id=audio.open({rate:state.rate,channels:2,name:'Web Audio'},event=>{
      if(state.stream!==id||state.state!=='running')return;
      if(event.event==='request')audio.write(id,render(context,event.bytes));
      else if(event.event==='error'||event.event==='ended'){
        state.stream=null;state.state='suspended';
        if(event.event==='error')reportError(new Error(`Web Audio: ${event.message}`));
        notify(context,'statechange');
      }
    });
    state.stream=id;
  }
  class BaseAudioContext extends EventTarget {
    constructor(token) {super();if(token!==internal)throw new TypeError('Illegal constructor');}
    get destination() {return contextOf(this).destination;}
    get sampleRate() {return contextOf(this).rate;}
    get currentTime() {return clock(this);}
    get state() {return contextOf(this).state;}
    createOscillator() {contextOf(this);return new OscillatorNode(this);}
    createGain() {contextOf(this);return new GainNode(this);}
  }
  class AudioContext extends BaseAudioContext {
    constructor(options={}) {
      super(internal);
      if(disposed)throw invalid('The document is no longer active');
      const rate=finite(options?.sampleRate??48000);
      if(!Number.isInteger(rate)||rate<8000||rate>192000)throw new DOMException('Unsupported sample rate','NotSupportedError');
      const state={rate,frame:0,state:'running',destination:null,sources:new Set(),stream:null,pending:null,pendingAt:0,handlers:new Map()};
      contexts.set(this,state);live.add(this);
      state.destination=new AudioDestinationNode(this,internal);
      startOutput(this);
    }
    get baseLatency() {contextOf(this);return .12;}
    get outputLatency() {contextOf(this);return 0;}
    suspend() {
      const state=contextOf(this);
      if(state.state==='closed')return Promise.reject(invalid('The context is closed'));
      if(state.state==='suspended')return Promise.resolve();
      state.state='suspended';notify(this,'statechange');
      return stopOutput(state).then(()=>undefined);
    }
    resume() {
      const state=contextOf(this);
      if(state.state==='closed')return Promise.reject(invalid('The context is closed'));
      if(state.state==='running')return Promise.resolve();
      state.state='running';startOutput(this);notify(this,'statechange');return Promise.resolve();
    }
    close() {
      const state=contextOf(this);
      if(state.state==='closed')return Promise.reject(invalid('The context is closed'));
      state.state='closed';state.sources.clear();live.delete(this);notify(this,'statechange');
      return stopOutput(state).then(()=>undefined);
    }
  }

  function renderQuantum(context) {
    const state=contextOf(context), cache=new Map(), visiting=new Set(), time=state.frame/state.rate;
    const sumInputs=inputs=>{
      const output=new Float32Array(QUANTUM);
      for(const input of inputs){const samples=pull(input);for(let i=0;i<QUANTUM;i++)output[i]+=samples[i];}
      return output;
    };
    const paramValues=param=>{
      const p=paramOf(param),values=sumInputs(p.inputs);
      for(let i=0;i<QUANTUM;i++)values[i]+=parameterValue(p,time+(p.automationRate==='k-rate'?0:i/state.rate));
      return values;
    };
    const pull=node=>{
      if(cache.has(node))return cache.get(node);
      // A cycle without a delay node contributes silence, never recursion.
      if(visiting.has(node))return new Float32Array(QUANTUM);
      visiting.add(node);
      const n=nodeOf(node);
      let output;
      if(n.kind==='oscillator'){
        output=new Float32Array(QUANTUM);
        if(n.start!==null&&!n.ended){
          const frequency=paramValues(n.frequency),detune=paramValues(n.detune);
          for(let i=0;i<QUANTUM;i++){
            const t=time+i/state.rate;
            if(t<n.start||t>=n.stop)continue;
            const phase=n.phase;
            output[i]=n.type==='sine'?Math.sin(phase):n.type==='triangle'?2/Math.PI*Math.asin(Math.sin(phase)):
              n.type==='square'?(phase<Math.PI?1:-1):2*((phase/TAU+.5)%1)-1;
            const hz=Math.max(-state.rate/2,Math.min(state.rate/2,frequency[i]*2**(detune[i]/1200)));
            n.phase=((phase+TAU*hz/state.rate)%TAU+TAU)%TAU;
          }
          if(time+QUANTUM/state.rate>=n.stop){n.ended=true;state.sources.delete(node);disconnectOutputs(node);notify(node,'ended');}
        }
      }else{
        output=sumInputs(n.inputs);
        if(n.kind==='gain'){const gain=paramValues(n.gain);for(let i=0;i<QUANTUM;i++)output[i]*=gain[i];}
      }
      visiting.delete(node);cache.set(node,output);return output;
    };
    const output=pull(state.destination);
    // Disconnected started oscillators continue their phase for reconnect.
    for(const source of state.sources)pull(source);
    state.frame+=QUANTUM;
    return output;
  }
  function render(context, bytes) {
    const state=contextOf(context),frames=Math.max(0,Math.floor(bytes/4)),samples=new Float32Array(frames*2);
    for(let i=0;i<frames;i++){
      if(!state.pending||state.pendingAt>=state.pending.length){state.pending=renderQuantum(context);state.pendingAt=0;}
      const value=state.pending[state.pendingAt++];samples[i*2]=value;samples[i*2+1]=value;
    }
    return floatToS16(samples);
  }

  for(const [Constructor,name,stateOf]of [[BaseAudioContext,'statechange',contextOf],[AudioScheduledSourceNode,'ended',nodeOf]]){
    Object.defineProperty(Constructor.prototype,`on${name}`,{configurable:true,enumerable:true,
      get(){return stateOf(this).handlers.get(name)??null;},
      set(handler){const handlers=stateOf(this).handlers,previous=handlers.get(name);if(previous)this.removeEventListener(name,previous);handlers.delete(name);if(typeof handler==='function'){handlers.set(name,handler);this.addEventListener(name,handler);}},
    });
  }
  const api={AudioContext,webkitAudioContext:AudioContext,BaseAudioContext,AudioNode,AudioDestinationNode,AudioScheduledSourceNode,OscillatorNode,GainNode,AudioParam};
  for(const Constructor of new Set(Object.values(api)))Object.defineProperty(Constructor.prototype,Symbol.toStringTag,{value:Constructor.name,configurable:true});
  return {api,dispose(){disposed=true;for(const context of live){const state=contextOf(context);state.state='closed';state.sources.clear();void stopOutput(state).catch(reportError);}live.clear();}};
}
