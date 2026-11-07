// One counter pair belongs to a media resource, not to a decoder/snapshot.
// The compositor and local fallback share it; queries never wait for a worker
// message or force layout. A new resource gets fresh counters, seeks do not.
export function createVideoQualityCounters() {
  return new Uint32Array(new SharedArrayBuffer(8));
}

export function decodedVideoFrame(counters) {
  if (counters) Atomics.add(counters, 0, 1);
}

export function droppedVideoFrames(counters, count = 1) {
  if (counters && count > 0) Atomics.add(counters, 1, count);
}

export function readVideoQuality(counters) {
  // Writers count decoded before dropped. Read dropped first so a concurrent
  // decode/drop cannot produce more dropped frames than total decoded frames.
  const droppedVideoFrames = counters ? Atomics.load(counters, 1) : 0;
  const totalVideoFrames = counters ? Atomics.load(counters, 0) : 0;
  return { totalVideoFrames, droppedVideoFrames, corruptedVideoFrames: 0 };
}
