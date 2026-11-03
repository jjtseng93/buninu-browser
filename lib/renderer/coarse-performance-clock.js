// HR-Time: non-isolated contexts expose at most 100us resolution. Keep
// elapsed time tied to the host monotonic clock, never Date.now() or timers.
export function createPerformanceClock(performance) {
  const startTick = Math.floor(performance.now() * 10);
  const offset = startTick / 10;
  return {
    offset,
    relative: timestamp => (Math.floor(timestamp * 10) - startTick) / 10,
    timeOrigin: Math.floor((performance.timeOrigin + offset) * 10) / 10,
    now: () => (Math.floor(performance.now() * 10) - startTick) / 10,
  };
}
