// Parse the timing and payload of WebVTT cues. Keep cue markup as text until
// the consumer requests a cue fragment or paints an active subtitle.
function timestamp(text) {
  const match = /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(text);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) return NaN;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60
    + Number(match[3]) + Number(match[4]) / 1000;
}

export function parseWebVTT(source) {
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD').split('\n');
  if (!/^WEBVTT(?:[ \t].*)?$/.test(lines[0])) return null;
  const cues = [];
  let id = '', cue = null, inHeader = true, comment = false;
  for (let i = 1; i <= lines.length; i++) {
    const line = lines[i];
    if (!line || line.includes('-->') && cue && !comment) {
      if (cue) cues.push({...cue, text: cue.text.join('\n')});
      cue = null;
      id = '';
      if (!line) {
        inHeader = false;
        comment = false;
        continue;
      }
    }
    if (comment) continue;
    if (line.includes('-->')) {
      inHeader = false;
      const match = /^[ \t]*(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t]+(.*))?$/.exec(line);
      const startTime = match && timestamp(match[1]), endTime = match && timestamp(match[2]);
      if (Number.isFinite(startTime) && Number.isFinite(endTime)) {
        cue = {id, startTime, endTime, settings: match[3] ?? '', text: []};
      }
      id = '';
    } else if (cue) cue.text.push(line);
    else if (!inHeader) {
      if (/^NOTE(?:[ \t]|$)/.test(line)) comment = true;
      else id = line;
    }
  }
  return cues;
}
