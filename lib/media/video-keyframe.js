// wasmpeg seeks to a keyframe without returning its timestamp. Locate it by
// comparing tiny decoded probes, then rewind before delivering full frames.
export function seekVideoKeyframe(decoder, seconds) {
  const seek = time => decoder.seek(Math.max(1, time * 1000));
  const frame = 1 / (decoder.fps || 30);
  if (!(seconds >= frame)) { seek(0); return 0; }
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
    let earlier = Math.max(0, seconds - 10);
    if (earlier > 0 && probe(earlier) !== target) {
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
