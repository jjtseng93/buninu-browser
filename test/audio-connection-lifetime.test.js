import {test, expect} from 'bun:test';
import {SharedAudioConnection} from '../lib/audio/shared-connection.js';

test('audio connection survives one renderer closing, ends with the last owner, and reconnects', async () => {
  let opened = 0, closed = 0;
  const pool = new SharedAudioConnection(async () => ({id:++opened, close(){closed++;}}));
  const a={}, b={};
  expect(await pool.acquire(a)).toBe(await pool.acquire(b));
  pool.release(a); await Promise.resolve();
  expect(closed).toBe(0);
  pool.release(b); await Promise.resolve();
  expect(closed).toBe(1);
  expect((await pool.acquire(a)).id).toBe(2);
  pool.release(a); await Promise.resolve();
  expect(closed).toBe(2);
});

test('closing during authentication does not close or clear a newer connection', async () => {
  let resolveOld, closed = 0, calls = 0;
  const pool = new SharedAudioConnection(() => ++calls===1
    ? new Promise(resolve=>{resolveOld=resolve;})
    : {close(){closed++;}});
  const a={},b={};
  const old=pool.acquire(a); await Promise.resolve();
  pool.release(a);
  const current=await pool.acquire(b);
  resolveOld({close(){closed++;}}); await old; await Promise.resolve();
  expect(closed).toBe(1);
  expect(await pool.acquire(b)).toBe(current);
  pool.release(b); await Promise.resolve();
  expect(closed).toBe(2);
});

test('late authentication failure does not invalidate a newer connection', async () => {
  let rejectOld, calls=0;
  const pool=new SharedAudioConnection(()=>++calls===1
    ? new Promise((_,reject)=>{rejectOld=reject;}) : {close(){}});
  const a={},b={};
  const old=pool.acquire(a); await Promise.resolve();
  pool.release(a);
  const current=await pool.acquire(b);
  rejectOld(Error('old auth failed'));
  await expect(old).rejects.toThrow('old auth failed');
  expect(await pool.acquire(b)).toBe(current);
  pool.release(b);
});
