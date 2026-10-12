import { expect, test } from 'bun:test';
import { playbackEvent } from '../lib/renderer/media-playback-events.js';

test('playback notifications distinguish unpaused, advancing and starved states', () => {
  const state = {playing:true}, events=[];
  const dispatch=(_state,type)=>events.push(type);
  for(const phase of ['play','playing','playing','waiting','waiting','playing','playing','pause','play','playing']) {
    playbackEvent(state,phase,dispatch);
  }
  expect(events).toEqual(['play','playing','waiting','canplay','playing','pause','play','playing']);
});

test('pausing in canplay does not report playback resumed', () => {
  const state={playing:true}, events=[];
  const dispatch=(_state,type)=>{
    events.push(type);
    if(type==='canplay') {state.playing=false;playbackEvent(state,'pause',dispatch);}
  };
  playbackEvent(state,'waiting',dispatch);
  playbackEvent(state,'playing',dispatch);
  expect(events).toEqual(['waiting','canplay','pause']);
});
