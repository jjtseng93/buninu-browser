import { expect, test } from 'bun:test';
import { createIdleCallbacks } from '../lib/renderer/idle-callbacks.js';

function fixture() {
  let time = 0, id = 0;
  const tasks = new Map(), errors = [];
  const clock = {
    now: () => time,
    consume: ms => { time += ms; },
    setTimer(callback, delay) {
      const handle = ++id;
      tasks.set(handle, { callback, at: time + Math.max(1, delay) });
      return handle;
    },
    clearTimer: handle => tasks.delete(handle),
    run() {
      let iterations = 0;
      while (tasks.size) {
        if (++iterations > 1000) throw new Error('Idle scheduler did not finish');
        const [handle, task] = [...tasks].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        tasks.delete(handle);
        time = Math.max(time, task.at);
        task.callback();
      }
    },
  };
  const idle = createIdleCallbacks({ ...clock, invoke(callback, deadline) {
    try { callback(deadline); } catch (error) { errors.push(error.message); }
  } });
  return { clock, idle, tasks, errors };
}

test('a burst of cooperative idle work gives an already due timer a turn', () => {
  const { clock, idle, tasks } = fixture();
  let completed = 0, timer;
  for (let i = 0; i < 16; i++) idle.request(i, deadline => {
    expect(deadline.didTimeout).toBe(false);
    clock.consume(deadline.timeRemaining());
    expect(deadline.timeRemaining()).toBe(0);
    completed++;
  }, 0);
  clock.setTimer(() => { timer = { at: clock.now(), completed }; }, 20);
  // Sixteen requests share one dispatch task; they are not sixteen overdue timers.
  expect(tasks.size).toBe(2);
  clock.run();
  expect(timer).toEqual({ at: 22, completed: 2 });
  expect(completed).toBe(16);
  expect(tasks.size).toBe(0);
});

test('callbacks share their period deadline and nested requests wait for the next period', () => {
  const { clock, idle } = fixture();
  const seen = [];
  idle.request(1, deadline => {
    seen.push({ id: 1, at: clock.now(), budget: deadline.timeRemaining() });
    idle.request(3, nested => seen.push({ id: 3, at: clock.now(), budget: nested.timeRemaining() }), 0);
    clock.consume(3);
  }, 0);
  idle.request(2, deadline => seen.push({ id: 2, at: clock.now(), budget: deadline.timeRemaining() }), 0);
  clock.run();
  expect(seen).toEqual([{ id: 1, at: 1, budget: 10 }, { id: 2, at: 5, budget: 6 }, { id: 3, at: 11, budget: 10 }]);
});

test('positive timeout interrupts an idle backlog once, with no budget or retained timeout', () => {
  const { clock, idle, tasks } = fixture();
  let completed = 0;
  const seen = [];
  for (let i = 0; i < 16; i++) idle.request(i, deadline => {
    clock.consume(deadline.timeRemaining()); completed++;
  }, 0);
  idle.request(20, deadline => seen.push({ at: clock.now(), completed, didTimeout: deadline.didTimeout, remaining: deadline.timeRemaining() }), 5);
  clock.run();
  expect(seen).toEqual([{ at: 11, completed: 1, didTimeout: true, remaining: 0 }]);
  expect(completed).toBe(16);
  expect(tasks.size).toBe(0);
});

test('unsigned-long timeouts are chunked and rechecked before expiring', () => {
  let time = 0, next = 0;
  const timers = new Map(), seen = [];
  const idle = createIdleCallbacks({
    now: () => time,
    setTimer(callback, delay) {
      expect(delay).toBeGreaterThanOrEqual(1);
      expect(delay).toBeLessThanOrEqual(2147483647);
      timers.set(++next, { callback, delay });
      return next;
    },
    clearTimer: id => timers.delete(id),
    invoke: (callback, deadline) => callback(deadline),
  });
  idle.request(1, deadline => seen.push([deadline.didTimeout, deadline.timeRemaining()]), 4294967295);
  const fire = (id, at) => {
    time = at;
    const task = timers.get(id);
    timers.delete(id);
    task.callback();
  };
  expect(timers.get(1).delay).toBe(2147483647);
  // Exercise timeout tasks without running the idle-dispatch task: reaching a
  // host timer's maximum delay is not the idle callback's expiration.
  fire(1, 2147483647);
  expect(seen).toEqual([]);
  expect(timers.get(3).delay).toBe(2147483647);
  fire(3, 4294967294);
  expect(seen).toEqual([]);
  expect(timers.get(4).delay).toBe(1);
  fire(4, 4294967295);
  expect(seen).toEqual([[true, 0]]);
  expect(timers.size).toBe(0);
});

test('cancellation works before dispatch, inside a period and for timeout tasks', () => {
  const { clock, idle, tasks } = fixture();
  const seen = [];
  idle.request(1, () => seen.push(1), 1);
  idle.cancel(1);
  expect(tasks.size).toBe(0);
  idle.request(2, () => { seen.push(2); idle.cancel(3); }, 0);
  idle.request(3, () => seen.push(3), 3);
  idle.request(4, () => seen.push(4), 50);
  clock.run();
  expect(seen).toEqual([2, 4]);
  expect(clock.now()).toBeLessThan(50);
  expect(tasks.size).toBe(0);
});

test('disposal inside a callback clears remaining dispatch and timeout work', () => {
  const { clock, idle, tasks } = fixture();
  const seen = [];
  idle.request(1, () => { seen.push(1); idle.dispose(); idle.request(3, () => seen.push(3), 1); }, 0);
  idle.request(2, () => seen.push(2), 50);
  clock.run();
  expect(seen).toEqual([1]);
  expect(tasks.size).toBe(0);
  idle.dispose();
});

test('reported callback errors leave subsequent idle work runnable', () => {
  const { clock, idle, tasks, errors } = fixture();
  let complete = false;
  idle.request(1, () => { throw Error('page exception'); }, 0);
  idle.request(2, () => { complete = true; }, 0);
  clock.run();
  expect(errors).toEqual(['page exception']);
  expect(complete).toBe(true);
  expect(tasks.size).toBe(0);
});
