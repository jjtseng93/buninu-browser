// Host-only helpers for the manual real-playback harness. No page instrumentation.
import {existsSync, readFileSync, readdirSync, realpathSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';

export function parseArguments(args, harnessRoot) {
  const options = {browserRoot:harnessRoot, castyRoot:resolve(harnessRoot, '../casty'), file:false, out:null, help:false, networkLabel:'unspecified'};
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--file') options.file = true;
    else if (arg === '--browser-root' || arg === '--casty-root' || arg === '--out' || arg === '--network-label') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      const key = {'--browser-root':'browserRoot','--casty-root':'castyRoot','--out':'out','--network-label':'networkLabel'}[arg];
      if (seen.has(key) || (key === 'out' && options.out)) throw new Error(`Duplicate option: ${arg}`);
      seen.add(key);
      options[key] = key === 'networkLabel' ? value : resolve(value);
    } else if (!arg.startsWith('-') && !options.out) options.out = resolve(arg);
    else throw new Error(`Unknown or duplicate argument: ${arg}`);
  }
  return options;
}

export async function fileFingerprint(path) {
  if (!existsSync(path)) return {missing:true};
  const hash = new Bun.CryptoHasher('sha256');
  let bytes = 0;
  for await (const chunk of Bun.file(path).stream()) {hash.update(chunk);bytes += chunk.byteLength;}
  return {sha256:hash.digest('hex'),bytes};
}

// Include every runtime extension and asset, including fonts, CSS, images and
// installed dependencies. Only known non-runtime top-level trees are excluded.
const excludedRoots = new Set(['.git','test','tests','docs','patches','tools','LICENSES']);
export async function treeFingerprint(root) {
  const entries = [];
  const visit = async (directory, prefix, ancestors) => {
    const real = realpathSync(directory);
    if (ancestors.has(real)) throw new Error('Runtime tree contains a symlink cycle');
    const next = new Set([...ancestors, real]);
    for (const entry of readdirSync(directory, {withFileTypes:true}).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if ((!prefix && excludedRoots.has(entry.name)) || entry.name === '.git') continue;
      const path = join(directory,entry.name), name = prefix + entry.name;
      const stat = entry.isSymbolicLink() ? statSync(path) : entry;
      if (stat.isDirectory()) await visit(path,name+'/',next);
      else if (stat.isFile() && !/\.(?:md|log)$/i.test(name) && !/(?:^|\/)LICENSE(?:[.-]|$)/.test(name)) {
        entries.push([name,await fileFingerprint(path)]);
      }
    }
  };
  await visit(root,'',new Set());
  return {sha256:new Bun.CryptoHasher('sha256').update(JSON.stringify(entries)).digest('hex'),files:entries.length};
}

export function environmentFingerprint(environment) {
  // Values (including proxy credentials or config URLs) are never serialized.
  // Normalize only the wrapper path, which necessarily differs every round.
  const env = {...environment,CASTY_BROWSER:'<round-browser-wrapper>'};
  return new Bun.CryptoHasher('sha256')
    .update(JSON.stringify(Object.keys(env).sort().map(name => [name,env[name]]))).digest('hex');
}

export async function inputFingerprint({browserRoot,castyRoot,harnessRoot,environment}) {
  const home = environment.HOME || homedir();
  const configPaths = [join(home,'.casty','config.json'),join(home,'.bunfig.toml')];
  if (environment.XDG_CONFIG_HOME) configPaths.push(join(environment.XDG_CONFIG_HOME,'bunfig.toml'));
  const configuration = [];
  for (const path of configPaths) configuration.push(await fileFingerprint(path));
  return {
    browser:await treeFingerprint(browserRoot),casty:await treeFingerprint(castyRoot),
    harness:await fileFingerprint(join(harnessRoot,'test/manual-youtube-stability.js')),
    support:await fileFingerprint(join(harnessRoot,'test/manual-youtube-stability-support.js')),
    kittyPeer:await fileFingerprint(join(harnessRoot,'test/manual-casty-home-startup.js')),
    runtime:await fileFingerprint(process.execPath),inheritedEnvironment:environmentFingerprint(environment),configuration,
  };
}

export function sameFingerprint(a,b) {return JSON.stringify(a) === JSON.stringify(b);}

// /proc ownership must be established before signaling the entire PTY group.
function hasOwnedProcessGroup(pid) {
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === pid && Number(fields[3]) === pid) return true;
    } catch (error) {
      // Android hides other applications' processes. They cannot establish
      // ownership; a separate kernel group probe below verifies final absence.
      if (!['ENOENT','ESRCH','EACCES','EPERM'].includes(error.code)) throw error;
    }
  }
  return false;
}

function processGroupExists(pid) {
  try {process.kill(-pid,0);return true;}
  catch (error) {if (error.code === 'ESRCH') return false;throw error;}
}

export async function stopCasty(proc, {
  ownsGroup = hasOwnedProcessGroup,
  groupExists = processGroupExists,
  killGroup = (pid,signal) => process.kill(-pid,signal),
  sleep = ms => Bun.sleep(ms),
} = {}) {
  if (!proc) return false;
  let exited = false;
  const exit = proc.exited.then(() => {exited=true;});
  try {
    try {proc.terminal?.write('\x11');} catch {}
    await Promise.race([exit,sleep(2000)]);
    for (const signal of ['SIGTERM','SIGKILL']) {
      if (ownsGroup(proc.pid)) {
        try {killGroup(proc.pid,signal);} catch (error) {if (error.code !== 'ESRCH') throw error;}
      }
      if (!exited) {
        try {proc.kill(signal);} catch (error) {if (error.code !== 'ESRCH') throw error;}
      }
      if (signal === 'SIGTERM') await sleep(300);
    }
    for (let attempt=0;attempt<=10;attempt++) {
      if (exited && !groupExists(proc.pid)) return true;
      if (attempt<10) await sleep(100);
    }
    throw Error('Casty cleanup could not verify child exit and process-group absence');
  } finally {try {proc.terminal?.close();} catch {}}
}

export function createPlaybackProgress() {
  return {previous:null,lastMainSample:null,mainObservedSeconds:0,mainStartedMs:null,mainStartFrames:0,
    mainStartDistinct:0,firstDecoded:null,maximumMainTime:0,lastKnownMain:false,error:null};
}

export function resetPlaybackProgress(progress) {
  Object.assign(progress,{previous:null,lastMainSample:null,mainObservedSeconds:0,mainStartedMs:null,
    mainStartFrames:0,mainStartDistinct:0,firstDecoded:null});
}

export function observePlayback(progress,state,{targetId,ms,frames,distinctFrames}) {
  const previous = progress.previous, lastMain = progress.lastMainSample, video = state.video;
  // YouTube's frontend emits yt-player-ad-start for getAdState() === 1.
  // Do not infer activity from other enum values or undocumented stats.preroll.
  const ad = state.ad === true || state.adState === 1;
  const wrongIdentity = [state.videoId,state.stats?.video_id].some(id => typeof id === 'string' && id && id !== targetId);
  const main = !ad && !wrongIdentity && state.videoId === targetId;
  if (ad || wrongIdentity) progress.lastKnownMain=false;
  else if (main) progress.lastKnownMain=true;
  // A media/player error may clear the reported video ID. Attribute that error
  // to the last confirmed main video until an explicit ad or other ID appears.
  if (progress.lastKnownMain && !progress.error) {
    if (video?.error) progress.error = 'Main video media error: '+JSON.stringify(video.error);
    else if (state.stats?.debug_error && /reject|fatal/i.test(state.stats.debug_error)) {
      progress.error = 'Player rejected normal playback: '+state.stats.debug_error;
    }
  }
  const playing = Boolean(main && video && !video.paused && !video.ended && !video.seeking
    && !video.error && video.rate === 1 && video.readyState >= 2 && video.width > 0 && video.height > 0
    && Number.isFinite(video.time) && video.time >= 0);
  const seconds = previous ? (ms-previous.ms)/1000 : 0;
  const advance = previous ? video?.time-previous.time : 0;
  let resetReason = null;
  if (ad || wrongIdentity) resetReason = ad ? 'advertisement' : 'different-video';
  else if (video?.seeking) resetReason = 'seeking';
  else if (main && lastMain) {
    const mainAdvance=video?.time-lastMain.time, mainSeconds=(ms-lastMain.ms)/1000;
    if (Number.isFinite(mainAdvance) && (mainAdvance < 0 || (mainSeconds > 0 && mainAdvance > mainSeconds*1.75+1))) resetReason = 'time-discontinuity';
    else if (Number.isFinite(lastMain.decoded) && Number.isFinite(video?.decoded) && video.decoded < lastMain.decoded) resetReason = 'decoded-counter-reset';
  }
  const wasStarted = progress.mainStartedMs !== null;
  if (resetReason) resetPlaybackProgress(progress);
  let started = false;
  if (playing) {
    progress.maximumMainTime = Math.max(progress.maximumMainTime,video.time);
    if (progress.mainStartedMs === null) {
      started = true;
      progress.mainStartedMs=ms;progress.mainStartFrames=frames;progress.mainStartDistinct=distinctFrames;
    }
    if (progress.firstDecoded === null && Number.isFinite(video.decoded)) progress.firstDecoded=video.decoded;
    // Ordinary stalls, brief readiness changes, pauses and unknown identity
    // preserve earned credit. Only intervals with confirmed normal playback
    // at both ends earn time; discontinuities above reset all old baselines.
    if (!resetReason && previous?.playing && seconds > 0 && advance > 0 && advance <= seconds*1.75+1) {
      progress.mainObservedSeconds+=Math.min(advance,seconds);
    }
  }
  const recentDecodedAdvance = !resetReason && previous?.playing
    && Number.isFinite(previous.decoded) && Number.isFinite(video?.decoded) && video.decoded > previous.decoded;
  progress.previous={ms,time:video?.time,decoded:video?.decoded,main,playing,frames,distinctFrames};
  if (main && Number.isFinite(video?.time)) progress.lastMainSample={ms,time:video.time,decoded:video.decoded};
  return {main,playing,seconds,received:frames-(previous?.frames??0),changed:distinctFrames-(previous?.distinctFrames??0),
    recentDecodedAdvance:Boolean(recentDecodedAdvance),started,resetReason:wasStarted?resetReason:null};
}

export function playbackPass(results,aborted) {
  return Boolean(results.playbackThresholdReached === true && results.inputsUnchanged === true
    && results.wrapperUnchanged === true && results.cleanupVerified === true && !aborted
    && !results.error && !results.playerError && !results.cleanupError && !results.verificationError);
}
