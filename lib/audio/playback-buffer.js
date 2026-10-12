// Decoded PCM kept in the controller is independent of the device queue.
// It can bridge renderer work without increasing pause/seek output latency.
export class PlaybackBuffer {
  constructor(bytesPerSecond, frameBytes, leadSeconds) {
    this.bytesPerSecond = bytesPerSecond;
    this.frameBytes = frameBytes;
    this.reserve = leadSeconds <= 0.15 ? 0 : this.align(bytesPerSecond * 2);
    this.threshold = this.reserve ? this.align(bytesPerSecond * 0.4) : 0;
    this.buffering = Boolean(this.reserve);
  }

  align(bytes) {
    return Math.max(0, Math.floor(bytes / this.frameBytes) * this.frameBytes);
  }

  ready(queued, inDevice, finishing) {
    if (!this.reserve || finishing) return true;
    if (queued < this.frameBytes && inDevice < this.frameBytes) this.buffering = true;
    if (this.buffering && queued >= this.threshold) this.buffering = false;
    return !this.buffering;
  }

  request(queued, outstanding, inDevice, immediateNeed) {
    // Requests stay bounded even when the producer or network stops replying.
    return this.align(Math.max(immediateNeed, this.reserve - inDevice) - queued - outstanding);
  }
}
