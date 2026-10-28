/**
 * Cooperative idle work shares a short period, rather than granting every
 * queued callback a fresh budget. Dispatch one callback per host task so
 * ordinary timers and input can run between callbacks. A callback registered
 * during a period joins the next one; positive timeouts have their own task.
 * Clock/timer injection keeps the fairness and lifetime tests deterministic.
 */
export function createIdleCallbacks({ now, setTimer, clearTimer, invoke }) {
  const callbacks = new Map();
  let runnable = [], next = 0, deadline = 0, timer = null;
  let running = false, disposed = false;

  function queue() {
    if (disposed) return;
    if (!callbacks.size) {
      if (timer !== null) clearTimer(timer);
      timer = null;
      runnable = []; next = 0;
      return;
    }
    if (running || timer !== null) return;
    // A nested request must not start a new period before this one ends.
    const delay = next >= runnable.length ? Math.max(1, deadline - now()) : 1;
    timer = setTimer(dispatch, delay);
  }

  function remove(record) {
    if (callbacks.get(record.id) !== record) return false;
    callbacks.delete(record.id);
    if (record.timer !== null) clearTimer(record.timer);
    record.timer = null;
    return true;
  }

  function deliver(record, didTimeout, until) {
    if (!remove(record)) return;
    invoke(record.callback, {
      get didTimeout() { return didTimeout; },
      timeRemaining: () => Math.max(0, until - now()),
    });
  }

  function queueTimeout(record) {
    // Web IDL permits unsigned-long timeouts, while host timers only accept a
    // signed 32-bit delay. Chunk longer waits instead of overflowing to 1ms.
    record.timer = setTimer(() => {
      record.timer = null;
      if (disposed || callbacks.get(record.id) !== record) return;
      if (now() < record.expires) { queueTimeout(record); return; }
      running = true;
      try { deliver(record, true, now()); }
      finally {
        running = false;
        queue();
      }
    }, Math.min(2147483647, Math.max(1, record.expires - now())));
  }

  function dispatch() {
    timer = null;
    if (disposed || !callbacks.size) return;
    running = true;
    try {
      const at = now();
      if (at >= deadline) {
        runnable = [...callbacks.values()];
        next = 0;
        deadline = at + 10;
      }
      while (next < runnable.length && callbacks.get(runnable[next].id) !== runnable[next]) next++;
      if (next < runnable.length) {
        const record = runnable[next++], at = now();
        const didTimeout = at >= record.expires;
        deliver(record, didTimeout, didTimeout ? at : deadline);
      }
    } finally {
      running = false;
      queue();
    }
  }

  return {
    request(id, callback, timeout) {
      if (disposed) return id;
      const record = { id, callback, expires: timeout > 0 ? now() + timeout : Infinity, timer: null };
      callbacks.set(id, record);
      if (timeout > 0) queueTimeout(record);
      queue();
      return id;
    },
    cancel(id) {
      const record = callbacks.get(id);
      if (record) remove(record);
      if (!callbacks.size) {
        if (timer !== null) clearTimer(timer);
        timer = null;
        runnable = []; next = 0;
      }
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      for (const record of callbacks.values()) if (record.timer !== null) clearTimer(record.timer);
      callbacks.clear();
      runnable = []; next = 0;
    },
  };
}
