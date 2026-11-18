import {expect, test} from 'bun:test';
import {parseWebVTT} from '../lib/media/webvtt.js';

test('loads identified and anonymous WebVTT cues and skips comments', () => {
  const text = '\uFEFFWEBVTT captions\r\n\r\nNOTE ignored\r\n00:00.000 --> 00:01.000\r\n\r\nopening\r\n00:01.250 --> 01:01:01.500 align:start\r\n第一行\r\n第二行\r\n\r\n00:02.000 --> 00:03.000\r\nnext';
  expect(parseWebVTT(text)).toEqual([
    {id:'opening',startTime:1.25,endTime:3661.5,settings:'align:start',text:'第一行\n第二行'},
    {id:'',startTime:2,endTime:3,settings:'',text:'next'},
  ]);
});

test('rejects an invalid signature and recovers after a malformed timestamp', () => {
  expect(parseWebVTT('not a WEBVTT file')).toBeNull();
  expect(parseWebVTT('WEBVTT\n\n00:65.000 --> 00:66.000\nbad\n\n00:00.000 --> 00:01.000\nvalid')).toEqual([
    {id:'',startTime:0,endTime:1,settings:'',text:'valid'},
  ]);
});

import {RendererHost} from '../lib/renderer/host.js';

test('page scripts can construct and edit cues and request independent cue fragments', async () => {
  const host = new RendererHost({timeout:20000});
  try {
    await host.start();
    await host.call('loadDocument',{url:'https://video.test/',contentType:'text/html',status:200,source:'<!doctype html>'});
    await host.call('whenLoaded');
    expect(await host.call('evaluate',`(() => {
      const cue=new VTTCue(1,2,'<v Ada><b>Hello &amp; welcome</b></v>');
      cue.endTime=4; cue.size=50;
      const fragment=cue.getCueAsHTML();
      return [cue instanceof TextTrackCue, cue.endTime, cue.size, fragment.firstChild.title,
        fragment.firstChild.firstChild.tagName, fragment.textContent, cue.getCueAsHTML()!==fragment];
    })()`)).toEqual([true,4,50,'Ada','B','Hello & welcome',true]);
  } finally {await host.close();}
});

test('media track lists reflect DOM order, cue ownership, timing and mode', async () => {
  const host = new RendererHost({timeout:20000});
  try {
    await host.start();
    await host.call('loadDocument',{url:'https://video.test/',contentType:'text/html',status:200,source:'<video><track id="cc" label="中文"></video>'});
    await host.call('whenLoaded');
    expect(await host.call('evaluate',`(() => {
      const video=document.querySelector('video'), list=video.textTracks, cc=list.getTrackById('cc');
      const t=video.addTextTrack('captions','English','en'), cues=t.cues, active=t.activeCues;
      const cue=new VTTCue(0,2,'hello'); cue.id='a'; t.addCue(cue);
      const result=[list instanceof TextTrackList,list.length,list[0]===cc,list[1]===t,cc.label,
        cc.cues===null,cues.getCueById('a')===cue,active[0]===cue];
      cc.addCue(cue); cc.mode='showing';
      document.getElementById('cc').remove();
      return [...result,cues.length,list.length,cc.cues[0]===cue,cue.track===cc];
    })()`)).toEqual([true,2,true,true,'中文',true,true,true,0,1,true,true]);
  } finally {await host.close();}
});

test('enabled track loads a WebVTT resource and replaces cues after changing src', async () => {
  const host = new RendererHost({timeout:20000});
  try {
    await host.start();
    await host.call('loadDocument',{url:'https://video.test/',contentType:'text/html',status:200,source:'<video><track></video>'});
    await host.call('whenLoaded');
    await host.call('evaluate',`(() => {
      const el=document.querySelector('track'), t=el.track;
      window.events=[];
      el.addEventListener('load',()=>events.push([el.readyState,t.cues.length,t.cues[0].text]));
      el.src='data:text/vtt,'+encodeURIComponent('WEBVTT\\n\\n00:00.000 --> 00:01.000\\nfirst');
      t.mode='hidden';
    })()`);
    async function events(count) {
      for (let i=0;i<50;i++) {
        const result=await host.call('evaluate','window.events.slice()');
        if(result.length>=count)return result;
        await Bun.sleep(10);
      }
    }
    expect(await events(1)).toEqual([[2,1,'first']]);
    await host.call('evaluate',`document.querySelector('track').src='data:text/vtt,'+encodeURIComponent('WEBVTT\\n\\n00:01.000 --> 00:02.000\\nsecond')`);
    expect(await events(2)).toEqual([[2,1,'first'],[2,1,'second']]);
  } finally {await host.close();}
});

test('default markup starts loading without script accessing a track', async () => {
  const host = new RendererHost({timeout:20000});
  try {
    await host.start();
    const source = '<video><track default src="data:text/vtt,WEBVTT%0A%0A00:00.000%20--%3E%2000:02.000%0AHello"></video>';
    await host.call('loadDocument',{url:'https://video.test/',contentType:'text/html',status:200,source});
    await host.call('whenLoaded');
    await Bun.sleep(30);
    expect(await host.call('evaluate',`(() => {
      const el=document.querySelector('track');
      return [el.readyState,el.track.mode,el.track.activeCues[0]?.text];
    })()`)).toEqual([2,'showing','Hello']);
  } finally {await host.close();}
});

test('changing cue membership dispatches enter, exit and cuechange', async () => {
  const host = new RendererHost({timeout:20000});
  try {
    await host.start();
    await host.call('loadDocument',{url:'https://video.test/',contentType:'text/html',status:200,source:'<video></video>'});
    await host.call('whenLoaded');
    await host.call('evaluate',`(() => {
      window.log=[]; window.t=document.querySelector('video').addTextTrack('metadata');
      window.c=new VTTCue(0,2,'entry');
      c.addEventListener('enter',()=>log.push('enter'));
      c.addEventListener('exit',()=>log.push('exit'));
      t.addEventListener('cuechange',()=>log.push('changed'));
      t.addCue(c);
    })()`);
    expect(await host.call('evaluate','log.slice()')).toEqual(['enter','changed']);
    await host.call('evaluate','t.removeCue(c)');
    expect(await host.call('evaluate','log.slice()')).toEqual(['enter','changed','exit','changed']);
  } finally {await host.close();}
});

test('showing captions paint into the video; hidden cues remain accessible', async () => {
  const host=new RendererHost({timeout:20000});
  try {
    await host.start();
    await host.call('loadDocument',{url:'https://video.test/',contentType:'text/html',status:200,
      source:'<video width="320" height="180"></video>'});
    await host.call('whenLoaded');
    const original=await host.call('screenshot');
    await host.call('evaluate',`window.t=document.querySelector('video').addTextTrack('captions');t.addCue(new VTTCue(0,10,'字幕 Hello'));t.mode='showing'`);
    const centered=await host.call('screenshot');
    expect(centered).not.toBe(original);
    await host.call('evaluate',"window.c=t.cues[0];c.position=25;c.size=40;c.snapToLines=false;c.line=10;c.align='left'");
    expect(await host.call('screenshot')).not.toBe(centered);
    await host.call('evaluate',"c.position='auto';c.size=100;c.line='auto';c.align='center'");
    expect(await host.call('screenshot')).toBe(centered);
    await host.call('evaluate',"t.mode='hidden'");
    expect(await host.call('screenshot')).toBe(original);
    expect(await host.call('evaluate','t.activeCues[0].text')).toBe('字幕 Hello');
  } finally {await host.close();}
});

test('indexed textTracks delivers add, mode change and removal events',async()=>{
  const host=new RendererHost({timeout:20000});
  try {
    await host.start();
    await host.call('loadDocument',{url:'https://video.test/',contentType:'text/html',status:200,source:'<video></video>'});
    await host.call('whenLoaded');
    await host.call('evaluate',`window.v=document.querySelector('video');window.list=v.textTracks;window.log=[];
      list.onaddtrack=e=>log.push(e.track.label);
      list.addEventListener('removetrack',e=>log.push('removed '+e.track.label));
      list.onchange=()=>log.push('changed');
      v.addTextTrack('metadata','script').mode='showing';
      window.el=document.createElement('track');el.label='element';v.appendChild(el);el.remove()`);
    for(let n=0;n<50 && await host.call('evaluate','log.length')<4;n++)await Bun.sleep(10);
    expect(await host.call('evaluate','log.slice().sort()')).toEqual(['changed','element','removed element','script']);
  } finally {await host.close();}
});
