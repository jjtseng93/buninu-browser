/**
 * Cooperative idle work shares a short period, rather than granting every
 * queued callback a fresh budget. Dispatch one callback per host task so
 * ordinary timers and input can run between callbacks. A callback registered
 * during a period joins the next one; expired callbacks get individual tasks.
 * Clock/timer injection keeps the fairness and lifetime tests deterministic.
 */
export function createIdleCallbacks({ now, setTimer, clearTimer, invoke }) {
  const callbacks = new Map();
  let runnable = [], next = 0, deadline = 0, timer = null;
  // Only timed requests enter this removable heap. One host timer watches its
  // earliest deadline, so fractional early wakes cannot let a later request
  // overtake the first. Request/cancel are O(log n), without scanning untimed
  // callbacks or retaining cancelled records until their original deadline.
  const timeouts = [];
  let timeoutTimer = null, timeoutHead = null, order = 0;
  let running = false, disposed = false;

  const earlier = (a, b) => a.expires < b.expires || a.expires === b.expires && a.order < b.order;
  function place(index, record) { timeouts[index] = record; record.heapIndex = index; }
  function rise(index, record) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!earlier(record, timeouts[parent])) break;
      place(index, timeouts[parent]); index = parent;
    }
    place(index, record);
  }
  function removeTimeout(record) {
    const index = record.heapIndex;
    if (index < 0) return;
    const last = timeouts.pop(); record.heapIndex = -1;
    if (last === record) return;
    if (index > 0 && earlier(last, timeouts[Math.floor((index - 1) / 2)])) {
      rise(index, last); return;
    }
    let at = index;
    while (at * 2 + 1 < timeouts.length) {
      let child = at * 2 + 1;
      if (child + 1 < timeouts.length && earlier(timeouts[child + 1], timeouts[child])) child++;
      if (!earlier(timeouts[child], last)) break;
      place(at, timeouts[child]); at = child;
    }
    place(at, last);
  }

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
    removeTimeout(record);
    return true;
  }

  function deliver(record, didTimeout, until) {
    if (!remove(record)) return;
    invoke(record.callback, {
      get didTimeout() { return didTimeout; },
      timeRemaining: () => Math.max(0, until - now()),
    });
  }

  function queueTimeout() {
    const first = disposed ? null : timeouts[0];
    if (timeoutTimer !== null && timeoutHead === first) return;
    if (timeoutTimer !== null) clearTimer(timeoutTimer);
    timeoutTimer = null; timeoutHead = null;
    if (!first) return;
    // Web IDL permits unsigned-long timeouts, while host timers only accept a
    // signed 32-bit delay. Chunk longer waits instead of overflowing to 1ms.
    timeoutHead = first;
    timeoutTimer = setTimer(() => {
      timeoutTimer = null; timeoutHead = null;
      if (disposed) return;
      const record = timeouts[0];
      if (!record) return;
      if (now() < record.expires) { queueTimeout(); return; }
      running = true;
      try { deliver(record, true, now()); }
      finally {
        running = false;
        queueTimeout();
        queue();
      }
    }, Math.min(2147483647, Math.max(1, first.expires - now())));
  }

  function dispatch() {
    timer = null;
    if (disposed || !callbacks.size) return;
    running = true;
    try {
      const at = now();
      // Idle and timeout tasks can both become runnable while the host is
      // busy. Choose the same earliest expiration from either entry point.
      if (timeouts[0]?.expires <= at) {
        deliver(timeouts[0], true, at);
        return;
      }
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
      queueTimeout();
      queue();
    }
  }

  return {
    request(id, callback, timeout) {
      if (disposed) return id;
      const previous = callbacks.get(id);
      if (previous) remove(previous);
      const record = { id, callback, expires: timeout > 0 ? now() + timeout : Infinity, order: order++, heapIndex: -1 };
      callbacks.set(id, record);
      if (Number.isFinite(record.expires)) rise(timeouts.length, record);
      queueTimeout();
      queue();
      return id;
    },
    cancel(id) {
      const record = callbacks.get(id);
      if (record) remove(record);
      queueTimeout();
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
      if (timeoutTimer !== null) clearTimer(timeoutTimer);
      timeoutTimer = null; timeoutHead = null;
      callbacks.clear();
      timeouts.length = 0;
      runnable = []; next = 0;
    },
  };
}
