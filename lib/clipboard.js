import {powershellClipboard} from './clipboard-powershell.js';
// Host-side text clipboard. No shell interpolation; page bytes go only to stdin.
export function clipboardCommands(platform = process.platform) {
  return [
    ['xclip','-selection','clipboard'],
    ...(platform === 'win32' ? [['powershell.exe']]
      : platform === 'darwin' ? [['pbcopy']] : [['wl-copy'],['termux-clipboard-set']]),
  ];
}
async function writeHostClipboard(text, {which = Bun.which, spawn = Bun.spawn, platform = process.platform} = {}) {
  if(typeof text !== 'string' || Buffer.byteLength(text)>1024*1024)throw Error('Clipboard text exceeds limit');
  for(const command of clipboardCommands(platform)) {
    const executable=which(command[0]); if(!executable)continue;
    let child,timer;
    try {
      if(command[0]==='powershell.exe') {
        if(powershellClipboard(executable).write(text))return;
        continue;
      }
      child=spawn([executable,...command.slice(1)],{stdin:Buffer.from(text),stdout:'ignore',stderr:'ignore'});
      timer=setTimeout(()=>child.kill(9),3000);
      if(await child.exited === 0)return;
    } catch {} finally {clearTimeout(timer);}
  }
  throw Error('No working clipboard command (xclip preferred)');
}

// Read only on an explicit paste request; never poll the system clipboard.
async function readHostClipboard({which = Bun.which, spawn = Bun.spawn, platform = process.platform} = {}) {
  const commands = [['xclip','-selection','clipboard','-o'],
    ...(platform === 'win32' ? [['powershell.exe','-NoProfile','-Command','Get-Clipboard -Raw']]
      : platform === 'darwin' ? [['pbpaste']] : [['wl-paste','--no-newline'],['termux-clipboard-get']])];
  for (const command of commands) {
    const executable = which(command[0]); if (!executable) continue;
    let child, timer;
    try {
      if(command[0]==='powershell.exe') {
        const text=powershellClipboard(executable).read();
        if(Buffer.byteLength(text)>1024*1024)throw Error('Clipboard text exceeds limit');
        return text;
      }
      child = spawn([executable,...command.slice(1)], {stdin:'ignore',stdout:'pipe',stderr:'ignore'});
      timer = setTimeout(()=>child.kill(9),3000);
      const chunks=[]; let size=0;
      for await (const chunk of child.stdout) {
        size += chunk.length;
        if (size > 1024*1024) { child.kill(9); throw Error('Clipboard text exceeds limit'); }
        chunks.push(Buffer.from(chunk));
      }
      if (await child.exited === 0) {
        const text=Buffer.concat(chunks).toString();
        return command[0]==='powershell.exe' ? text.replace(/\r?\n$/, '') : text;
      }
    } catch {} finally {clearTimeout(timer);}
  }
  throw Error('No working clipboard read command (xclip preferred)');
}

// One bounded text snapshot per host adapter. Always attempt a fresh read;
// Android may report a denied background read as successful empty output.
const defaultOptions = {};
const snapshots = new WeakMap();
function snapshot(options) {
  let state = snapshots.get(options);
  if (!state) snapshots.set(options, state = {text: '', revision: 0});
  return state;
}
export async function writeClipboard(text, options = defaultOptions) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024*1024)
    throw Error('Clipboard text exceeds limit');
  const state = snapshot(options);
  // Like Land, retain the local copy even if publishing to the host fails.
  state.text = text;
  state.revision++;
  return writeHostClipboard(text, options);
}
export async function readClipboard(options = defaultOptions) {
  const state = snapshot(options), revision = state.revision;
  try {
    const text = await readHostClipboard(options);
    if (state.revision !== revision) return state.text;
    if (text.length) { state.text = text; state.revision++; }
    return state.text;
  } catch (error) {
    if (state.text) return state.text;
    throw error;
  }
}
