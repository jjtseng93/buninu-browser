import { drainMicrotasks } from "bun:jsc";
import { createTimers } from "./timers.js";

// Older Bun checkpoints also dispatched queued event-loop tasks. Although
// 1.4.3 stable fixed this, Bun.version hides the suffix of unsafe 1.4.3
// canaries. Require the later 1.4.4 branch and keep unknown channels on timers.
export function supportsFrameCheckpoint(version = Bun.version) {
  const match = typeof version === "string"
    && /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-canary(?:\.(?:0|[1-9]\d*))?)?$/.exec(version);
  return !!match && Bun.semver.order(match[1], "1.4.4") >= 0;
}

/** One callback collection per document, with a checkpoint between callbacks. */
export function createAnimationFrames({ invoke, now, checkpoint = drainMicrotasks,
  frameTimers = null }) {
  let nextWakeId = 1;
  // A private timer collection keeps frame handles separate from Window timers.
  // timerTask=false also prevents a frame inheriting a timer's nesting clamp.
  const timers = frameTimers ?? createTimers({ invoke: callback => callback(), nextId: () => nextWakeId++ });
  const callbacks = new Map();
  let nextHandle = 0, wake = null, running = false, disposed = false;

  function arm(delay) {
    if (!disposed && wake === null && !running && callbacks.size) {
      wake = timers.schedule(deliver, delay, false, false);
    }
  }
  function deliver() {
    wake = null;
    if (disposed) return;
    running = true;
    const timestamp = now(), handles = [...callbacks.keys()];
    try {
      for (const handle of handles) {
        if (disposed) break;
        const callback = callbacks.get(handle);
        if (callback === undefined) continue;
        callbacks.delete(handle);
        // invoke reports page exceptions. Drain the complete promise/microtask
        // queue here, without yielding unrelated timers or I/O between callbacks.
        try { invoke(callback, timestamp); }
        finally { checkpoint(); }
      }
    } finally {
      running = false;
      // Callbacks registered during delivery, including its microtasks, belong
      // to the next frame. Long callbacks do not add another fixed 16 ms delay.
      arm(Math.max(0, Math.ceil(16 - (now() - timestamp))));
    }
  }
  return {
    request(callback) {
      if (typeof callback !== "function") throw new TypeError("requestAnimationFrame callback must be a function");
      do { nextHandle = (nextHandle + 1) >>> 0; } while (callbacks.has(nextHandle));
      const handle = nextHandle;
      if (!disposed) {
        callbacks.set(handle, callback);
        arm(16);
      }
      return handle;
    },
    cancel(handle) {
      callbacks.delete(+handle >>> 0);
      if (!callbacks.size && wake !== null) {
        timers.cancel(wake);
        wake = null;
      }
    },
    dispose() {
      disposed = true;
      callbacks.clear();
      timers.dispose();
      wake = null;
    },
  };
}
