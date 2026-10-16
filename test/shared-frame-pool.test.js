import { expect, test } from "bun:test";
import { SharedFramePool, FrameLeaseTracker } from "../lib/paint/shared-frame-pool.js";

test("pixel reuse waits for both current renderer ownership and every compositor lease", () => {
  const pool = new SharedFramePool();
  const first = pool.acquire(16); first.fill(7); pool.publish(1, first);
  pool.publish(2, first); // Scroll publication with the same current pixels.
  pool.release(1);
  const second = pool.acquire(16); second.fill(9); pool.publish(3, second);
  const third = pool.acquire(16);
  expect(third.buffer).not.toBe(first.buffer);
  expect([...first]).toEqual(Array(16).fill(7));
  pool.release(2);
  expect(pool.acquire(16).buffer).toBe(first.buffer);
  pool.release(3);
  expect(pool.acquire(16).buffer).not.toBe(second.buffer); // Still renderer's current tile.
  pool.clear();
});

test("an old frame stays immutable while its asynchronous screenshot encoder is reading it", async () => {
  const pool = new SharedFramePool();
  const released = [];
  const tracker = new FrameLeaseTracker(serial => { released.push(serial); pool.release(serial); });
  const first = pool.acquire(8); first.fill(1); pool.publish(1, first); tracker.replace(1, first);
  let finish;
  const captured = tracker.capture(async pixels => { await new Promise(resolve => finish = resolve); return [...pixels]; });
  const second = pool.acquire(8); second.fill(2); pool.publish(2, second); tracker.replace(2, second);
  expect(released).toEqual([]);
  const third = pool.acquire(8); third.fill(3); pool.publish(3, third); tracker.replace(3, third);
  expect(released).toEqual([2]);
  expect(pool.acquire(8).buffer).toBe(second.buffer);
  finish();
  expect(await captured).toEqual(Array(8).fill(1));
  expect(released).toEqual([2, 1]);
  expect(pool.acquire(8).buffer).toBe(first.buffer);
  pool.clear();
});

test("idle pixel cache stays bounded and failed captures release their retired frames", async () => {
  const pool = new SharedFramePool({ maxBuffers: 1, maxBytes: 8 });
  const frames = Array.from({ length: 4 }, (_, i) => {
    const pixels = pool.acquire(8); pool.publish(i, pixels); return pixels;
  });
  pool.release(0); pool.release(1); pool.release(2);
  expect(pool.acquire(8).buffer).toBe(frames[2].buffer);
  expect(frames.some(frame => pool.acquire(8).buffer === frame.buffer)).toBe(false);
  const released = [];
  const tracker = new FrameLeaseTracker(serial => released.push(serial));
  tracker.replace(10, "old");
  const pending = tracker.capture(() => { throw new Error("encoder failed"); });
  tracker.replace(11, "new");
  await expect(pending).rejects.toThrow("encoder failed");
  expect(released).toEqual([10]);
});

test("a resize replaces idle warm-up buffers with reusable current-size buffers", () => {
  const pool = new SharedFramePool({ maxBuffers: 2 });
  const small = pool.acquire(4); pool.publish(1, small);
  const medium = pool.acquire(8); pool.publish(2, medium); pool.release(1);
  const large = pool.acquire(32); pool.publish(3, large); pool.release(2);
  const next = pool.acquire(32); pool.publish(4, next); pool.release(3);
  expect(pool.acquire(32).buffer).toBe(large.buffer);
});
