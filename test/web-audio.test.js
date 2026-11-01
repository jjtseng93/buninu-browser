import {test,expect} from 'bun:test';
import {createWebAudioScope} from '../lib/audio/web-audio.js';

function setup(realtime = false) {
  const outputs=[],closed=[],errors=[];
  const scope=createWebAudioScope({realtime,
    audio:{
      open(options,listener){outputs.push({options,listener,pcm:[]});return outputs.length;},
      write(id,bytes){outputs[id-1].pcm.push(new Int16Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/2).slice());},
      close(id){closed.push(id);},
    },reportError:error=>errors.push(String(error)),
  });
  const context=new scope.api.AudioContext({sampleRate:8000});
  const pull=(frames=128)=>{
    const output=outputs.at(-1);
    output.listener({event:'request',bytes:frames*4});
    return output.pcm.at(-1);
  };
  return {...scope,context,outputs,closed,errors,pull};
}

test('oscillator PCM follows frequency, gain, disconnect and reconnect without duplicate connections',()=>{
  const f=setup(),c=f.context,o=c.createOscillator(),g=c.createGain();
  try {
    o.frequency.setValueAtTime(500,c.currentTime);g.gain.value=.25;
    expect(o.connect(g)).toBe(g);g.connect(c.destination);g.connect(c.destination);o.start();
    const first=f.pull();
    expect(first[8]).toBeCloseTo(8192,0); // Stereo frame 4: sin(pi/2) * .25.
    for(let i=0;i<first.length;i+=2)expect(first[i]).toBe(first[i+1]);
    o.frequency.setValueAtTime(1000,c.currentTime);
    const second=f.pull();expect(second[4]).toBeCloseTo(8192,0);
    o.disconnect();expect([...f.pull()].every(x=>x===0)).toBe(true);
    o.connect(g);g.gain.value=.1;expect(f.pull()[4]).toBeCloseTo(3277,0);
    expect(c.currentTime).toBe(512/8000);
    expect(f.outputs).toHaveLength(1);
  }finally{f.dispose();}
  expect(f.closed).toEqual([1]);expect(f.errors).toEqual([]);
});

test('scheduled start, stop, gain ramps and ended events use the audio sample timeline',async()=>{
  const f=setup(),c=f.context,o=c.createOscillator(),g=c.createGain();let ended=0;
  try {
    o.frequency.value=500;o.connect(g).connect(c.destination);
    g.gain.setValueAtTime(0,0).linearRampToValueAtTime(1,.032);
    o.onended=()=>ended++;o.start(.016);o.stop(.04);
    const samples=f.pull(512);
    expect([...samples.slice(0,128*2)].every(x=>x===0)).toBe(true);
    expect(samples[(128+4)*2]).toBeCloseTo(Math.round(32767*132/256),0);
    expect([...samples.slice(320*2)].every(x=>x===0)).toBe(true);
    await Bun.sleep(10);expect(ended).toBe(1);
    f.pull();await Bun.sleep(5);expect(ended).toBe(1);
    expect(()=>o.start()).toThrow();
  }finally{f.dispose();}
});

test('suspend freezes the context and resume reopens only its own stream; close rejects later resume',async()=>{
  const f=setup(),c=f.context,o=c.createOscillator();
  o.connect(c.destination);o.start();f.pull();const time=c.currentTime;
  await c.suspend();expect(c.state).toBe('suspended');expect(f.closed).toEqual([1]);
  f.outputs[0].listener({event:'request',bytes:512});expect(c.currentTime).toBe(time);
  await c.resume();expect(c.state).toBe('running');expect(f.outputs).toHaveLength(2);
  f.pull();expect(c.currentTime).toBeGreaterThan(time);
  await c.close();expect(c.state).toBe('closed');expect(f.closed).toEqual([1,2]);
  await expect(c.resume()).rejects.toMatchObject({name:'InvalidStateError'});
  f.dispose();expect(f.closed).toEqual([1,2]);
});

test('parameter ramps can be held and cancelled; invalid times, ports and cross-context graphs reject',()=>{
  const f=setup(),c=f.context,o=c.createOscillator(),g=c.createGain();
  try {
    const p=g.gain;
    p.setValueAtTime(0,0).linearRampToValueAtTime(1,.1).cancelAndHoldAtTime(.05);
    f.pull(800);expect(p.value).toBeCloseTo(.5);
    p.cancelScheduledValues(0);p.value=.25;expect(p.value).toBe(.25);
    expect(()=>p.setValueAtTime(1,-1)).toThrow(RangeError);
    expect(()=>p.setValueAtTime(NaN,0)).toThrow(TypeError);
    expect(()=>p.exponentialRampToValueAtTime(0,1)).toThrow(RangeError);
    expect(()=>o.stop()).toThrow();
    expect(()=>o.connect(c.destination,1)).toThrow();
    const other=new f.api.AudioContext();expect(()=>o.connect(other.destination)).toThrow();
  }finally{f.dispose();}
});

test('multiple sources mix in one stream and cycles cannot recurse indefinitely',()=>{
  const f=setup(),c=f.context,a=c.createOscillator(),b=new f.api.OscillatorNode(c,{frequency:1000,detune:1200});
  try {
    const g=new f.api.GainNode(c,{gain:.1});
    a.frequency.value=500;a.connect(g);b.connect(g);g.connect(c.destination);
    a.start();b.start();const samples=f.pull();
    expect(samples[4]).toBeCloseTo(Math.round(32767*.1*Math.sin(Math.PI/4)),0);
    expect(f.outputs).toHaveLength(1);
    g.connect(g);expect([...f.pull()].every(Number.isFinite)).toBe(true);
    expect(()=>new f.api.AudioNode(c)).toThrow(TypeError);
    expect(()=>new f.api.AudioParam()).toThrow(TypeError);
    expect(f.api.webkitAudioContext).toBe(f.api.AudioContext);
  }finally{f.dispose();}
});

test('sample buffers play through the existing PCM graph with looping, rate and ended events',async()=>{
 const f=setup(),c=f.context;
 try{
  const b=c.createBuffer(1,4,8000);b.copyToChannel(new Float32Array([0,.25,.5,.75]),0);
  expect([...b.getChannelData(0)]).toEqual([0,.25,.5,.75]);expect(b.duration).toBe(.0005);
  const copy=new Float32Array(3);b.copyFromChannel(copy,0,1);expect([...copy]).toEqual([.25,.5,.75]);
  expect(()=>b.getChannelData(1)).toThrow();
  const node=c.createBufferSource();let ended=0;node.buffer=b;node.onended=()=>ended++;
  node.loop=true;node.loopStart=1/8000;node.loopEnd=3/8000;
  node.connect(c.destination);node.start();
  const pcm=f.pull(8);expect([...pcm.filter((_,i)=>i%2===0)]).toEqual([0,8192,16384,8192,16384,8192,16384,8192]);
  node.stop(c.currentTime);f.pull(128);await Bun.sleep(10);expect(ended).toBe(1);
  const faster=c.createBufferSource();faster.buffer=b;faster.playbackRate.value=2;faster.connect(c.destination);faster.start();
  expect([...f.pull(128).filter((_,i)=>i%2===0)].filter(x=>x!==0)).toEqual([16384]);
  expect(()=>faster.start()).toThrow();
 }finally{f.dispose();}
});

test('decodeAudioData detaches input, resamples samples, completes callbacks and closes the decoder',async()=>{
 let closed=0,success=0,failures=0;
 const scope=createWebAudioScope({realtime:false,decodeAudio:async bytes=>{
  if(bytes[0]===0)throw Error('invalid compressed sound');
  let first=true;return {sampleRate:16000,channels:1,nextSamples(){if(!first)return null;first=false;return new Float32Array([0,.25,.5,.75,1,.75,.5,.25]);},close(){closed++;}};
 }});
 const c=new scope.api.AudioContext({sampleRate:8000});
 try{
  const input=new Uint8Array([1]).buffer;
  const pending=c.decodeAudioData(input,b=>{success++;expect(b.sampleRate).toBe(8000);});
  expect(input.byteLength).toBe(0);
  const b=await pending;expect([...b.getChannelData(0)]).toEqual([0,.5,1,.5]);expect(success).toBe(1);expect(closed).toBe(1);
  await expect(c.decodeAudioData(new Uint8Array([0]).buffer,null,e=>{failures++;expect(e.name).toBe('EncodingError');})).rejects.toMatchObject({name:'EncodingError'});
  expect(failures).toBe(1);
  await expect(c.decodeAudioData(new Uint8Array([1]))).rejects.toThrow('ArrayBuffer');
 }finally{scope.dispose();}
});

test('BiquadFilterNode reports frequency response and filters actual PCM',async()=>{
 const t=setup(),{context}=t;
 try{
  const filter=context.createBiquadFilter();filter.frequency.value=200;filter.Q.value=0;
  expect(filter).toBeInstanceOf(t.api.BiquadFilterNode);
  const frequencies=new Float32Array([0,100,2000,5000]),magnitude=new Float32Array(4),phase=new Float32Array(4);
  filter.getFrequencyResponse(frequencies,magnitude,phase);
  expect(magnitude[0]).toBeCloseTo(1,5);expect(magnitude[1]).toBeGreaterThan(.8);
  expect(magnitude[2]).toBeLessThan(.01);expect(Number.isNaN(magnitude[3])).toBe(true);
  expect(()=>filter.getFrequencyResponse(frequencies,new Float32Array(1),phase)).toThrow();
  const oscillator=context.createOscillator();oscillator.frequency.value=2000;oscillator.connect(filter);filter.connect(context.destination);oscillator.start();
  await context.resume();let filtered;
  for(let i=0;i<12;i++)filtered=t.pull();
  const rms=samples=>Math.sqrt(samples.reduce((sum,value)=>sum+value*value,0)/samples.length);
  expect(rms(filtered)).toBeLessThan(300);
  filter.type='highpass';let passed;
  for(let i=0;i<12;i++)passed=t.pull();
  expect(rms(passed)).toBeGreaterThan(10000);
 }finally{await context.close();t.dispose();}
});


test('live synthesis yields between bounded packets so page timers can schedule future notes', async()=>{
 const f=setup(true),c=f.context;let timer;
 try {
  let next=0;
  const schedule=()=>{while(next<c.currentTime+.1){const o=c.createOscillator();o.frequency.value=500;o.connect(c.destination);o.start(next);o.stop(next+.055);next+=.04;}};
  schedule();timer=setInterval(schedule,25);
  const started=performance.now();f.outputs[0].listener({event:'request',bytes:8000*.25*4});
  expect(c.currentTime).toBeLessThanOrEqual(.08+128/c.sampleRate);
  await Bun.sleep(170);
  expect(c.currentTime).toBeLessThan((performance.now()-started)/1000+.10);
  const pcm=f.outputs[0].pcm;expect(pcm.length).toBeGreaterThan(3);
  expect(pcm.every(packet=>packet.length<=8000*.096*2)).toBe(true);
  expect(pcm.every(packet=>packet.some(value=>value!==0))).toBe(true);
 } finally {clearInterval(timer);f.dispose();}
});


test('silent connected gain branches remain reconnectable and preserve elapsed automation',()=>{
 const f=setup(),c=f.context;
 try {
  const master=c.createGain();master.connect(c.destination);
  for(let i=0;i<300;i++){const g=c.createGain();g.gain.setValueAtTime(.1,0).exponentialRampToValueAtTime(.001,.1);g.connect(master);}
  const gain=c.createGain();gain.gain.setValueAtTime(0,0).linearRampToValueAtTime(.5,.032);gain.connect(master);
  expect([...f.pull(256)].every(v=>v===0)).toBe(true);
  const o=c.createOscillator();o.frequency.value=500;o.connect(gain);o.start();
  expect(f.pull()[8]).toBeCloseTo(Math.round(32767*.5),0);
  o.disconnect();expect([...f.pull()].every(v=>v===0)).toBe(true);
  o.connect(gain);expect(f.pull().some(v=>v!==0)).toBe(true);
 }finally{f.dispose();}
});


test('live audio catches up after repeated long paint tasks instead of slowing its clock',async()=>{
 const f=setup(true),c=f.context,o=c.createOscillator();let painting;
 try {
  o.connect(c.destination);o.start();
  f.outputs[0].listener({event:'request',bytes:8000*2*4});
  const started=performance.now();
  painting=setInterval(()=>{const end=performance.now()+65;while(performance.now()<end){}},16);
  await Bun.sleep(700);
  clearInterval(painting);
  const elapsed=(performance.now()-started)/1000;
  expect(c.currentTime).toBeGreaterThan(elapsed*.7);
  expect(c.currentTime).toBeLessThan(elapsed+.10);
 }finally{clearInterval(painting);f.dispose();}
});

test('unreferenced finished filter graphs are collected after their real tails decay',async()=>{
 const f=setup(),c=f.context;
 let weakFilter,weakGain;
 (()=>{
  const source=c.createBufferSource(),filter=c.createBiquadFilter(),gain=c.createGain();
  weakFilter=new WeakRef(filter);weakGain=new WeakRef(gain);
  filter.type='lowpass';filter.frequency.value=100;filter.Q.value=10;
  const buffer=c.createBuffer(1,1,c.sampleRate);buffer.getChannelData(0)[0]=1;source.buffer=buffer;
  source.connect(filter).connect(gain).connect(c.destination);source.start();
 })();
 try{
  f.pull(128);await Bun.sleep(5);Bun.gc(true);await Bun.sleep(0);
  expect(weakFilter.deref()!==undefined).toBe(true); // tail owns its path after source ends
  expect(f.pull(128).some(v=>v!==0)).toBe(true);
  f.pull(8000); // let the IIR decay below float32's normal range
  for(let i=0;i<4;i++){await Bun.sleep(5);expect(f.pull().every(v=>v===0)).toBe(true);Bun.gc(true);}
  expect(weakFilter.deref()===undefined).toBe(true);
  expect(weakGain.deref()===undefined).toBe(true);
  expect(f.pull().every(v=>v===0)).toBe(true);
 }finally{f.dispose();}
});

test('an author-held silent filter remains reconnectable after collection of other graphs',async()=>{
 const f=setup(),c=f.context,filter=c.createBiquadFilter();
 filter.type='lowpass';filter.frequency.value=500;filter.connect(c.destination);
 try{
  f.pull(256);await Bun.sleep(5);Bun.gc(true);
  const source=c.createOscillator();source.frequency.value=200;source.connect(filter);source.start();
  expect(f.pull(256).some(v=>v!==0)).toBe(true);
  source.stop();f.pull(8000);expect(f.pull().every(v=>v===0)).toBe(true);
  const next=c.createOscillator();next.frequency.value=200;next.connect(filter);next.start();
  expect(f.pull(256).some(v=>v!==0)).toBe(true);
 }finally{f.dispose();}
});

test('future scheduled voices retain intermediate processing nodes until playback',async()=>{
 const f=setup(),c=f.context;let weak;
 (()=>{const source=c.createOscillator(),filter=c.createBiquadFilter(),gain=c.createGain();
  source.frequency.value=500;filter.frequency.value=1000;gain.gain.value=.25;
  weak=new WeakRef(filter);source.connect(filter).connect(gain).connect(c.destination);source.start(.1);source.stop(.2);
 })();
 try{
  for(let i=0;i<3;i++){await Bun.sleep(5);Bun.gc(true)}
  expect(weak.deref()!==undefined).toBe(true);
  const samples=f.pull(2048);
  expect(samples.slice(0,800*2).every(v=>v===0)).toBe(true);
  expect(samples.slice(800*2).some(v=>v!==0)).toBe(true);
 }finally{f.dispose();}
});

test('AudioParam modulation keeps its running input alive through weak input connections',async()=>{
 const f=setup(),c=f.context,signal=c.createOscillator(),gain=c.createGain();
 gain.gain.value=0;signal.frequency.value=500;signal.connect(gain).connect(c.destination);signal.start();
 let mod;
 (()=>{const oscillator=c.createOscillator();oscillator.type='square';oscillator.frequency.value=0;oscillator.connect(gain.gain);oscillator.start();mod=new WeakRef(oscillator)})();
 try{
  await Bun.sleep(5);Bun.gc(true);
  expect(f.pull()[8]).toBeCloseTo(32767,0);
  mod.deref().stop();expect(f.pull().every(v=>v===0)).toBe(true);
 }finally{f.dispose();}
});
