// Each element owns one pending playback tick. A synchronous media event can
// stop or restart playback while update() is on the stack.
export function createPlaybackTicks(update, setTimer, clearTimer) {
  let generation = 0;
  let timer = null;

  function stop() {
    generation++;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function run() {
    stop();
    const current = generation;
    const delay = update(current);
    if (delay === undefined || current !== generation) return;
    timer = setTimer(() => {
      if (current !== generation) return;
      timer = null;
      run();
    }, delay);
  }

  return { run, stop, isCurrent: current => current === generation };
}
