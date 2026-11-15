import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseArguments,treeFingerprint,fileFingerprint,environmentFingerprint,sameFingerprint,
  stopCasty,createPlaybackProgress,resetPlaybackProgress,observePlayback,playbackPass} from './manual-youtube-stability-support.js';

test('manual playback options keep browser controls separate from the Casty checkout', () => {
  const options = parseArguments(['--browser-root','/control','--out','/results','--file','--network-label','mobile'],'/harness');
  expect(options).toMatchObject({browserRoot:'/control',castyRoot:'/casty',out:'/results',file:true,networkLabel:'mobile'});
  expect(parseArguments([],'/harness').networkLabel).toBe('unspecified');
  expect(() => parseArguments(['--out'],'/harness')).toThrow('Missing value');
  expect(() => parseArguments(['/one','--out','/two'],'/harness')).toThrow('Duplicate');
  expect(() => parseArguments(['--browser-root','/one','--browser-root','/two'],'/harness')).toThrow('Duplicate');
  expect(() => parseArguments(['--network-label','mobile','--network-label','wifi'],'/harness')).toThrow('Duplicate');
  expect(() => parseArguments(['--seek','60'],'/harness')).toThrow('Unknown');
});

test('cohort environment digest observes effective settings without printing secrets or per-round wrapper paths', () => {
  const environment = {PATH:'/runtime',HTTPS_PROXY:'https://user:secret@example.invalid',BUNINU_RENDER_MIN_INTERVAL:'16',CASTY_BROWSER:'/round-1/browser.mjs'};
  const first = environmentFingerprint(environment);
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(first).not.toContain('secret');
  expect(environmentFingerprint({...environment,CASTY_BROWSER:'/round-2/browser.mjs'})).toBe(first);
  expect(environmentFingerprint({...environment,BUNINU_RENDER_MIN_INTERVAL:'33'})).not.toBe(first);
  expect(environmentFingerprint({...environment,PATH:'/other-runtime'})).not.toBe(first);
  expect(environmentFingerprint(Object.fromEntries(Object.entries(environment).reverse()))).toBe(first);
});

test('runtime fingerprints detect CSS, font, dependency and file-set changes; test peer is hashed separately', async () => {
  const root = mkdtempSync(join(tmpdir(),'youtube-manifest-'));
  try {
    for (const dir of ['lib','usr/share/fonts','node_modules/dependency','test','.git']) mkdirSync(join(root,dir),{recursive:true});
    writeFileSync(join(root,'lib/style.css'),'body{color:red}');
    writeFileSync(join(root,'usr/share/fonts/font.ttf'),new Uint8Array([0,1,2]));
    writeFileSync(join(root,'node_modules/dependency/index.js'),'export const value=1;');
    writeFileSync(join(root,'test/peer.js'),'peer1');
    const baseline = await treeFingerprint(root), peer = await fileFingerprint(join(root,'test/peer.js'));
    writeFileSync(join(root,'.git/HEAD'),'another commit');
    writeFileSync(join(root,'test/peer.js'),'peer2');
    expect(sameFingerprint(baseline,await treeFingerprint(root))).toBe(true);
    expect(sameFingerprint(peer,await fileFingerprint(join(root,'test/peer.js')))).toBe(false);
    for (const [name,value] of [['lib/style.css','body{color:blue}'],['usr/share/fonts/font.ttf','new font'],['node_modules/dependency/index.js','export const value=2;'],['lib/new.png','image bytes']]) {
      const before = await treeFingerprint(root);
      writeFileSync(join(root,name),value);
      expect(sameFingerprint(before,await treeFingerprint(root))).toBe(false);
    }
    expect(await fileFingerprint(join(root,'missing-config.json'))).toEqual({missing:true});
  } finally {rmSync(root,{recursive:true,force:true});}
});

const targetId='target-video';
function videoState(time,decoded,overrides={}) {
  return {videoId:targetId,watchId:targetId,ad:false,adState:-1,stats:{},
    video:{time,decoded,paused:false,ended:false,seeking:false,error:null,rate:1,readyState:4,width:640,height:360},...overrides};
}
function observe(progress,state,ms) {
  return observePlayback(progress,state,{targetId,ms,frames:ms/100,distinctFrames:ms/200});
}

test('playback credit requires player identity and excludes the verified active ad state', () => {
  for (const overrides of [{videoId:null},{videoId:'another-video'},{stats:{video_id:'another-video'}},{ad:true},{adState:1}]) {
    const progress=createPlaybackProgress();
    expect(observe(progress,videoState(1,30,overrides),0).main).toBe(false);
    expect(observe(progress,videoState(4,120,overrides),3000).playing).toBe(false);
    expect(progress.mainObservedSeconds).toBe(0);
  }
  // -1 is the actual no-ad-module fallback, not a truthy advertisement flag.
  expect(observe(createPlaybackProgress(),videoState(1,30),0).main).toBe(true);
});

test('ordinary playback earns credit but discontinuities discard prior time and frame baselines', () => {
  const changes=[
    state => {state.video.time=0;},
    state => {state.video.time=90;},
    state => {state.video.decoded=0;},
    state => {state.video.seeking=true;},
    state => {state.ad=true;},
    state => {state.videoId='another-video';},
  ];
  for (const change of changes) {
    const progress=createPlaybackProgress();
    observe(progress,videoState(0,0),0);
    expect(observe(progress,videoState(3,90),3000).recentDecodedAdvance).toBe(true);
    expect(progress.mainObservedSeconds).toBe(3);
    const state=videoState(6,180);change(state);
    const sample=observe(progress,state,6000);
    expect(sample.resetReason).not.toBeNull();
    expect(sample.recentDecodedAdvance).toBe(false);
    expect(progress.mainObservedSeconds).toBe(0);
    expect(progress.mainStartFrames).toBe(sample.playing?60:0);
    expect(progress.mainStartDistinct).toBe(sample.playing?30:0);
    expect(progress.firstDecoded).toBe(sample.playing?state.video.decoded:null);
  }
  const progress=createPlaybackProgress();
  for (let second=0;second<=66;second+=3) observe(progress,videoState(second,second*30),second*1000);
  expect(progress.mainObservedSeconds).toBe(66);
  expect(progress.firstDecoded).toBe(0);
});

test('ordinary stalls and uncertain samples preserve earned credit without crediting those intervals', () => {
  for (const change of [state=>{state.video.readyState=1;},state=>{state.video.paused=true;},state=>{state.videoId=null;}]) {
    const progress=createPlaybackProgress();
    observe(progress,videoState(0,0),0);
    observe(progress,videoState(3,90),3000);
    const state=videoState(6,180);change(state);
    expect(observe(progress,state,6000).resetReason).toBeNull();
    expect(progress.mainObservedSeconds).toBe(3);
    expect(progress.firstDecoded).toBe(0);
    observe(progress,videoState(9,270),9000);
    expect(progress.mainObservedSeconds).toBe(3);
    observe(progress,videoState(12,360),12000);
    expect(progress.mainObservedSeconds).toBe(6);
  }
  const progress=createPlaybackProgress();
  observe(progress,videoState(0,0),0);
  observe(progress,videoState(3,90),3000);
  expect(observe(progress,videoState(3,90),6000).resetReason).toBeNull();
  expect(progress.mainObservedSeconds).toBe(3);
  observe(progress,videoState(6,180),9000);
  expect(progress.mainObservedSeconds).toBe(6);
  observe(progress,videoState(0,0,{videoId:null,video:null}),12000);
  expect(progress.mainObservedSeconds).toBe(6);
  expect(observe(progress,videoState(0,0),15000).resetReason).toBe('time-discontinuity');
  expect(progress.mainObservedSeconds).toBe(0);
});

test('observation failures break continuity, and main-video media/rejection errors remain sticky', () => {
  const progress=createPlaybackProgress();
  observe(progress,videoState(0,0),0);
  observe(progress,videoState(3,90),3000);
  resetPlaybackProgress(progress);
  observe(progress,videoState(30,900),30000);
  expect(progress.mainObservedSeconds).toBe(0);
  expect(progress.firstDecoded).toBe(900);
  for (const state of [videoState(3,90,{video:{error:{code:3,message:'decode failed'}}}),
    videoState(3,90,{stats:{debug_error:'ump.spsrejectfailure'}}),
    videoState(3,90,{videoId:null,video:{error:{code:3,message:'identity cleared on error'}}})]) {
    const failed=createPlaybackProgress();
    observe(failed,videoState(0,0),0);
    observe(failed,state,3000);
    const error=failed.error;
    expect(typeof error).toBe('string');
    resetPlaybackProgress(failed);
    observe(failed,videoState(6,180),6000);
    expect(failed.error).toBe(error);
  }
  for (const overrides of [{ad:true},{videoId:'another-video'}]) {
    const progress=createPlaybackProgress();
    observe(progress,videoState(0,0),0);
    observe(progress,videoState(3,90,{...overrides,video:{error:{code:3}}}),3000);
    expect(progress.error).toBeNull();
  }
});

test('cleanup requires both an observed child exit and disappearance of its process group', async () => {
  const pending=new Promise(() => {});
  for (const [exited,groupExists] of [[pending,false],[Promise.resolve(0),true]]) {
    let closed=false;
    const proc={pid:123,exited,kill(){},terminal:{write(){},close(){closed=true;}}};
    await expect(stopCasty(proc,{ownsGroup:()=>false,groupExists:()=>groupExists,killGroup(){throw Error('Unowned group');},sleep:async()=>{}}))
      .rejects.toThrow('could not verify');
    expect(closed).toBe(true);
  }
  let resolveExit,alive=true;
  const signals=[];
  const proc={pid:123,exited:new Promise(resolve=>{resolveExit=resolve;}),kill(){},terminal:{write(){},close(){}}};
  expect(await stopCasty(proc,{ownsGroup:()=>alive,groupExists:()=>alive,sleep:async()=>{},
    killGroup(pid,signal){signals.push([pid,signal]);if(signal==='SIGKILL'){alive=false;resolveExit(0);}}})).toBe(true);
  expect(signals).toEqual([[123,'SIGTERM'],[123,'SIGKILL']]);
  await expect(stopCasty({...proc,exited:Promise.resolve(0)},{ownsGroup:()=>false,
    groupExists(){throw Error('Cannot inspect group');},sleep:async()=>{}})).rejects.toThrow('Cannot inspect group');
});

test('a provisional playback threshold cannot bypass aborts, verification errors, or missing cleanup', () => {
  const good={playbackThresholdReached:true,inputsUnchanged:true,wrapperUnchanged:true,cleanupVerified:true};
  expect(playbackPass(good,false)).toBe(true);
  expect(playbackPass(good,true)).toBe(false);
  expect(playbackPass({},false)).toBe(false);
  for (const key of Object.keys(good)) {
    expect(playbackPass({...good,[key]:false},false)).toBe(false);
    expect(playbackPass({...good,[key]:undefined},false)).toBe(false);
  }
  for (const key of ['error','playerError','cleanupError','verificationError']) {
    expect(playbackPass({...good,[key]:'failure'},false)).toBe(false);
  }
});

test('generated wrappers have independent per-run fingerprints and detect later modification', async () => {
  const root=mkdtempSync(join(tmpdir(),'youtube-wrapper-'));
  try {
    const wrapper=join(root,'browser.mjs');
    writeFileSync(wrapper,'const output="/round-one";');
    const before=await fileFingerprint(wrapper);
    expect(sameFingerprint(before,await fileFingerprint(wrapper))).toBe(true);
    writeFileSync(wrapper,'const output="/round-two";');
    expect(sameFingerprint(before,await fileFingerprint(wrapper))).toBe(false);
  } finally {rmSync(root,{recursive:true,force:true});}
});
