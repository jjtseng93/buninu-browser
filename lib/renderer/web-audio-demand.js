// A compositor worker can publish device demand while the page thread is
// rasterizing. Both notifications carry the same cumulative PCM byte count.
export class WebAudioDemand {
  cell = new BigInt64Array(new SharedArrayBuffer(8));
  received = 0;

  constructor(deliver) { this.deliver = deliver; }

  receive(total, checkpoint = false) {
    const bytes = Math.max(0, total - this.received);
    this.received += bytes;
    // A previous request may be partly rendered and waiting on a page timer.
    if (bytes || checkpoint) this.deliver({ event: "request", bytes, checkpoint });
  }
}

const streams = new Map();
let nextCheck = 0;
const monotonicNow = performance.now.bind(performance);

export function watchWebAudio(id, deliver) {
  const stream = new WebAudioDemand(deliver);
  streams.set(id, stream);
  return stream;
}

export function unwatchWebAudio(id) { return streams.delete(id); }

export function serviceWebAudio() {
  if (!streams.size) return;
  const now = monotonicNow();
  if (now < nextCheck) return;
  nextCheck = now + 12;
  for (const stream of streams.values()) stream.receive(Number(Atomics.load(stream.cell, 0)), true);
}

// WebGL queries must be synchronous. The device continues to request PCM
// while a software render worker is busy with commands ahead of the query.
export function waitWithWebAudio(cell,expected,timeout) {
  if (!streams.size) return Atomics.wait(cell,0,expected,timeout);
  const end = monotonicNow()+timeout;
  let result;
  do {
    result = Atomics.wait(cell,0,expected,Math.max(0,Math.min(12,end-monotonicNow())));
    if (result !== 'timed-out') return result;
    serviceWebAudio();
  } while (monotonicNow()<end);
  return result;
}
