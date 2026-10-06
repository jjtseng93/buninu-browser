/**
 * A growing media buffer shared by a progressive download and by MSE appends.
 *
 * wasmpeg can only open a decoder on a complete snapshot, so playback keeps
 * this concatenation, reopens when the decoder runs off the end of what it
 * was opened on, and seeks back. `generation` changes on every append and
 * on finish/fail, which is how a decoder knows its snapshot is stale.
 * `waitFor` resolves when `size` reaches the mark or the pipe is finished.
 */
export function createBytePipe() {
  const chunks = [];
  let size = 0;
  let generation = 0;
  let done = false;
  let error = null;
  /** @type {Array<() => void>} */
  const waiters = [];

  const wake = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };

  return {
    append(bytes) {
      if (done || bytes == null) return;
      const chunk = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (!chunk.byteLength) return;
      chunks.push(chunk);
      size += chunk.byteLength;
      generation += 1;
      wake();
    },
    finish() {
      if (done) return;
      done = true;
      generation += 1;
      wake();
    },
    fail(reason) {
      if (done) return;
      error = reason instanceof Error ? reason : new Error(String(reason ?? "media fetch failed"));
      done = true;
      generation += 1;
      wake();
    },
    /** One contiguous snapshot. Collapses chunks so the next call is cheap. */
    bytes() {
      if (chunks.length === 1) return chunks[0];
      const out = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      chunks.length = 0;
      if (out.byteLength) chunks.push(out);
      return out;
    },
    get size() {
      return size;
    },
    get generation() {
      return generation;
    },
    get done() {
      return done;
    },
    get error() {
      return error;
    },
    waitFor(mark) {
      if (size >= mark || done) return Promise.resolve();
      return new Promise((resolve) => {
        const check = () => {
          if (size >= mark || done) resolve();
          else waiters.push(check);
        };
        waiters.push(check);
      });
    },
  };
}
