// Host-side text clipboard. No shell interpolation; page bytes go only to stdin.
export function clipboardCommands(platform = process.platform) {
  return [
    ['xclip','-selection','clipboard'],
    ...(platform === 'win32' ? [['powershell.exe','-NoProfile','-NonInteractive','-Command',
      '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())']]
      : platform === 'darwin' ? [['pbcopy']] : [['wl-copy'],['termux-clipboard-set']]),
  ];
}
export async function writeClipboard(text, {which = Bun.which, spawn = Bun.spawn, platform = process.platform} = {}) {
  if(typeof text !== 'string' || Buffer.byteLength(text)>1024*1024)throw Error('Clipboard text exceeds limit');
  for(const command of clipboardCommands(platform)) {
    const executable=which(command[0]); if(!executable)continue;
    let child,timer;
    try {
      child=spawn([executable,...command.slice(1)],{stdin:Buffer.from(text),stdout:'ignore',stderr:'ignore'});
      timer=setTimeout(()=>child.kill(9),3000);
      if(await child.exited === 0)return;
    } catch {} finally {clearTimeout(timer);}
  }
  throw Error('No working clipboard command (xclip preferred)');
}
