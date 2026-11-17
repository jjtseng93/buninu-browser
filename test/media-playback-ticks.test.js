import { expect, test } from 'bun:test';
import { createPlaybackTicks } from '../lib/renderer/media-playback-ticks.js';

function fakeTimers() {
  const pending = new Set();
  return {
    pending,
    set(callback) { pending.add(callback); return callback; },
    clear(callback) { pending.delete(callback); },
    fire() {
      const [first] = pending;
      expect(pending.delete(first)).toBe(true);
      first();
    },
  };
}

test('an immediate audio drain replaces the pending playback tick', () => {
  const timers = fakeTimers();
  let updates = 0;
  const ticks = createPlaybackTicks(() => { updates++; return 30; }, timers.set, timers.clear);
  ticks.run(); // Initial audio ready.
  const [old] = timers.pending;
  ticks.run(); // The rest of the video is timed without audio.
  expect(timers.pending.size).toBe(1);
  old(); // A callback already handed off before cancellation.
  expect(updates).toBe(2);
  timers.fire();
  expect(updates).toBe(3);
  expect(timers.pending.size).toBe(1);
  ticks.stop();
  expect(timers.pending.size).toBe(0);
});

test('pause and seek inside a timeupdate invalidate the tick on the stack', () => {
  const timers = fakeTimers();
  let started = false;
  const ticks = createPlaybackTicks(generation => {
    expect(ticks.isCurrent(generation)).toBe(true);
    if (!started) {
      started = true;
      ticks.stop();
      expect(ticks.isCurrent(generation)).toBe(false);
    }
    return 20;
  }, timers.set, timers.clear);
  ticks.run();
  expect(timers.pending.size).toBe(0);
  ticks.run(); // The seek has completed / playback has resumed.
  expect(timers.pending.size).toBe(1);
});

test('a refill restart during an update keeps only the new clock', () => {
  const timers = fakeTimers();
  let updates = 0;
  const ticks = createPlaybackTicks(generation => {
    if (++updates === 1) {
      ticks.stop();
      ticks.run();
      expect(ticks.isCurrent(generation)).toBe(false);
    }
    if (updates < 3) return 25;
  }, timers.set, timers.clear);
  ticks.run();
  expect(updates).toBe(2);
  expect(timers.pending.size).toBe(1);
  timers.fire();
  expect(updates).toBe(3);
  expect(timers.pending.size).toBe(0); // Finished playback.
});
