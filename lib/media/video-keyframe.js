// wasmpeg seeks to a keyframe without returning its timestamp. Locate it by
// comparing tiny decoded probes, then rewind before delivering full frames.
export function seekVideoKeyframe(decoder, seconds, startTime = 0) {
  const start = Math.max(0, startTime);
  seconds = Math.max(start, seconds);
  const seek = time => decoder.seek(Math.max(1, time * 1000));
  const frame = 1 / (decoder.fps || 30);
  if (!(seconds >= start + frame)) { seek(start); return start; }
  const probe = time => {
    seek(time);
    const pixels = decoder.nextFrame(32, 18);
    if (!pixels) return null;
    let hash = 0x811c9dc5;
    for (let i = 0; i < pixels.length; i += 3) hash = Math.imul(hash ^ pixels[i], 0x01000193);
    return hash >>> 0;
  };
  const target = probe(seconds);
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
