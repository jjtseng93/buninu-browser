import { expect, test } from "bun:test";
import { createAnimationFrames, supportsFrameCheckpoint } from "../lib/renderer/animation-frames.js";

// Bun.version hides the suffix of unsafe 1.4.3 canaries. Require the later
// 1.4.4 branch and retain timers for unknown prerelease channels.
test("animation batching requires a microtask-only Bun checkpoint", () => {
  for (const version of ["1.4.2", "1.4.3", "1.4.3-canary.1", "1.4.4-dev.1", "1.4.4+local", "v1.4.4", "unknown", null]) {
    expect(supportsFrameCheckpoint(version)).toBe(false);
  }
  for (const version of ["1.4.4", "1.4.4-canary", "1.4.4-canary.1", "1.5.0"]) expect(supportsFrameCheckpoint(version)).toBe(true);
});

const frameTest = supportsFrameCheckpoint() ? test : test.skip;
frameTest("frame snapshots preserve timestamps, checkpoints, cancellation and disposal", () => {
  let now = 0, nextWake = 0;
  const pending = new Map(), events = [], timestamps = [], errors = [];
  const timers = {
    schedule(callback, delay, repeat, timerTask) {
      expect([repeat, timerTask]).toEqual([false, false]);
      pending.set(++nextWake, { callback, delay });
      return nextWake;
    },
    cancel(id) { pending.delete(id); },
    dispose() { pending.clear(); },
  };
  const fire = () => {
    const [id, entry] = pending.entries().next().value;
    pending.delete(id); now += entry.delay; entry.callback();
  };
  const frames = createAnimationFrames({ now: () => now, frameTimers: timers,
    invoke(callback, time) { try { callback(time); } catch (error) { errors.push(error.message); } },
  });
  let cancelled;
  frames.request(time => {
    timestamps.push(time); events.push("first"); now += 40;
    Promise.resolve().then(() => events.push("microtask-one")).then(() => {
      events.push("microtask-two"); frames.cancel(cancelled);
      frames.request(time => {
        events.push("nested"); timestamps.push(time);
        Promise.resolve().then(() => frames.dispose());
      });
      frames.request(() => events.push("disposed"));
    });
  });
  cancelled = frames.request(() => events.push("cancelled"));
  frames.request(time => { timestamps.push(time); throw new Error("expected"); });
  frames.request(time => { events.push("last"); timestamps.push(time); });
  expect(pending.size).toBe(1); fire();
  expect(events).toEqual(["first", "microtask-one", "microtask-two", "last"]);
  expect(timestamps).toEqual([16, 16, 16]);
  expect(errors).toEqual(["expected"]);
  expect(pending.size).toBe(1); fire();
  expect(events.at(-1)).toBe("nested");
  expect(timestamps.at(-1)).toBe(56);
  expect(pending.size).toBe(0);
});

test("actual SES frame callbacks match the browser callback order and lifecycle", async () => {
  const child = Bun.spawn([process.execPath, new URL("./fixtures/animation-frames.js", import.meta.url).pathname], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, error }).toEqual({ code: 0, error: "" });
  expect(out).toContain("animation frame ordering and lifecycle passed");
}, 15000);
