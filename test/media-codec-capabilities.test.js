import {test,expect} from 'bun:test';
import {mimeSupported,createMediaSourceScope,containerFormat} from '../lib/renderer/media-source.js';
import {createBrowser} from '../lib/headless-shell.js';
import {mediaFileTypeSupported,softwareCodec} from '../lib/media/codec-support.js';
import wasmpeg from '../vendor/wasmpeg/src/js/index.js';

const unavailable=[
 'video/mp4; codecs="av01.0.04M.08"',
 'video/webm; codecs="av01.0.04M.08"',
 'video/mp4; codecs="av01.0.04M.08, mp4a.40.2"',
 'video/mp4; codecs="AV01.0.04M.08"',
];
const available=[
 'video/mp4; codecs="avc1.4d401e"',
 'video/mp4; codecs="avc3.4d401e"',
 'video/mp4; codecs="vp09.00.41.08"',
 'video/mp4; codecs="hvc1.1.6.L93.B0"',
 'video/mp4; codecs="hev1.1.6.L93.B0"',
 'video/mp4; codecs="mp4v.20.9"',
 'audio/mp4; codecs="ac-3"',
 'audio/mp4; codecs="ec-3"',
 'audio/mp4; codecs="alac"',
 'audio/mp4; codecs="flac"',
 'audio/mp4; codecs="dtsc"',
 'audio/wav; codecs="1"',
 'video/webm; codecs="vp9"',
 'audio/webm; codecs="opus"',
 'audio/mp4; codecs="mp4a.40.2"',
];
test('MSE rejects hardware-only AV1 while retaining software-decodable codecs',()=>{
 const tasks=[],scope=createMediaSourceScope({origin:'https://media.test',schedule:fn=>tasks.push(fn),DOMException});
 const source=new scope.MediaSource();source.attach('blob:https://media.test/stream');while(tasks.length)tasks.shift()();
 for(const type of unavailable){
  expect(mimeSupported(type)).toBe(false);
  expect(scope.MediaSource.isTypeSupported(type)).toBe(false);
  expect(()=>source.addSourceBuffer(type)).toThrow('not supported');
 }
 for(const type of available)expect(scope.MediaSource.isTypeSupported(type)).toBe(true);
});

test('HTMLMediaElement and MSE agree on unavailable codecs in the real page realm',async()=>{
 const browser=await createBrowser({spareRenderer:false});
 try{
  await browser.context.navigate('data:text/html,<video id="v"></video>');
  const result=await browser.context.evaluate(`(()=>{const v=document.getElementById('v');return {
    unavailable:${JSON.stringify(unavailable)}.map(type=>[v.canPlayType(type),MediaSource.isTypeSupported(type)]),
    available:${JSON.stringify(available)}.map(type=>v.canPlayType(type)),
    containers:['video/mp4','video/webm','video/mpeg','audio/mp3','audio/wav'].map(type=>v.canPlayType(type)),
    unknown:v.canPlayType('video/mp4; codecs="unavailable-codec"')
  }})()`);
  expect(result.unavailable).toEqual(unavailable.map(()=>['',false]));
  expect(result.available).toEqual(available.map(()=>'maybe'));
  expect(result.containers).toEqual(Array(5).fill('maybe'));
  expect(result.unknown).toBe('');
 }finally{browser.close();}
},15000);


test('file capability keeps the broad wasmpeg CPU decoder families available without overclaiming MSE containers',()=>{
 for(const type of [
  'video/quicktime; codecs="apch"','video/quicktime; codecs="png"',
  'video/x-matroska; codecs="ffv1, pcm_s16le"','video/x-msvideo; codecs="huffyuv"',
  'video/x-ms-wmv; codecs="wmv3, wmav2"','video/x-flv; codecs="vp6f, mp3"',
  'video/vnd.rn-realvideo; codecs="rv40, cook"','video/ogg; codecs="theora, vorbis"',
  'video/mpeg; codecs="mpeg2video, mp2"','video/dv; codecs="dvvideo"',
  'audio/x-ape; codecs="ape"','audio/x-wavpack; codecs="wavpack"',
  'audio/x-shorten; codecs="shorten"','audio/x-musepack; codecs="mpc8"',
  'audio/amr; codecs="samr"','audio/amr-wb; codecs="sawb"',
  'audio/dts; codecs="dca"','audio/true-hd; codecs="truehd"',
  'audio/x-ms-wma; codecs="wmapro"','audio/ogg; codecs="speex"',
 ])expect(mediaFileTypeSupported(type)).toBe(true);
 expect(mimeSupported('video/x-matroska; codecs="ffv1"')).toBe(false);
 for(const type of ['video/webm; codecs="h264"','audio/wav; codecs="h264"',
  'audio/mp4; codecs="avc1.4d401e"','video/mp4; codecs="av01.0.04M.08"',
  'video/mp4; codecs=""','video/mp4; codecs="not-a-codec"',
  'image/png','video/not-a-container'])expect(mediaFileTypeSupported(type)).toBe(false);
 for(const [token,decoder] of [['hvc1.1.6.L93.B0','hevc'],['mp4a.69','mp3'],['mp4a.40.2','aac'],['ap4h','prores'],['dtsc','dca']])expect(softwareCodec(token)).toBe(decoder);
 expect(softwareCodec('av01.0.04M.08')).toBe(null);
});

test('newly advertised HEVC, Theora, ALAC and AAC decode using the shipped WASM',async()=>{
 await wasmpeg.load();
 for(const name of ['software-hevc.mp4','software-theora.ogv']){
  const bytes=await Bun.file(new URL('./fixtures/'+name,import.meta.url)).bytes();
  const decoder=await wasmpeg.decode(bytes);
  try{expect(decoder.nextFrame(32,24)?.length).toBe(32*24*4);}finally{decoder.close();}
 }
 for(const name of ['software-alac.m4a','software-aac.aac']){
  const bytes=await Bun.file(new URL('./fixtures/'+name,import.meta.url)).bytes();
  const format=name.endsWith('.aac')?containerFormat('audio/aac'):undefined;
  const decoder=await wasmpeg.decodeAudio(bytes,{format});
  try{expect(decoder.nextSamples()?.length).toBeGreaterThan(0);}finally{decoder.close();}
 }
 const bytes=await Bun.file(new URL('./fixtures/software-av1.mp4',import.meta.url)).bytes();
 const decoder=await wasmpeg.decode(bytes);
 try{expect(()=>decoder.nextFrame(32,24)).toThrow();}finally{decoder.close();}
},10000);
