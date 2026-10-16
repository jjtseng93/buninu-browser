import { expect, test } from "bun:test";
import { advanceAudio } from "../lib/media/position-audio.js";
import { createBytePipe } from "../lib/media/byte-pipe.js";

function track(pipe, length) {
  let next = 2;
  return { position: 0, pending: new Float32Array([0, 1]), pipe, openedGeneration: pipe.generation,
    decoder: { sampleRate: 1, channels: 1, nextSamples() {
      if (next >= length) return null;
      const samples = new Float32Array([next, next + 1]);
      next += 2;
      return samples;
    } } };
}

test.each([4, 5, 6])("snapshot reopen consumes the pending first chunk before reaching sample %i", async (target) => {
  const pipe = createBytePipe();
  pipe.append(new Uint8Array(1));
  let sound = track(pipe, 2);
  pipe.append(new Uint8Array(1)); // newer data already present: don't wait for another append
  let reopened = 0;
  expect(await advanceAudio(() => sound, target, {
    needsMore: () => true,
    reopen: async () => { reopened++; sound = track(pipe, 10); return true; },
  })).toBe(true);
  expect(reopened).toBe(1);
  expect(sound.position).toBe(target);
  expect([...(sound.pending ?? sound.decoder.nextSamples())][0]).toBe(target);
});

test("network starvation waits for data without replaying an earlier prefix", async () => {
  const pipe = createBytePipe();
  pipe.append(new Uint8Array(1));
  let sound = track(pipe, 2), completed = false;
  const job = advanceAudio(() => sound, 4, {
    needsMore: () => true,
    reopen: async () => { sound = track(pipe, 8); return true; },
  }).then(value => { completed = true; return value; });
  await Bun.sleep(30);
  expect(completed).toBe(false);
  expect(sound.pending).toBeNull();
  pipe.append(new Uint8Array(1));
  expect(await job).toBe(true);
  expect(sound.decoder.nextSamples()[0]).toBe(4);
});

test("a cancelled seek cannot reopen a stale decoder after data arrives", async () => {
  const pipe = createBytePipe();
  pipe.append(new Uint8Array(1));
  const sound = track(pipe, 2);
  let active = true, reopened = false;
  const job = advanceAudio(() => sound, 8, {
    needsMore: () => true, active: () => active,
    reopen: async () => { reopened = true; return true; },
  });
  active = false;
  pipe.append(new Uint8Array(1));
  expect(await job).toBe(false);
  expect(reopened).toBe(false);
});

test("an ended prefix or failed reopen never claims to have reached the target", async () => {
  const pipe = createBytePipe();
  pipe.append(new Uint8Array(1));
  const sound = track(pipe, 2);
  expect(await advanceAudio(() => sound, 8, { needsMore: () => false, reopen: async () => false })).toBe(false);
});

test("a seek before the first audio epoch cannot keep reopening an unreachable prefix", async () => {
  let sound = { position: 6, decoder: { sampleRate: 1, channels: 1 } }, reopened = 0;
  expect(await advanceAudio(() => sound, 2, {
    needsMore: () => true,
    reopen: async () => { reopened++; sound = { ...sound, position: 6 }; return true; },
  })).toBe(false);
  expect(reopened).toBe(1);
});

test("audio epoch EOF resumes at the next absolute sample cursor", async () => {
  const pipe = createBytePipe(); pipe.finish();
  let sound = { position: 6, pending: null, endTime: 6, snapshotId: 1, openedGeneration: 1, pipe,
    decoder: { sampleRate: 1, channels: 1, nextSamples: () => null } };
  expect(await advanceAudio(() => sound, 7, {
    needsMore: () => true,
    reopen: async () => {
      sound = { ...sound, position: 6, endTime: Infinity, snapshotId: 2, pending: new Float32Array([6, 7]) };
      return true;
    },
  })).toBe(true);
  expect(sound.position).toBe(7);
  expect([...sound.pending]).toEqual([7]);
});
