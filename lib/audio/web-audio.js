import {biquadCoefficients} from './biquad.js';
import {floatToS16} from './pcm.js';

// A software Web Audio graph. Each running context shares one existing PCM
// output stream, regardless of how many oscillators or gain nodes it owns.
const QUANTUM = 128;
// Immutable by convention: nodes must allocate before modifying silence.
const SILENCE = new Float32Array(QUANTUM);
// Flush inaudible float32 subnormal filter state so a silent IIR tail can
// become inactive instead of keeping its whole graph processing forever.
const MIN_NORMAL_FLOAT32 = 2 ** -126;
const TAU = 2 * Math.PI;

// Backward graph edges do not own inactive, unreferenced input nodes. Running
// sources own their forward paths, and the context owns filters with live
// tails until those tails decay. Author-held nodes retain their connections.
class InputConnections {
  refs = new Set();
  byNode = new WeakMap();
  add(node) {
    if(!this.byNode.has(node)){const ref=new WeakRef(node);this.byNode.set(node,ref);this.refs.add(ref);}
  }
  delete(node) {
    const ref=this.byNode.get(node);this.byNode.delete(node);
    return ref?this.refs.delete(ref):false;
  }
  *[Symbol.iterator]() {
    for(const ref of this.refs){const node=ref.deref();if(node)yield node;else this.refs.delete(ref);}
  }
}
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
  decodeAudio = null, schedule = fn => setTimeout(fn, 0), reportError = () => {}, realtime = true} = {}) {
  const contexts = new WeakMap(), nodes = new WeakMap(), params = new WeakMap(), buffers = new WeakMap();
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

  const bufferOf = object => get(buffers, object);
  class AudioBuffer {
    constructor({numberOfChannels=1,length,sampleRate}={}) {
      const channels=Number(numberOfChannels),rate=finite(sampleRate);length=Math.trunc(Number(length));
      if(!Number.isInteger(channels)||channels<1||channels>32||!Number.isInteger(length)||length<1||channels*length>16777216||rate<8000||rate>192000)
        throw new DOMException('Unsupported audio buffer size or sample rate','NotSupportedError');
      buffers.set(this,{rate,length,data:Array.from({length:channels},()=>new Float32Array(length))});
    }
    get sampleRate(){return bufferOf(this).rate;}
    get length(){return bufferOf(this).length;}
    get duration(){const b=bufferOf(this);return b.length/b.rate;}
    get numberOfChannels(){return bufferOf(this).data.length;}
    getChannelData(channel){const b=bufferOf(this);channel=Number(channel)>>>0;if(channel>=b.data.length)throw new DOMException('Invalid audio channel','IndexSizeError');return b.data[channel];}
    copyFromChannel(destination,channel,start=0){const data=this.getChannelData(channel);start=Number(start)>>>0;if(!(destination instanceof Float32Array))throw new TypeError('Float32Array required');destination.set(data.subarray(start,start+destination.length));}
    copyToChannel(source,channel,start=0){const data=this.getChannelData(channel);start=Number(start)>>>0;if(!(source instanceof Float32Array))throw new TypeError('Float32Array required');if(start<data.length)data.set(source.subarray(0,data.length-start),start);}
  }
  async function decodeBuffer(input, rate) {
    if(!decodeAudio)throw new DOMException('Audio decoding unavailable','EncodingError');
    let decoder;
    try{
      decoder=await decodeAudio(input);
      const channels=decoder.channels,sourceRate=decoder.sampleRate,chunks=[];let count=0;
      if(!Number.isInteger(channels)||channels<1||channels>32||!(sourceRate>0))throw Error('Invalid audio stream');
      for(let chunk;(chunk=decoder.nextSamples())!==null;){
        if(!chunk.length)break;
        count+=chunk.length;
        if(count>16777216||count/channels/sourceRate*rate*channels>16777216)throw Error('Decoded audio exceeds buffer limit');
        chunks.push(chunk.slice());
      }
      if(!count||count%channels)throw Error('No complete audio samples');
      const samples=new Float32Array(count);let at=0;for(const chunk of chunks){samples.set(chunk,at);at+=chunk.length;}
      const frames=count/channels,length=Math.max(1,Math.round(frames*rate/sourceRate));
      const buffer=new AudioBuffer({numberOfChannels:channels,length,sampleRate:rate}),data=bufferOf(buffer).data;
      for(let i=0;i<length;i++){
        const pos=Math.min(frames-1,i*sourceRate/rate),a=Math.floor(pos),b=Math.min(frames-1,a+1),f=pos-a;
        for(let c=0;c<channels;c++)data[c][i]=samples[a*channels+c]*(1-f)+samples[b*channels+c]*f;
      }
      return buffer;
    }catch(error){throw new DOMException('Cannot decode audio: '+error.message,'EncodingError');}
    finally{decoder?.close();}
  }

  class AudioParam {
    constructor(context, value, min, max, token) {
      if (token !== internal) throw new TypeError('Illegal constructor');
      params.set(this, {context, initial:value, defaultValue:value, min, max, events:[], inputs:new InputConnections(), automationRate:'a-rate'});
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
      nodes.set(this,{context,kind,inputs:new InputConnections(),outputs:new Set(),channelCount:2,channelCountMode:'max',channelInterpretation:'speakers',handlers:new Map()});
    }
    get context() {return nodeOf(this).context;}
    get numberOfInputs() {return ['oscillator','buffer'].includes(nodeOf(this).kind)?0:1;}
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
  class BiquadFilterNode extends AudioNode {
    constructor(context,options={}) {
      super(context,'biquad',internal);
      const state=nodeOf(this);
      Object.assign(state,{type:'lowpass',z1:0,z2:0,
        frequency:new AudioParam(context,350,0,context.sampleRate/2,internal),
        detune:new AudioParam(context,0,-153600,153600,internal),
        Q:new AudioParam(context,1,-3.4028234663852886e38,3.4028234663852886e38,internal),
        gain:new AudioParam(context,0,-3.4028234663852886e38,3.4028234663852886e38,internal)});
      options??={};
      if(options.type!==undefined)this.type=options.type;
      for(const name of ['frequency','detune','Q','gain'])if(options[name]!==undefined)this[name].value=options[name];
    }
    get type(){return nodeOf(this).type;}
    set type(value){if(!['lowpass','highpass','bandpass','notch','allpass','peaking','lowshelf','highshelf'].includes(value))throw new TypeError('Invalid filter type');nodeOf(this).type=value;}
    get frequency(){return nodeOf(this).frequency;}
    get detune(){return nodeOf(this).detune;}
    get Q(){return nodeOf(this).Q;}
    get gain(){return nodeOf(this).gain;}
    getFrequencyResponse(frequencyHz,magResponse,phaseResponse){
      if(![frequencyHz,magResponse,phaseResponse].every(a=>a instanceof Float32Array))throw new TypeError('Float32Array required');
      if(frequencyHz.length!==magResponse.length||frequencyHz.length!==phaseResponse.length)throw new DOMException('Array lengths differ','InvalidAccessError');
      const state=nodeOf(this),rate=this.context.sampleRate,time=this.context.currentTime;
      const [frequency,detune,q,gain]=['frequency','detune','Q','gain'].map(name=>parameterValue(paramOf(state[name]),time));
      const [b0,b1,b2,a1,a2]=biquadCoefficients(state.type,frequency*2**(detune/1200),q,gain,rate);
      for(let i=0;i<frequencyHz.length;i++){
        const hz=frequencyHz[i];
        if(!(hz>=0&&hz<=rate/2)){magResponse[i]=phaseResponse[i]=NaN;continue;}
        const w=2*Math.PI*hz/rate,c=Math.cos(w),s=Math.sin(w),c2=Math.cos(2*w),s2=Math.sin(2*w);
        const nr=b0+b1*c+b2*c2,ni=-b1*s-b2*s2,dr=1+a1*c+a2*c2,di=-a1*s-a2*s2;
        magResponse[i]=Math.hypot(nr,ni)/Math.hypot(dr,di);phaseResponse[i]=Math.atan2(ni*dr-nr*di,nr*dr+ni*di);
      }
    }
  }
  class AudioScheduledSourceNode extends AudioNode {
    constructor(context, token,kind='oscillator') {if(token!==internal)throw new TypeError('Illegal constructor');super(context,kind,internal);}
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

  class AudioBufferSourceNode extends AudioScheduledSourceNode {
    constructor(context,options={}){
      super(context,internal,'buffer');
      Object.assign(nodeOf(this),{buffer:null,start:null,stop:Infinity,ended:false,position:0,offset:0,duration:Infinity,played:0,loop:false,loopStart:0,loopEnd:0,
        playbackRate:new AudioParam(context,1,-3.4028234663852886e38,3.4028234663852886e38,internal),detune:new AudioParam(context,0,-153600,153600,internal)});
      for(const key of ['buffer','loop','loopStart','loopEnd'])if(options[key]!==undefined)this[key]=options[key];
      this.playbackRate.automationRate='k-rate';this.detune.automationRate='k-rate';
      if(options.playbackRate!==undefined)this.playbackRate.value=options.playbackRate;
      if(options.detune!==undefined)this.detune.value=options.detune;
    }
    get buffer(){return nodeOf(this).buffer;}
    set buffer(value){if(value!==null)bufferOf(value);const n=nodeOf(this);if(n.buffer&&value)throw invalid('Buffer is already set');n.buffer=value;}
    get playbackRate(){return nodeOf(this).playbackRate;}
    get detune(){return nodeOf(this).detune;}
    get loop(){return nodeOf(this).loop;}
    set loop(value){nodeOf(this).loop=!!value;}
    get loopStart(){return nodeOf(this).loopStart;}
    set loopStart(value){nodeOf(this).loopStart=finite(value);}
    get loopEnd(){return nodeOf(this).loopEnd;}
    set loopEnd(value){nodeOf(this).loopEnd=finite(value);}
    start(when=0,offset=0,duration=undefined){
      offset=timeValue(offset);if(duration!==undefined)duration=timeValue(duration);
      super.start(when);const n=nodeOf(this);n.offset=offset;n.duration=duration??Infinity;
      n.position=n.buffer?Math.min(n.buffer.length,offset*n.buffer.sampleRate):0;
    }
  }

  function stopOutput(state) {
    const id=state.stream;
    state.stream=null;
    state.pending=null;
    state.pendingAt=0;
    clearTimeout(state.audioTimer);state.audioTimer=undefined;state.requested=0;
    return id===null?Promise.resolve():Promise.resolve(audio?.close(id));
  }
  function startOutput(context) {
    const state=contextOf(context);
    if (!audio||state.stream!==null||state.state!=='running') return;
    const id=audio.open({rate:state.rate,channels:2,name:'Web Audio'},event=>{
      if(state.stream!==id||state.state!=='running')return;
      if(event.event==='request') {
        if (!realtime) { audio.write(id,render(context,event.bytes)); return; }
        // The controller already paces playback and bounds its PCM reserve.
        // Yield between synthesis batches so page timers can enqueue future
        // notes; an additional wall-clock throttle here starves that reserve.
        state.requested += Math.max(0, Math.floor(event.bytes / 4)) * 4;
        pump();
      }
      else if(event.event==='error'||event.event==='ended'){
        state.stream=null;state.state='suspended';
        clearTimeout(state.audioTimer);state.audioTimer=undefined;state.requested=0;
        if(event.event==='error')reportError(new Error(`Web Audio: ${event.message}`));
        notify(context,'statechange');
      }
    });
    state.stream=id;
    state.requested=0;state.lastPump=performance.now();
    function pump() {
      if(state.stream!==id||state.state!=='running'||disposed)return;
      if(state.audioTimer!==undefined)return;
      const now=performance.now(),gap=now-state.lastPump;
      state.lastPump=now;
      // After a long paint, a 64 ms packet cannot replenish what was played.
      // Stay below the usual 100 ms script lookahead even when catching up.
      const frames=Math.min(Math.floor(state.requested/4),Math.floor(state.rate*(gap>=64?.096:.064)));
      if(frames>0){
        state.requested-=frames*4;
        audio.write(id,render(context,frames*4));
      }
      if(state.requested>0){
        // A late synthesis task has already yielded to page work. Do not add
        // another 25 ms delay while trying to replenish the device queue.
        state.audioTimer=setTimeout(()=>{state.audioTimer=undefined;pump();},gap>=64?0:25);
      }
    }
  }
  class BaseAudioContext extends EventTarget {
    constructor(token) {super();if(token!==internal)throw new TypeError('Illegal constructor');}
    get destination() {return contextOf(this).destination;}
    get sampleRate() {return contextOf(this).rate;}
    get currentTime() {return clock(this);}
    get state() {return contextOf(this).state;}
    createOscillator() {contextOf(this);return new OscillatorNode(this);}
    createGain() {contextOf(this);return new GainNode(this);}
    createBiquadFilter() {contextOf(this);return new BiquadFilterNode(this);}
    createBuffer(channels,length,sampleRate){contextOf(this);return new AudioBuffer({numberOfChannels:channels,length,sampleRate});}
    createBufferSource(){contextOf(this);return new AudioBufferSourceNode(this);}
    decodeAudioData(input,success,error){
      const rate=contextOf(this).rate;
      let bytes;
      try{
        if(!(input instanceof ArrayBuffer))throw new TypeError('ArrayBuffer required');
        if(input.byteLength>64*1024*1024)throw new DOMException('Audio input exceeds limit','EncodingError');
        bytes=new Uint8Array(structuredClone(input,{transfer:[input]}));
      }catch(error){return Promise.reject(error);}
      const promise=Promise.resolve().then(()=>{if(disposed)throw new DOMException('Document closed','AbortError');return decodeBuffer(bytes,rate);});
      return promise.then(value=>{if(disposed)throw new DOMException('Document closed','AbortError');if(typeof success==='function')try{success(value);}catch(e){reportError(e);}return value;},reason=>{if(!disposed&&typeof error==='function')try{error(reason);}catch(e){reportError(e);}throw reason;});
    }
  }
  class AudioContext extends BaseAudioContext {
    constructor(options={}) {
      super(internal);
      if(disposed)throw invalid('The document is no longer active');
      const rate=finite(options?.sampleRate??48000);
      if(!Number.isInteger(rate)||rate<8000||rate>192000)throw new DOMException('Unsupported sample rate','NotSupportedError');
      const state={rate,frame:0,state:'running',destination:null,sources:new Set(),tails:new Set(),stream:null,pending:null,pendingAt:0,handlers:new Map()};
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
      state.state='closed';state.sources.clear();state.tails.clear();live.delete(this);notify(this,'statechange');
      return stopOutput(state).then(()=>undefined);
    }
  }

  function renderQuantum(context) {
    const state=contextOf(context), cache=new Map(), visiting=new Set(), time=state.frame/state.rate;
    const sumInputs=inputs=>{
      let output=SILENCE;
      for(const input of inputs){
        const samples=pull(input);if(samples===SILENCE)continue;
        if(output===SILENCE)output=new Float32Array(QUANTUM);
        for(let i=0;i<QUANTUM;i++)output[i]+=samples[i];
      }
      return output;
    };
    const paramValues=param=>{
      const p=paramOf(param),input=sumInputs(p.inputs),values=input===SILENCE?new Float32Array(QUANTUM):input;
      const last=p.events.at(-1);
      if(!last||last.time<=time&&last.kind!=='target'){
        const value=last?last.value:p.initial;
        if(input===SILENCE)values.fill(value);else for(let i=0;i<QUANTUM;i++)values[i]+=value;
        return values;
      }
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
      }else if(n.kind==='buffer'){
        output=new Float32Array(QUANTUM);
        if(n.start!==null&&!n.ended){
          const rate=paramValues(n.playbackRate),detune=paramValues(n.detune),b=n.buffer?bufferOf(n.buffer):null;
          const end=()=>{n.ended=true;state.sources.delete(node);disconnectOutputs(node);notify(node,'ended');};
          for(let i=0;i<QUANTUM;i++){
            const t=time+i/state.rate;if(t<n.start)continue;
            if(t>=n.stop||!b||n.played>=n.duration||!n.loop&&n.position>=b.length){end();break;}
            const loopStart=Math.max(0,Math.min(b.length,n.loopStart*b.rate)),loopEnd=n.loopEnd>n.loopStart?Math.min(b.length,n.loopEnd*b.rate):b.length;
            if(n.loop&&loopEnd>loopStart&&n.position>=loopEnd)n.position=loopStart+(n.position-loopStart)%(loopEnd-loopStart);
            const pos=Math.max(0,Math.min(b.length-1,n.position)),a=Math.floor(pos),next=n.loop&&a+1>=loopEnd?Math.floor(loopStart):Math.min(b.length-1,a+1),f=pos-a;
            let value=0;for(const data of b.data)value+=data[a]*(1-f)+data[next]*f;
            output[i]=value/b.data.length;
            const step=Math.max(0,rate[i]*2**(detune[i]/1200))*b.rate/state.rate;
            n.position+=step;n.played+=step/b.rate;
          }
          if(!n.ended&&(time+QUANTUM/state.rate>=n.stop||n.played>=n.duration||b&&!n.loop&&n.position>=b.length))end();
        }
      }else{
        output=sumInputs(n.inputs);
        if(n.kind==='gain'&&output!==SILENCE){const gain=paramValues(n.gain);for(let i=0;i<QUANTUM;i++)output[i]*=gain[i];}
        if(n.kind==='biquad' && !(output===SILENCE&&n.z1===0&&n.z2===0)){
          if(output===SILENCE)output=new Float32Array(QUANTUM);
          const frequency=paramValues(n.frequency),detune=paramValues(n.detune),q=paramValues(n.Q),gain=paramValues(n.gain);
          for(let i=0;i<QUANTUM;i++){
            const hz=frequency[i]*2**(detune[i]/1200);
            if(!n.coefficients||n.lastType!==n.type||n.lastHz!==hz||n.lastQ!==q[i]||n.lastGain!==gain[i]){
              n.coefficients=biquadCoefficients(n.type,hz,q[i],gain[i],state.rate);
              n.lastType=n.type;n.lastHz=hz;n.lastQ=q[i];n.lastGain=gain[i];
            }
            const [b0,b1,b2,a1,a2]=n.coefficients,x=output[i],y=b0*x+n.z1;
            n.z1=b1*x-a1*y+n.z2;n.z2=b2*x-a2*y;
            if(Number.isFinite(y)&&Number.isFinite(n.z1)&&Number.isFinite(n.z2))output[i]=y;
            else {output[i]=0;n.z1=n.z2=0;}
          }
          if(Math.abs(n.z1)<MIN_NORMAL_FLOAT32)n.z1=0;
          if(Math.abs(n.z2)<MIN_NORMAL_FLOAT32)n.z2=0;
          if(n.z1!==0||n.z2!==0)state.tails.add(node);
          else state.tails.delete(node);
        }
      }
      visiting.delete(node);cache.set(node,output);return output;
    };
    const output=pull(state.destination);
    // Disconnected started oscillators continue their phase for reconnect.
    for(const source of state.sources)pull(source);
    for(const filter of state.tails)pull(filter);
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
  const api={AudioContext,webkitAudioContext:AudioContext,BaseAudioContext,AudioNode,AudioDestinationNode,AudioScheduledSourceNode,OscillatorNode,GainNode,BiquadFilterNode,AudioParam,AudioBuffer,AudioBufferSourceNode};
  for(const Constructor of new Set(Object.values(api)))Object.defineProperty(Constructor.prototype,Symbol.toStringTag,{value:Constructor.name,configurable:true});
  return {api,dispose(){disposed=true;for(const context of live){const state=contextOf(context);state.state='closed';state.sources.clear();state.tails.clear();void stopOutput(state).catch(reportError);}live.clear();}};
}
