// Serialized into the existing page realm; no host callbacks or native APIs.
export function createReactive() {
  let revision = 0;
  let active = null,
    pending = new Set(),
    scheduled = false;
  const track = new WeakMap(),
    raw = new WeakMap();
  const mark = (job) => {
    if (job.stopped || job.dirty || job.running) return;
    job.dirty = true;
    pending.add(job);
    job.invalidate?.();
  };
  const invalidate = (target, key) => {
    for (const job of track.get(raw.get(target) ?? target)?.get(key) ?? [])
      mark(job);
  };
  const clean = (job) => {
    for (const set of job.deps) set.delete(job);
    job.deps.clear();
  };
  const run = (job) => {
    if (job.stopped || !job.dirty) return;
    if (job.running) throw Error('QML binding cycle');
    job.dirty = false;
    job.running = true;
    clean(job);
    const previous = active;
    active = job;
    try {
      job.fn();
    } catch (error) {
      job.dirty = true;
      throw error;
    } finally {
      job.running = false;
      active = previous;
    }
  };
  const flush = (allowIncomplete = false) => {
    scheduled = false;
    let passes = 0,
      last;
    while (pending.size) {
      if (++passes > 100) throw new Error('QML binding cycle');
      const jobs = [...pending],
        failed = [];
      pending.clear();
      for (const job of jobs) {
        if (job.running) {
          pending.add(job);
          continue;
        }
        try {
          run(job);
        } catch (error) {
          if (error.qmlFatal) throw error;
          last = error;
          failed.push(job);
        }
      }
      if (failed.length && !pending.size) {
        if (allowIncomplete) {
          for (const job of failed) pending.add(job);
          return last;
        }
        throw last;
      }
      for (const job of failed) pending.add(job);
      if (pending.size && [...pending].every((job) => job.running)) return null;
    }
    return null;
  };
  const state = (initial) => {
    const proxy = new Proxy(initial, {
      get(target, key) {
        if (active) {
          let map = track.get(target);
          if (!map) track.set(target, (map = new Map()));
          let set = map.get(key);
          if (!set) map.set(key, (set = new Set()));
          set.add(active);
          active.deps.add(set);
        }
        return target[key];
      },
      set(target, key, value) {
        if (Object.hasOwn(target, key) && Object.is(target[key], value))
          return true;
        target[key] = value;
        revision++;
        invalidate(target, key);
        if (pending.size && !scheduled) {
          scheduled = true;
          queueMicrotask(flush);
        }
        return true;
      },
    });
    raw.set(proxy, initial);
    return proxy;
  };
  const effect = (fn) => {
    const job = {
      fn,
      deps: new Set(),
      stopped: false,
      dirty: true,
      running: false,
    };
    try {
      run(job);
    } catch (error) {
      job.stopped = true;
      clean(job);
      pending.delete(job);
      throw error;
    }
    const stop = () => {
      job.stopped = true;
      clean(job);
      pending.delete(job);
    };
    stop.run = () => run(job);
    Object.defineProperty(stop, 'onInvalidate', {
      set: (fn) => {
        job.invalidate = fn;
      },
    });
    Object.defineProperty(stop, 'dirty', {
      get: () => job.dirty && !job.stopped,
    });
    return stop;
  };
  const untrack = (fn) => {
    const previous = active;
    active = null;
    try {
      return fn();
    } finally {
      active = previous;
    }
  };
  return {
    state,
    effect,
    flush,
    untrack,
    invalidate,
    get revision() {
      return revision;
    },
  };
}
