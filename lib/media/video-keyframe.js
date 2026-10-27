// wasmpeg seeks to a keyframe without returning its timestamp. Locate it by
// comparing tiny decoded probes, then rewind before delivering full frames.
import { mp4KeyframeBefore } from './mp4-keyframes.js';

export function seekVideoKeyframe(decoder, seconds, startTime = 0, bytes = null) {
  const start = Math.max(0, startTime);
  seconds = Math.max(start, seconds);
  const seek = time => decoder.seek(Math.max(1, time * 1000));
  const frame = 1 / (decoder.fps || 30);
  if (!(seconds >= start + frame)) { seek(start); return start; }
  let lastPixels = null;
  const probe = time => {
    seek(time);
    const pixels = decoder.nextFrame(32, 18);
    lastPixels = pixels;
    if (!pixels) return null;
    let hash = 0x811c9dc5;
    for (let i = 0; i < pixels.length; i += 3) hash = Math.imul(hash ^ pixels[i], 0x01000193);
    return hash >>> 0;
  };
  const target = probe(seconds);
  const candidate = bytes && mp4KeyframeBefore(bytes, seconds);
  if (target !== null && candidate !== null && candidate >= start && frame >= 0.001) {
    // A container index narrows the search; it cannot establish what a
    // decoder actually returned. Require the same complete tiny picture at
    // the candidate and a different one just before its seek boundary.
    // This preserves the existing decode-time convention, not guessed PTS.
    const targetPixels = lastPixels.slice();
    const samePicture = () => lastPixels?.length === targetPixels.length
      && targetPixels.every((byte, i) => byte === lastPixels[i]);
    // The decoder's seek API rounds to integer milliseconds; do not round
    // a fractional keyframe time down into the preceding GOP.
    const candidateSeek = Math.ceil(candidate * 1000) / 1000;
    try {
      probe(candidateSeek);
      if (samePicture()) {
        const atStart = candidate === start;
        if (!atStart) probe(Math.max(start, candidate - frame));
        if (atStart || (lastPixels && !samePicture())) { seek(candidateSeek); return candidate; }
      }
    } catch {
      // An optional index hint must not turn a working decoder search into
      // an open failure. Errors from the original search still propagate.
    }
  }
  let keyframe = seconds;
  if (target !== null) {
    let distance = 10;
    let earlier = Math.max(start, seconds - distance);
    let previous = probe(earlier);
    // A GOP can span more than ten seconds. Keep widening the search until
    // it crosses the keyframe or reaches the start; otherwise the reported
    // time moves forward while the decoder still returns that older frame.
    while (earlier > start && previous === target) {
      keyframe = earlier;
      distance *= 2;
      earlier = Math.max(start, seconds - distance);
      previous = probe(earlier);
    }
    if (previous !== target) {
      while (keyframe - earlier > frame) {
        const middle = (earlier + keyframe) / 2;
        if (probe(middle) === target) keyframe = middle;
        else earlier = middle;
      }
    } else keyframe = earlier;
  }
  seek(keyframe);
  return keyframe;
}
