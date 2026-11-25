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
