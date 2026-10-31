import {test,expect} from 'bun:test';
import {createWebAudioScope} from '../lib/audio/web-audio.js';

function setup() {
  const outputs=[],closed=[],errors=[];
  const scope=createWebAudioScope({
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
