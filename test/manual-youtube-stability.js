// Run in native Termux, one fresh playback at a time. Do not edit runtime files
// during a round. Synthetic Kitty PNG transport excludes final WebView cost.
// bun test/manual-youtube-stability.js [empty-output-directory] [--file]
//   [--browser-root PATH] [--casty-root PATH] [--out PATH] [--network-label LABEL]
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync, appendFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {KittyPeer, isCastyContentFrame} from './manual-casty-home-startup.js';
import {parseArguments,fileFingerprint,inputFingerprint,sameFingerprint} from './manual-youtube-stability-support.js';

const harnessRoot = resolve(import.meta.dir,'..');
const options = parseArguments(Bun.argv.slice(2),harnessRoot);
if (options.help) {
  console.log('Usage: bun test/manual-youtube-stability.js [empty-output-directory] [--file] [--browser-root PATH] [--casty-root PATH] [--out PATH] [--network-label LABEL]\n\nOne fresh natural playback through actual Casty, with a synthetic 1280x800 Kitty PNG peer. Requires currentTime >65 seconds, >=65 seconds observed normal progression, recent decoding and changing frames. No pause, seek or quality override. Inspect success-kitty.png to confirm the main video is visibly changing. Compare complete manifest.json files across a ten-round cohort. Config/environment values are fingerprinted, never printed. The network label is user-reported metadata; it does not inspect or change the network. This does not measure Android WebView presentation. Run only one round at a time in native Termux.');
  process.exit(0);
}
const root = options.browserRoot;
const targetId = 'jf-pn0a-Twk', targetUrl = `https://youtu.be/${targetId}`;
const limitMs = 180000, cadenceMs = 2500;
const out = resolve(options.out || mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'youtube-stability-')));
// Output must stay outside runtime trees, or it would invalidate its own hash.
for (const tree of [root,options.castyRoot]) {
  if (out === tree || out.startsWith(tree+'/')) throw Error('Output directory must be outside the browser and Casty roots');
}
mkdirSync(out, {recursive:true});
if (readdirSync(out).length) throw Error('Output directory must be empty: ' + out);
const childEnvironment = {...process.env,CASTY_BROWSER:join(out,'browser.mjs'),BUNINU_LOG:'',TERM:'xterm-256color',TMUX:''};
const fingerprintOptions = {browserRoot:root,castyRoot:options.castyRoot,harnessRoot,environment:childEnvironment};
// Use Casty's actual script-runtime resolver (Bun.which('bun'), then its PATH
// fallback), and hash before launch so startup/renderer timing is undisturbed.
const {launchCommand} = await import(Bun.pathToFileURL(join(options.castyRoot,'lib/chrome.js')).href);
const originalCwd = process.cwd();
let anticipatedRuntimePath;
try {
  // Relative PATH entries must resolve from the same cwd as the Casty child.
  process.chdir(root);
  anticipatedRuntimePath = realpathSync(launchCommand(childEnvironment.CASTY_BROWSER).command);
} finally {process.chdir(originalCwd);}
const anticipatedBrowserRuntime = {execPath:anticipatedRuntimePath,binary:await fileFingerprint(anticipatedRuntimePath)};
const manifest = {schema:1,inputs:await inputFingerprint(fingerprintOptions),
  harnessRuntime:{bun:Bun.version,revision:Bun.revision,platform:process.platform,arch:process.arch,execPath:process.execPath},
  browserRoot:root,castyRoot:options.castyRoot,cols:160,rows:40,directPlayback:true,logging:false,
  transport:options.file?'png-file-supported':'png-inline',networkLabel:options.networkLabel,
  limitMs,cadenceMs,anticipatedBrowserRuntime,browserRuntime:null};
writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2));
const endpointFile = join(out, 'endpoint');
const runtimeFile = join(out, 'browser-runtime.json');
writeFileSync(join(out, 'browser.mjs'), `
import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(runtimeFile)},JSON.stringify({bun:Bun.version,revision:Bun.revision,
  platform:process.platform,arch:process.arch,execPath:process.execPath}));
const originalError = console.error;
console.error = (...args) => {
  const text = args.join(' '), prefix = 'DevTools listening on ';
  if (text.startsWith(prefix)) writeFileSync(${JSON.stringify(endpointFile)}, text.slice(prefix.length).trim());
  originalError(...args);
};
const {main} = await import(${JSON.stringify(Bun.pathToFileURL(join(root, 'buninu-browser.js')).href)});
await main();
`);

function connectCdp(url, signal) {
  return new Promise((resolveReady, rejectReady) => {
    const socket = new WebSocket(url), pending = new Map();
    let id = 0, closed = false;
    const connectTimer = setTimeout(() => close(Error('CDP connect timeout')), 15000);
    function close(reason = Error('CDP closed')) {
      if (closed) return;
      closed = true;clearTimeout(connectTimer);
      signal.removeEventListener('abort', aborted);
      rejectReady(reason);
      for (const request of pending.values()) {clearTimeout(request.timer);request.reject(reason);}
      pending.clear();socket.close();
    }
    const aborted = () => close(signal.reason);
    signal.addEventListener('abort', aborted, {once:true});
    socket.onopen = () => {
      clearTimeout(connectTimer);
      resolveReady({close, call(method, params = {}) {
        return new Promise((resolve, reject) => {
          if (closed || socket.readyState !== WebSocket.OPEN) return reject(Error('CDP not connected'));
          const requestId = ++id;
          const timer = setTimeout(() => {pending.delete(requestId);reject(Error(method + ' observation timeout'));}, 15000);
          pending.set(requestId, {resolve, reject, timer});
          try {socket.send(JSON.stringify({id:requestId, method, params}));}
          catch (error) {clearTimeout(timer);pending.delete(requestId);reject(error);}
        });
      }});
    };
    socket.onmessage = event => {
      let message;
      try {message = JSON.parse(event.data);} catch (error) {close(error);return;}
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);clearTimeout(request.timer);
      if (message.error) request.reject(Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    };
    socket.onerror = () => close(Error('CDP socket error'));
    socket.onclose = () => close();
    if (signal.aborted) aborted();
  });
}

// A Bun.Terminal child has its own process group and session. Never signal
// a group unless /proc still proves both are the PID created by this script.
function hasOwnedProcessGroup(pid) {
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[2]) === pid && Number(fields[3]) === pid) return true;
      } catch {}
    }
  } catch {}
  return false;
}
async function stopCasty(proc) {
  if (!proc) return;
  try {proc.terminal?.write('\x11');} catch {}
  await Promise.race([proc.exited, Bun.sleep(2000)]);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (hasOwnedProcessGroup(proc.pid)) {
      try {process.kill(-proc.pid, signal);} catch (error) {if (error.code !== 'ESRCH') throw error;}
    }
    if (proc.exitCode === null) {
      try {proc.kill(signal);} catch (error) {if (error.code !== 'ESRCH') throw error;}
    }
    if (signal === 'SIGTERM') await Bun.sleep(300);
  }
  await Promise.race([proc.exited, Bun.sleep(1000)]);
  try {proc.terminal?.close();} catch {}
}

// Observe only after Casty's explicit Page.navigate has committed. Never
// install startup scripts, seek the video, spoof the UA, or modify BotGuard.
const observation = `(() => {
  const player = document.getElementById('movie_player');
  const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
  const read = operation => {try {return operation();} catch {return null;}};
  const data = read(() => player?.getVideoData?.());
  const response = read(() => player?.getPlayerResponse?.());
  const rawStats = read(() => player?.getVideoStats?.()) || {};
  const stats = {};
  for (const key of ['cmt','fmt','afmt','vfs','vps','df','fps','vfps','vres','debug_error','video_id','preroll','state']) {
    const value = rawStats[key];
    if (typeof value === 'number' || typeof value === 'boolean') stats[key] = value;
    else if (typeof value === 'string') stats[key] = value.slice(0,1024);
  }
  const quality = read(() => video?.getVideoPlaybackQuality?.());
  const ranges = [];
  if (video) for (let i=0;i<Math.min(4,video.buffered.length);i++) ranges.push([video.buffered.start(i),video.buffered.end(i)]);
  return {url:location.href,title:document.title,videoId:data?.video_id || data?.videoId || response?.videoDetails?.videoId || null,
    watchId:read(() => new URL(location.href).searchParams.get('v')),
    ad:!!player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')),
    adState:read(() => player?.getAdState?.()),playerState:read(() => player?.getPlayerState?.()),stats,
    video:video?{time:video.currentTime,duration:Number.isFinite(video.duration)?video.duration:null,paused:video.paused,
      ended:video.ended,readyState:video.readyState,networkState:video.networkState,rate:video.playbackRate,
      width:video.videoWidth,height:video.videoHeight,muted:video.muted,volume:video.volume,buffered:ranges,
      error:video.error?{code:video.error.code,message:String(video.error.message||'').slice(0,200)}:null,
      decoded:quality?.totalVideoFrames ?? video.webkitDecodedFrameCount ?? null,
      dropped:quality?.droppedVideoFrames ?? video.webkitDroppedFrameCount ?? null}:null};
})()`;

let proc, cdp, outputTerminal, peerError, lastFrame, lastFrameMs = -Infinity, lastHash;
let frames = 0, distinctFrames = 0, ignoredImages = 0, terminalTail = '', finishing = false;
let previousSample = null, mainObservedSeconds = 0, mainStartedMs = null, mainStartFrames = 0, mainStartDistinct = 0;
let maximumMainTime = 0, firstDecoded = null;
const abort = new AbortController(), started = performance.now();
const elapsed = () => Math.round(performance.now() - started);
const results = {pass:false,playbackThresholdReached:false,url:targetUrl,out,limitMs,cadenceMs};
function mark(name, fields = {}) {
  const event = {name,ms:elapsed(),...fields};
  appendFileSync(join(out, 'samples.jsonl'), JSON.stringify(event) + '\n');
  console.log(JSON.stringify(event));
  return event;
}
function check() {
  if (abort.signal.aborted) throw abort.signal.reason;
  if (peerError) throw peerError;
  if (proc?.exitCode !== null && proc?.exitCode !== undefined) throw Error('Casty exited early: ' + proc.exitCode);
}
const timeout = setTimeout(() => abort.abort(Error('180-second observation limit reached')), limitMs);
const handlers = new Map(['SIGINT','SIGTERM','SIGHUP'].map(signal => [signal, () => abort.abort(Error('Interrupted by ' + signal))]));
for (const [signal, handler] of handlers) process.on(signal, handler);
try {
  const peer = new KittyPeer({file:options.file,write:bytes => outputTerminal.write(bytes),
    frame(bytes, transport, placement) {
      if (!isCastyContentFrame(bytes, placement)) {ignoredImages++;return;}
      const hash = Bun.hash(bytes);
      frames++;
      if (hash !== lastHash) distinctFrames++;
      lastHash = hash;lastFrame = bytes;lastFrameMs = elapsed();
      if (frames === 1) {mark('first-kitty-frame', {transport});writeFileSync(join(out,'first-kitty.png'),bytes);}
    },
  });
  proc = Bun.spawn([process.execPath, join(options.castyRoot,'index.js'), targetUrl], {
    cwd:root,
    env:childEnvironment,
    onExit(_child, code) {if (!finishing) abort.abort(Error('Casty exited early: '+code));},
    terminal:{cols:160,rows:40,data(terminal,bytes) {
      outputTerminal = terminal;
      terminalTail = (terminalTail + Buffer.from(bytes).toString()).slice(-16000);
      try {peer.feed(bytes);} catch (error) {peerError = error;}
    }},
  });
  mark('spawn',{pid:proc.pid,out,fileSupport:options.file});
  while (!existsSync(endpointFile)) {check();await Bun.sleep(200);}
  manifest.browserRuntime = JSON.parse(readFileSync(runtimeFile,'utf8'));
  writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2));
  if (realpathSync(manifest.browserRuntime.execPath) !== anticipatedBrowserRuntime.execPath) {
    throw Error('Casty launched a different runtime from the prehashed executable');
  }
  const endpoint = new URL(readFileSync(endpointFile,'utf8'));
  mark('cdp-listening',{port:endpoint.port});
  let target;
  while (!target) {
    check();
    const response = await fetch('http://'+endpoint.host+'/json/list',{signal:abort.signal});
    if (!response.ok) throw Error('Target listing HTTP '+response.status);
    target = (await response.json()).find(item => item.type==='page' && /^https?:/.test(item.url));
    if (!target) await Bun.sleep(200);
  }
  mark('http-target-committed',{url:target.url});
  cdp = await connectCdp(target.webSocketDebuggerUrl,abort.signal);
  for (;;) {
    check();
    const sampleStart = elapsed();
    let state;
    try {
      const response = await cdp.call('Runtime.evaluate',{expression:observation,returnByValue:true});
      if (response.exceptionDetails) throw Error('Observation: '+JSON.stringify(response.exceptionDetails));
      state = response.result?.value;
      if (!state || typeof state !== 'object') throw Error('Observation did not return an object');
    } catch (error) {
      check();mark('observation-error',{message:String(error)});await Bun.sleep(cadenceMs);continue;
    }
    const now = elapsed(), video = state.video;
    const main = !state.ad && (state.videoId===targetId || (!state.videoId && state.watchId===targetId));
    const playing = main && video && !video.paused && !video.ended && !video.error && video.rate===1
      && video.readyState>=2 && video.width>0 && video.height>0;
    const seconds = previousSample ? (now-previousSample.ms)/1000 : 0;
    const received = frames-(previousSample?.frames??0), changed = distinctFrames-(previousSample?.distinctFrames??0);
    if (playing) {
      maximumMainTime = Math.max(maximumMainTime,video.time);
      if (firstDecoded === null && Number.isFinite(video.decoded)) firstDecoded = video.decoded;
      if (mainStartedMs===null) {
        mainStartedMs=now;mainStartFrames=frames;mainStartDistinct=distinctFrames;
        if (lastFrame) writeFileSync(join(out,'main-start-kitty.png'),lastFrame);
      }
      if (previousSample?.playing) {
        const advance = video.time-previousSample.time;
        // Count continuous progression, not a seek/resume jump or a clock
        // racing ahead of real time. No code in this script seeks the media.
        if (advance>0 && advance<=seconds*1.75+1) mainObservedSeconds+=Math.min(advance,seconds);
      }
    }
    mark('sample',{evalMs:now-sampleStart,frames,distinctFrames,frameAgeMs:now-lastFrameMs,
      fps:seconds?Number((received/seconds).toFixed(2)):0,
      changedFps:seconds?Number((changed/seconds).toFixed(2)):0,
      main,mainObservedSeconds:Number(mainObservedSeconds.toFixed(2)),state});
    if (main && state.stats?.debug_error && /reject|fatal/i.test(state.stats.debug_error)) {
      results.playerError = state.stats.debug_error;
      throw Error('Player rejected normal playback: ' + state.stats.debug_error);
    }
    // DOM currentTime alone cannot pass: require at least 65 seconds observed
    // main-video progression, decoded dimensions, and changing Kitty frames.
    if (playing && video.time>65 && mainObservedSeconds>=65 && firstDecoded !== null && video.decoded > firstDecoded + 30 && frames-mainStartFrames>=20
      && distinctFrames-mainStartDistinct>=10 && now-lastFrameMs<5000 && changed>0
      && Number.isFinite(previousSample?.decoded) && video.decoded>previousSample.decoded) {
      const visibility = await cdp.call('Runtime.evaluate',{returnByValue:true,expression:`(()=>{const v=document.querySelector('video.html5-main-video')||document.querySelector('video');if(!v)return null;const r=v.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,visible:r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight}})()`});
      if (!visibility.exceptionDetails && visibility.result?.value?.visible) {
        results.playbackThresholdReached=true;
        results.success=mark('playback-threshold-reached',{videoTime:video.time,mainObservedSeconds,decoded:video.decoded,firstDecoded,videoRect:visibility.result.value});
        if (lastFrame) writeFileSync(join(out,'success-kitty.png'),lastFrame);
        break;
      }
      mark('video-not-visible',{detail:visibility.result?.value,exception:visibility.exceptionDetails});
    }
    previousSample={ms:now,time:video?.time,decoded:video?.decoded,playing,frames,distinctFrames};
    await Bun.sleep(cadenceMs);
  }
} catch (error) {
  results.error=String(error);mark('error',{message:String(error)});
  process.exitCode=1;
} finally {
  finishing=true;clearTimeout(timeout);cdp?.close();
  try {await stopCasty(proc);} catch (error) {results.cleanupError=String(error);process.exitCode=1;}
  try {
    const after = await inputFingerprint(fingerprintOptions);
    const actualRuntimePath = manifest.browserRuntime ? realpathSync(manifest.browserRuntime.execPath) : null;
    const browserBinary = actualRuntimePath ? await fileFingerprint(actualRuntimePath) : null;
    results.inputsUnchanged = sameFingerprint(manifest.inputs,after)
      && actualRuntimePath === anticipatedBrowserRuntime.execPath
      && !!browserBinary && sameFingerprint(anticipatedBrowserRuntime.binary,browserBinary);
    writeFileSync(join(out,'manifest-after.json'),JSON.stringify({inputs:after,browserBinary},null,2));
    if (!results.inputsUnchanged) {results.verificationError='Runtime, environment, configuration or source inputs changed, or browser runtime was not recorded';process.exitCode=1;}
  } catch (error) {results.verificationError=String(error);process.exitCode=1;}
  results.pass = Boolean(results.playbackThresholdReached && results.inputsUnchanged === true && !results.cleanupError && !results.error);
  for (const [signal,handler] of handlers) process.off(signal,handler);
  if (lastFrame) writeFileSync(join(out,'last-kitty.png'),lastFrame);
  writeFileSync(join(out,'terminal-tail.txt'),terminalTail);
  Object.assign(results,{elapsedMs:elapsed(),frames,distinctFrames,ignoredImages,mainObservedSeconds,maximumMainTime});
  writeFileSync(join(out,'result.json'),JSON.stringify(results,null,2));
  mark('finished',{pass:results.pass,frames,distinctFrames,out});
}
