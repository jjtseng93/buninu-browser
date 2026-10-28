import { AsyncLocalStorage } from 'node:async_hooks';

// Promise continuations within a timer's microtask checkpoint inherit its
// nesting, but a later task must not inherit a long-finished timer callback.
const taskContext = new AsyncLocalStorage();
const hostSetTimer = globalThis.setTimeout, hostClearTimer = globalThis.clearTimeout;
const hostQueueTask = globalThis.setImmediate, hostClearTask = globalThis.clearImmediate;

/** Window/Worker timers: one Web IDL long conversion and the HTML nesting clamp. */
export function createTimers({ invoke, nextId, setTimer = hostSetTimer, clearTimer = hostClearTimer,
  queueTask = hostQueueTask, clearTask = hostClearTask }) {
  const records = new Map(), checkpoints = new Set(), owner = {};
  let disposed = false, checkpointTask = null;

  function run(record, nesting) {
    if (!nesting) return taskContext.run(null, () => invoke(record.callback));
    const context = { owner, level: nesting, active: true };
    checkpoints.add(context);
    if (checkpointTask === null) checkpointTask = queueTask(() => {
      checkpointTask = null;
      for (const context of checkpoints) context.active = false;
      checkpoints.clear();
    });
    return taskContext.run(context, () => invoke(record.callback));
  }
  function arm(record) {
    const delay = record.nesting > 6 ? Math.max(4, record.delay) : record.delay;
    record.handle = setTimer(() => {
      if (disposed || records.get(record.id) !== record) return;
      const nesting = record.nesting;
      if (record.repeat) {
        // Preserve interval cadence and its handle while advancing nesting;
        // cancellation from inside the callback removes this next wakeup too.
        record.nesting = Math.min(7, nesting + 1);
        arm(record);
      } else records.delete(record.id);
      run(record, nesting);
    }, delay);
  }
  return {
    schedule(callback, delay, repeat = false, timerTask = true) {
      // Unary + performs Web IDL ToNumber (unlike Number, it rejects BigInt),
      // and |0 converts to a signed 32-bit long before negative delays clamp.
      const milliseconds = Math.max(0, +delay | 0);
      const id = nextId();
      if (disposed) return id;
      const current = taskContext.getStore();
      const parent = current?.active && current.owner === owner ? current.level : 0;
      const record = { id, callback, delay: milliseconds, repeat,
        nesting: timerTask ? Math.min(7, parent + 1) : 0, handle: null };
      records.set(id, record);
      arm(record);
      return id;
    },
    cancel(id) {
      const key = Number(id), record = records.get(key);
      if (!record) return;
      records.delete(key);
      clearTimer(record.handle);
    },
    dispose() {
      disposed = true;
      for (const record of records.values()) clearTimer(record.handle);
      records.clear();
      if (checkpointTask !== null) clearTask(checkpointTask);
      checkpointTask = null;
      for (const context of checkpoints) context.active = false;
      checkpoints.clear();
    },
  };
}
