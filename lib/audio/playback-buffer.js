// Decoded PCM kept in the controller is independent of the device queue.
// It can bridge renderer work without increasing pause/seek output latency.
export class PlaybackBuffer {
  constructor(bytesPerSecond, frameBytes, leadSeconds, liveReserveSeconds = 0) {
    this.bytesPerSecond = bytesPerSecond;
    this.frameBytes = frameBytes;
    this.reserve = this.align(bytesPerSecond * (leadSeconds <= 0.15 ? Math.max(0, Math.min(.5, liveReserveSeconds)) : 2));
    this.threshold = leadSeconds <= 0.15 ? 0 : this.align(bytesPerSecond * 0.4);
    this.buffering = Boolean(this.threshold);
  }

  align(bytes) {
    return Math.max(0, Math.floor(bytes / this.frameBytes) * this.frameBytes);
  }

  ready(queued, inDevice, finishing) {
    if (!this.threshold || finishing) return true;
    if (queued < this.frameBytes && inDevice < this.frameBytes) this.buffering = true;
    if (this.buffering && queued >= this.threshold) this.buffering = false;
    return !this.buffering;
  }

  request(queued, outstanding, inDevice, immediateNeed) {
    // Requests stay bounded even when the producer or network stops replying.
    return this.align(Math.max(immediateNeed, this.reserve - inDevice) - queued - outstanding);
  }
}
