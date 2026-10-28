function workerClosedError(event) {
  return new Error(`Video worker closed${Number.isInteger(event?.code) ? ` (${event.code})` : ''}`);
}

/** Compositor-owned endpoint for the independent media decoder. */
export class VideoChannel {
  constructor(worker, changed, report) {
    this.worker = worker;
    this.changed = changed;
    this.report = report;
    this.config = null;
    this.frame = null;
    worker.addEventListener('message', ({data}) => {
      if (this.failure) return;
      if (data.type === 'frame') {
        try {
          if (this.config?.id === data.id) {
            this.frame = data.frame;
            changed();
          }
        } finally {
          // ACK discarded generations too; an old frame may still be in
          // flight when open/stop reaches the independent decoder.
          if (Number.isSafeInteger(data.delivery))
            this.send({type:'frame-ack', id:data.id, delivery:data.delivery});
        }
      } else if (data.type === 'report' && this.config?.id === data.report.id) report(data.report);
    });
    worker.addEventListener('error', error => this.fail(error));
    // Bun silently ignores postMessage after a worker exits. Catch close too,
    // or a dead decoder would retain its last picture without invoking fallback.
    worker.addEventListener('close', event => this.fail(workerClosedError(event)));
  }
  send(message) {
    if (this.failure) return;
    try { this.worker.postMessage(message); }
    catch (error) { this.fail(error); }
  }
  fail(error) {
    if (this.failure) return;
    const id = this.config?.id;
    this.failure = String(error?.message ?? error) || 'Video worker failed';
    this.config = null;
    this.frame = null;
    this.worker.terminate();
    if (id !== undefined) this.report({id,error:this.failure});
  }
  open(config) {
    this.config = config;
    this.frame = null;
    if (this.failure) { this.report({id:config.id,error:this.failure}); return; }
    this.send({type:'open', config});
  }
  extend(request) {
    if (this.config?.id !== request.id || this.failure) return;
    // Existing pixels and their outstanding ACK belong to the same session.
    this.send({ ...request, type: 'extend' });
  }
  stop(id) {
    if (id !== undefined && this.config?.id !== id) return;
    this.config = null;
    this.frame = null;
    this.send({type:'stop', id});
  }
  bind(id, audioId, audioStart, time, endTime) {
    if (this.config?.id !== id || this.failure) return;
    this.send({type:'bind', id, audioId, audioStart, time, endTime});
  }
  timing(id, seconds) {
    this.send({type:'timing', id, seconds});
  }
}

export async function startVideoChannel(changed, report) {
  const worker = new Worker(new URL('./video-worker.js', import.meta.url).href);
  const channel = new VideoChannel(worker, changed, report);
  try {
    await new Promise((resolve, reject) => {
      const ready = ({data}) => { if(data.type === 'ready') {cleanup(); resolve();} };
      const failed = error => {cleanup(); reject(error);};
      const closed = event => failed(new Error(channel.failure || workerClosedError(event).message));
      const timer = setTimeout(() => failed(Error('Video worker startup timed out')), 15000);
      const cleanup = () => {
        clearTimeout(timer);
        worker.removeEventListener('message', ready);
        worker.removeEventListener('error', failed);
        worker.removeEventListener('close', closed);
      };
      worker.addEventListener('message', ready);
      worker.addEventListener('error', failed);
      worker.addEventListener('close', closed);
    });
  } catch (error) { worker.terminate(); throw error; }
  return channel;
}
