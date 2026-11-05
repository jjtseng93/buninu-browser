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
    fire(handle, at) {
      const task = tasks.get(handle);
      tasks.delete(handle);
      time = at;
      task.callback();
    },
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

// Keep the first ordinary idle task pending outside the runnable timer queue,
// as when the host can process timeout tasks but has not granted idle time.
function holdInitialIdle(tasks) {
  const entry = [...tasks].find(([, task]) => task.at === 1);
  expect(entry).toBeDefined();
  tasks.delete(entry[0]);
}

test('a fractional early timeout wake cannot let a later deadline overtake it', () => {
  const {clock,idle,tasks}=fixture(), seen=[];
  idle.request(1,d=>seen.push([1,d.didTimeout,d.timeRemaining()]),50);
  holdInitialIdle(tasks);
  const first=[...tasks.keys()][0];
  clock.consume(.25);
  idle.request(2,d=>seen.push([2,d.didTimeout,d.timeRemaining()]),50);
  clock.fire(first,49.9);
  expect(seen).toEqual([]);
  clock.run();
  expect(seen).toEqual([[1,true,0],[2,true,0]]);
  expect(tasks.size).toBe(0);
});

test('late equal-deadline callbacks retain registration order and yield after each delivery', () => {
  const {clock,idle,tasks}=fixture(), seen=[];
  for(let i=0;i<80;i++)idle.request(i,d=>{
    expect(d.didTimeout).toBeTrue();expect(d.timeRemaining()).toBe(0);seen.push(i);
  },50);
  // One idle dispatch and one expiration task, independent of burst size.
  expect(tasks.size).toBe(2);
  holdInitialIdle(tasks);
  clock.fire([...tasks.keys()][0],75);
  expect(seen).toEqual([0]);
  let atOrdinaryTimer;
  clock.setTimer(()=>{atOrdinaryTimer=seen.length;},1);
  clock.run();
  expect(atOrdinaryTimer).toBeLessThan(80);
  expect(seen).toEqual(Array.from({length:80},(_,i)=>i));
  expect(tasks.size).toBe(0);
});

test('timeout cancellation and shorter requests replace only the earliest timer', () => {
  const {clock,idle,tasks}=fixture(), seen=[];
  idle.request(1,()=>seen.push(1),50);holdInitialIdle(tasks);
  idle.request(2,()=>seen.push(2),10);
  idle.request(3,()=>seen.push(3),30);
  expect([...tasks.values()].map(t=>t.at)).toEqual([10]);
  idle.cancel(2);expect([...tasks.values()].map(t=>t.at)).toEqual([30]);
  idle.cancel(3);expect([...tasks.values()].map(t=>t.at)).toEqual([50]);
  idle.request(4,()=>seen.push(4),20);
  clock.run();
  expect(seen).toEqual([4,1]);expect(tasks.size).toBe(0);
});

test('an idle task becoming runnable late honors the same earliest expired deadline', () => {
  const {clock,idle,tasks}=fixture(), seen=[];
  idle.request(1,d=>seen.push([1,d.didTimeout]),100);
  idle.request(2,d=>seen.push([2,d.didTimeout]),1);
  clock.consume(200);
  clock.run();
  expect(seen).toEqual([[2,true],[1,true]]);expect(tasks.size).toBe(0);
});

test('timeout callbacks may cancel, register and dispose without retained or duplicate delivery', () => {
  const {clock,idle,tasks}=fixture(), seen=[];
  idle.request(1,()=>{
    seen.push(1);idle.cancel(2);
    idle.request(4,d=>{seen.push(4);expect(d.didTimeout).toBeTrue();idle.dispose();},1);
  },5);
  holdInitialIdle(tasks);
  idle.request(2,()=>seen.push(2),6);
  idle.request(3,()=>seen.push(3),6);
  idle.request(5,()=>seen.push(5),100);
  clock.fire([...tasks.keys()][0],10);
  clock.run();
  expect(seen).toEqual([1,3,4]);expect(tasks.size).toBe(0);
  idle.request(6,()=>seen.push(6),1);expect(tasks.size).toBe(0);
});

test('arbitrary timed cancellations and reused handles preserve deadline and tie order', () => {
  const {clock,idle,tasks}=fixture(), expected=new Map(), seen=[];
  idle.request(-1,()=>{},10000);holdInitialIdle(tasks);
  let seed=12345,order=0;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let i=0;i<500;i++){
    const id=random()%160,timeout=1+random()%97;
    idle.request(id,()=>seen.push(id),timeout);
    expected.set(id,{id,timeout,order:order++});
    if(i%3===0){const cancel=random()%160;idle.cancel(cancel);expected.delete(cancel);}
    expect(tasks.size).toBe(1);
  }
  idle.cancel(-1);clock.run();
  expect(seen).toEqual([...expected.values()].sort((a,b)=>a.timeout-b.timeout||a.order-b.order).map(x=>x.id));
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
