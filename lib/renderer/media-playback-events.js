// `play` means unpaused; `playing` means playback can actually advance.
// Keep the distinction across pauses and network starvation.
const phases = new WeakMap();
export function playbackEvent(state, phase, dispatch) {
  const previous = phases.get(state);
  if (previous === phase) return;
  phases.set(state, phase);
  if (phase === 'playing' && previous === 'waiting') {
    dispatch(state, 'canplay');
    if (phases.get(state) !== phase || !state.playing) return;
  }
  dispatch(state, phase);
}
