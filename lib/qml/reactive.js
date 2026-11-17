// Serialized into the existing page realm; no host callbacks or native APIs.
export function createReactive() {
  let revision = 0;
  let active = null,
    pending = new Set(),
    scheduled = false;
  let invalidationDepth = 0, drainingSync = false;
  const synchronous = new Set();
  const track = new WeakMap(),
    raw = new WeakMap();
  const mark = (job) => {
    if (job.stopped || job.dirty || job.running) return;
    job.dirty = true;
    pending.add(job);
    if (job.sync) synchronous.add(job);
    job.invalidate?.();
  };
  // The properties changed in the last passes before a cycle is declared, which name
  // what keeps changing: a cycle error lists them.
  let lastPasses = false;
  const recent = [];
  const invalidate = (target, key) => {
    if (lastPasses && recent.length < 50) recent.push(String(key));
    invalidationDepth++;
    try {
      for (const job of track.get(raw.get(target) ?? target)?.get(key) ?? []) mark(job);
    } finally {
      invalidationDepth--;
    }
    // Invalidate the whole dependency chain before synchronous observers read
    // it. Their handlers may write more properties; drain without recursive
    // Set iteration, while ordinary rendering effects remain batched.
    if (invalidationDepth || drainingSync) return;
    drainingSync = true;
    try {
      let passes = 0;
      while (synchronous.size) {
        if (++passes > 100) throw breakCycle([...synchronous]);
        lastPasses = passes > 90;
        const jobs = [...synchronous];
        synchronous.clear();
        for (const job of jobs) { pending.delete(job); run(job); }
      }
    } finally {
      drainingSync = false;
      lastPasses = false;
      recent.length = 0;
    }
  };
  // A binding cycle never settles, and each pass may lay text out again: the jobs still
  // pending are set aside, so the next frame does not repeat the same hundred passes and
  // memory cannot run away. Their dependencies stay recorded, so a later change from
  // outside the cycle runs them again. The error names a few of them for debugging.
  const breakCycle = (jobs) => {
    const sample = [];
    for (const job of jobs) {
      job.dirty = false;
      pending.delete(job);
      synchronous.delete(job);
      if (sample.length < 3) sample.push(String(job.fn).replace(/\s+/g, ' ').slice(0, 160));
    }
    const keys = [...new Set(recent)].join(', ');
    recent.length = 0;
    lastPasses = false;
    return new Error(`QML binding cycle (${jobs.length} binding(s) set aside; changing: ${keys}): ${sample.join(' | ')}`);
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
    lastPasses = false;
    recent.length = 0;
    let passes = 0,
      last;
    while (pending.size) {
      if (++passes > 100) throw breakCycle([...pending]);
      lastPasses = passes > 90;
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
  // Read the local value with dependency tracking, before derived reads such
  // as Item.visible inheritance. Accessor/binding dependencies still run normally.
  const readValue = (target, key) => {
    if (active) {
      let map = track.get(target);
      if (!map) track.set(target, (map = new Map()));
      let set = map.get(key);
      if (!set) map.set(key, (set = new Set()));
      set.add(active);
      active.deps.add(set);
    }
    return target[key];
  };
  const state = (initial, interceptSet, interceptGet) => {
    const proxy = new Proxy(initial, {
      get(target, key) {
        const value = readValue(target, key);
        return interceptGet ? interceptGet(proxy, key, value) : value;
      },
      set(target, key, value) {
        if (interceptSet?.(proxy, target, key, value)) return true;
        // A setter may detach a binding even when its value does not change.
        if (Object.hasOwn(target, key) && Object.is(target[key], value)) {
          if (Object.getOwnPropertyDescriptor(target, key)?.set) target[key] = value;
          return true;
        }
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
  const effect = (fn, { sync = false } = {}) => {
    const job = {
      fn,
      sync,
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
      synchronous.delete(job);
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
    ownValue: (object, key) => readValue(raw.get(object) ?? object, key),
    effect,
    flush,
    untrack,
    invalidate,
    get revision() {
      return revision;
    },
  };
}
