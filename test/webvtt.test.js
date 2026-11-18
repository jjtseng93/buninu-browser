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
