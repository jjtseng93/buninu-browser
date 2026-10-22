// Serialized into the existing page realm; no host callbacks or native APIs.
export function createReactive() {
  let active = null, pending = new Set(), scheduled = false;
  const track = new WeakMap();
  const clean = job => { for (const set of job.deps) set.delete(job); job.deps.clear(); };
  const run = job => {
    if (job.stopped) return;
    clean(job); const previous = active; active = job;
    try { job.fn(); } finally { active = previous; }
  };
  const flush = () => {
    scheduled = false; let passes = 0;
    try {
      while (pending.size) {
        if (++passes > 100) throw new Error('QML binding cycle');
        const jobs = [...pending]; pending.clear(); for (const job of jobs) run(job);
      }
    } finally { pending.clear(); }
  };
  const state = initial => new Proxy(initial, {
    get(target, key) {
      if (active) {
        let map = track.get(target); if (!map) track.set(target, map = new Map());
        let set = map.get(key); if (!set) map.set(key, set = new Set());
        set.add(active); active.deps.add(set);
      }
      return target[key];
    },
    set(target, key, value) {
      if (Object.is(target[key], value)) return true;
      target[key] = value;
      for (const job of track.get(target)?.get(key) ?? []) pending.add(job);
      if (pending.size && !scheduled) { scheduled = true; queueMicrotask(flush); }
      return true;
    },
  });
  const effect = fn => {
    const job = {fn, deps: new Set(), stopped: false}; run(job);
    return () => { job.stopped = true; clean(job); pending.delete(job); };
  };
  return {state, effect};
}
