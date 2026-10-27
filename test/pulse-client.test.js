import { expect, test } from "bun:test";
import { connect } from "node:net";
import { floatToS16, PulseClient } from "../lib/audio/pulse-client.js";
import { splitSamples } from "../lib/audio/pcm.js";

// The playback test needs a PulseAudio native-protocol server (jspulse, or a
// daemon with module-native-protocol-tcp) on 127.0.0.1:4713; without one it is skipped.
const serverRunning = await new Promise((resolve) => {
  const socket = connect({ host: "127.0.0.1", port: 4713 });
  const done = (running) => {
    socket.destroy();
    resolve(running);
  };
  socket.once("connect", () => done(true));
  socket.once("error", () => done(false));
  setTimeout(() => done(false), 1000);
});

test("floatToS16 clamps and scales interleaved samples to s16le", () => {
  const bytes = floatToS16(new Float32Array([0, 1, -1, 2, 0.5]));
  expect([...new Int16Array(bytes.buffer)]).toEqual([0, 32767, -32768, 32767, 16384]);
});

test("small audio requests consume only whole frames and preserve the remainder", () => {
  const original = Float32Array.from({ length: 2048 }, (_, index) => index / 2048);
  let pending = original;
  const sent = [];
  for (const bytes of [4, 80, 3840, 172]) {
    const [part, rest] = splitSamples(pending, 2, bytes);
    expect(part.length * 2).toBeLessThanOrEqual(bytes);
    expect(part.length % 2).toBe(0);
    sent.push(part);
    pending = rest;
  }
  expect([...sent.flatMap((part) => [...part]), ...pending]).toEqual([...original]);
});

test.skipIf(!serverRunning)("plays a stream through the PulseAudio server on 127.0.0.1:4713", async () => {
  const client = await PulseClient.connect();
  const requests = [];
  const stream = await client.openPlayback({ rate: 44100, channels: 2, onRequest: (bytes) => requests.push(bytes) });
  expect(requests[0]).toBeGreaterThan(0);
  stream.write(floatToS16(new Float32Array(44100 * 2 / 10))); // 0.1 s of stereo silence
  await stream.finish();
  expect(stream.killed).toBe(true);
  client.close();
});

test.skipIf(!serverRunning)("opens independent playback streams at different sample rates", async () => {
  const client = await PulseClient.connect();
  const first = await client.openPlayback({ rate: 48000, channels: 1, name: "first" });
  const second = await client.openPlayback({ rate: 44100, channels: 2, name: "second" });
  expect(first.index).not.toBe(second.index);
  await second.close();
  await first.close();
  client.close();
});

test("connecting without a server fails with an error, not a hang", async () => {
  await expect(PulseClient.connect({ port: 1 })).rejects.toThrow();
});

test("audio is sent in whole frames, so stereo channels never swap", async () => {
  // A minimal server: replies to every command, grants odd-sized requests, records audio frame sizes.
  const sizes = [];
  const offsets = [];
  const flags = [];
  const bufferAttributes = [];
  let nextStreamIndex = 1;
  const { createServer } = await import("node:net");
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    const reply = (tag, extra = []) => {
      const body = Buffer.from([0x4c, 0, 0, 0, 2, 0x4c, ...u32(tag), ...extra]);
      socket.write(Buffer.concat([header(body.length, 0xffffffff), body]));
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 20 && buffer.length >= 20 + buffer.readUInt32BE(0)) {
        const length = buffer.readUInt32BE(0);
        const channel = buffer.readUInt32BE(4);
        const offset = buffer.readBigInt64BE(8);
        const flag = buffer.readUInt32BE(16);
        const body = buffer.subarray(20, 20 + length);
        buffer = buffer.subarray(20 + length);
        if (channel !== 0xffffffff) {
          sizes.push(length);
          offsets.push(offset);
          flags.push(flag);
          continue;
        }
        const command = body.readUInt32BE(1);
        const tag = body.readUInt32BE(6);
        if (command === 3) {
          const nameEnd = body.indexOf(0, 11);
          const channelCount = body[nameEnd + 3];
          const attrs = nameEnd + 1 + 7 + 2 + channelCount + 5 + 1 + 5 + 1;
          bufferAttributes.push([0, 1, 2].map((index) => body.readUInt32BE(attrs + index * 5 + 1)));
          reply(tag, [0x4c, ...u32(nextStreamIndex++), 0x4c, ...u32(1), 0x4c, ...u32(96003)]); // odd request, enough for several packets
        }
        else reply(tag);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = await PulseClient.connect({ port: server.address().port });
  const stream = await client.openPlayback({ rate: 48000, channels: 2 });
  stream.write(new Uint8Array(4 * 24000));
  await Bun.sleep(100);
  expect(sizes.length).toBeGreaterThan(1);
  expect(sizes.every((size) => size % 4 === 0)).toBeTrue();
  expect(offsets.every((offset) => offset === 0n)).toBeTrue();
  expect(flags.every((flag) => flag === 0)).toBeTrue();
  // What the server holds, which it may still play after the stream closes.
  expect(stream.sentBytes).toBe(sizes.reduce((sum, size) => sum + size, 0));
  expect(bufferAttributes[0]).toEqual([76800, 15360, 7680]); // 400/80/40 ms at 48 kHz stereo
  await client.openPlayback({ rate: 48000, channels: 1, leadSeconds: 0.12 });
  expect(bufferAttributes[1]).toEqual([15360, 3840, 3840]); // 160/40/40 ms at 48 kHz mono
  client.close();
  server.close();
});

function u32(value) {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function header(length, channel) {
  const out = Buffer.alloc(20);
  out.writeUInt32BE(length, 0);
  out.writeUInt32BE(channel, 4);
  return out;
}

test("measured device progress governs the media clock and bounded audio queue through starvation", async () => {
  const { createServer } = await import("node:net");
  let received = 0, played = 0, reports = 0;
  const times = [], errors = [], requests = [];
  // The suite also runs CPU-heavy renderers in parallel. Observe protocol
  // progress instead of assuming a polling timer ran within 120 ms.
  const waitFor = async predicate => {
    const deadline = Date.now() + 2000;
    while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
    expect(predicate()).toBe(true);
  };
  const scalar64 = (tag, value) => {
    const bytes = Buffer.alloc(9);
    bytes[0] = tag;
    bytes.writeBigInt64BE(BigInt(value), 1);
    return bytes;
  };
  const server = createServer(socket => {
    let input = Buffer.alloc(0);
    socket.on("data", chunk => {
      input = Buffer.concat([input, chunk]);
      while (input.length >= 20 && input.length >= 20 + input.readUInt32BE(0)) {
        const length = input.readUInt32BE(0), channel = input.readUInt32BE(4);
        const body = input.subarray(20, 20 + length);
        input = input.subarray(20 + length);
        if (channel !== 0xffffffff) { received += length; continue; }
        const command = body.readUInt32BE(1), tag = body.readUInt32BE(6);
        let extra = Buffer.alloc(0);
        if (command === 3) extra = Buffer.from([0x4c, ...u32(1), 0x4c, ...u32(1), 0x4c, ...u32(1e7)]);
        if (command === 14) {
          reports++;
          expect(body[15]).toBe(0x54); // timestamp request, protocol v8
          const timeval = Buffer.from([0x54, ...u32(1), ...u32(0)]);
          // Everything has reached the backend, but the device still holds
          // received-played bytes. REQUEST credits are deliberately unrelated.
          extra = Buffer.concat([scalar64(0x55, (received - played) * 1000), scalar64(0x55, 0),
            Buffer.from([0x31]), timeval, timeval, scalar64(0x72, received), scalar64(0x72, received)]);
        }
        const reply = Buffer.concat([Buffer.from([0x4c, ...u32(2), 0x4c, ...u32(tag)]), extra]);
        socket.write(Buffer.concat([header(reply.length, 0xffffffff), reply]));
      }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = await PulseClient.connect({ port: server.address().port });
  try {
    const stream = await client.openPlayback({ rate: 500, channels: 1,
      onRequest: bytes => requests.push(bytes),
      onTiming: timing => times.push(timing.seconds), onTimingError: error => errors.push(error) });
    expect(requests).toEqual([2000]); // controller reserve, not the device queue
    stream.write(new Uint8Array(100));
    await Bun.sleep(80);
    expect(received).toBe(0); // a short prefix does not start/stop playback
    stream.write(new Uint8Array(1900));
    await waitFor(() => reports > 0 && received === 500 && times.length > 0);
    expect(reports).toBeGreaterThan(0);
    expect(received).toBe(500); // at most the 0.5 s queue budget, not 2 s
    expect(stream.queued).toBe(1500); // survives a renderer busy spell in the controller
    expect(times.at(-1)).toBe(0); // server/device hasn't played anything
    played = 100;
    await waitFor(() => times.at(-1) === 0.1 && received === 600);
    expect(times.at(-1)).toBeCloseTo(0.1, 5);
    expect(received).toBe(600);
    // A long network/producer pause is NOT permission to catch up by queuing seconds.
    await Bun.sleep(180);
    expect(times.at(-1)).toBeCloseTo(0.1, 5);
    expect(received).toBe(600);
    played = 600;
    await waitFor(() => times.at(-1) === 0.6 && received > 1000);
    expect(times.at(-1)).toBeCloseTo(0.6, 5);
    expect(received).toBeGreaterThan(1000);
    expect(received).toBeLessThanOrEqual(1100);
    // No more PCM is provided by the producer: continue from the local reserve.
    for (let i = 0; i < 4; i++) {
      played = received;
      await Bun.sleep(150);
    }
    expect(received).toBeGreaterThan(1500);
    expect(received).toBeLessThanOrEqual(2000);
    expect(requests.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(4000);
    expect(errors).toEqual([]);
    await stream.close();
    expect(stream.queued).toBe(0); // pause/seek discards reserve; no extra device tail
  } finally {
    client.close();
    await new Promise(resolve => server.close(resolve));
  }
});

// Keep the real connection/open/close path, but drive only the playback
// intervals with a virtual monotonic clock. Latency responses are controlled
// at the client boundary; the test above covers their wire representation.
async function playbackTimers(run) {
  const { createServer } = await import("node:net");
  const server = createServer(socket => {
    let input = Buffer.alloc(0);
    socket.on("data", chunk => {
      input = Buffer.concat([input, chunk]);
      while (input.length >= 20 && input.length >= 20 + input.readUInt32BE(0)) {
        const length = input.readUInt32BE(0), channel = input.readUInt32BE(4);
        const body = input.subarray(20, 20 + length);
        input = input.subarray(20 + length);
        if (channel !== 0xffffffff) continue;
        const command = body.readUInt32BE(1), tag = body.readUInt32BE(6);
        const extra = command === 3 ? [0x4c, ...u32(1), 0x4c, ...u32(1), 0x4c, ...u32(1e7)] : [];
        const reply = Buffer.from([0x4c, ...u32(2), 0x4c, ...u32(tag), ...extra]);
        socket.write(Buffer.concat([header(reply.length, 0xffffffff), reply]));
      }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let client, now = 0;
  const intervals = new Map(), sent = [];
  const originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval;
  const originalNow = performance.now;
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  try {
    client = await PulseClient.connect({ port: server.address().port });
    client.writeAudio = (index, bytes) => sent.push({ at: now, bytes: bytes.length });
    globalThis.setInterval = (callback, delay) => {
      const token = {};
      intervals.set(token, { callback, delay, at: now + delay });
      return token;
    };
    globalThis.clearInterval = token => {
      if (!intervals.delete(token)) originalClear(token);
    };
    performance.now = () => now;
    const advance = async duration => {
      const end = now + duration;
      for (;;) {
        const next = [...intervals.values()].sort((a, b) => a.at - b.at)[0];
        if (!next || next.at > end) break;
        now = next.at;
        next.at += next.delay;
        next.callback();
        await flush();
      }
      now = end;
      await flush();
    };
    await run({ client, intervals, sent, advance, flush, now: () => now });
  } finally {
    client?.close();
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
    performance.now = originalNow;
    await new Promise(resolve => server.close(resolve));
  }
}

test("16 ms measured timing leaves PCM on its 50 ms cadence and holds a stale device clock", async () => {
  await playbackTimers(async ({ client, intervals, sent, advance, now }) => {
    const requests = [], times = [], polls = [];
    let stalled = false, lastPlayed = 0;
    const totalSent = () => sent.reduce((sum, packet) => sum + packet.bytes, 0);
    client.playbackTiming = () => {
      polls.push(now());
      if (!stalled) lastPlayed = Math.min(now(), totalSent());
      return { writeIndex: totalSent(), readIndex: totalSent(),
        sinkSeconds: (totalSent() - lastPlayed) / 1000, playing: true };
    };
    const stream = await client.openPlayback({ rate: 500, channels: 1,
      onRequest: bytes => requests.push(bytes), onTiming: timing => times.push(timing.seconds) });
    expect([...intervals.values()].map(timer => timer.delay).sort((a, b) => a - b)).toEqual([16, 50]);
    stream.write(new Uint8Array(2000));
    expect(totalSent()).toBe(500);
    await advance(49);
    expect(polls).toEqual([16, 32, 48]);
    expect(times.at(-1)).toBeCloseTo(0.048, 6);
    expect(totalSent()).toBe(500); // timing callbacks do not send PCM
    await advance(51);
    expect(polls).toEqual([16, 32, 48, 64, 80, 96]);
    expect(sent.every(packet => packet.at === 0 || packet.at === 50 || packet.at === 100)).toBe(true);
    expect(totalSent()).toBe(596); // only the measured 96 ms has replenished the budget
    expect(totalSent() - lastPlayed).toBe(500);
    stalled = true;
    await advance(1000);
    expect(times.at(-1)).toBeCloseTo(0.096, 6);
    expect(totalSent()).toBe(596); // neither wall time nor more queries invent progress
    expect(requests.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(2600);
    stream.kill();
    expect(intervals.size).toBe(0);
    const count = polls.length;
    await advance(1000);
    expect(polls).toHaveLength(count);
    expect(stream.queued).toBe(0);
  });
});

test("slow timing responses stay single-flight and a reply after kill cannot publish or restart polling", async () => {
  await playbackTimers(async ({ client, intervals, advance, flush }) => {
    let calls = 0, resolve;
    const times = [], errors = [];
    client.playbackTiming = () => { calls++; return new Promise(done => { resolve = done; }); };
    const stream = await client.openPlayback({ rate: 500, channels: 1,
      onTiming: value => times.push(value), onTimingError: error => errors.push(error) });
    stream.write(new Uint8Array(2000));
    await advance(160);
    expect(calls).toBe(1);
    expect(times).toEqual([]);
    resolve({ writeIndex: 500, readIndex: 500, sinkSeconds: 0.4, playing: true });
    await flush();
    expect(times.map(value => value.seconds)).toEqual([0.1]);
    await advance(160);
    expect(calls).toBe(2);
    stream.kill();
    expect(intervals.size).toBe(0);
    resolve({ writeIndex: 600, readIndex: 600, sinkSeconds: 0, playing: true });
    await flush();
    await advance(160);
    expect(calls).toBe(2);
    expect(times.map(value => value.seconds)).toEqual([0.1]);
    expect(errors).toEqual([]);
  });
});

test("streams without a timing consumer keep only the PCM pacing timer", async () => {
  await playbackTimers(async ({ client, intervals, advance }) => {
    let polls = 0;
    client.playbackTiming = () => { polls++; throw Error("unexpected timing query"); };
    const stream = await client.openPlayback({ rate: 500, channels: 1 });
    expect([...intervals.values()].map(timer => timer.delay)).toEqual([50]);
    await advance(1000);
    expect(polls).toBe(0);
    await stream.close();
    expect(intervals.size).toBe(0);
  });
});

test("timing rejection permits a retry and a late rejection after kill stays silent", async () => {
  await playbackTimers(async ({ client, advance, flush }) => {
    const pending = [], errors = [], times = [];
    client.playbackTiming = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
    const stream = await client.openPlayback({ rate: 500, channels: 1,
      onTiming: value => times.push(value), onTimingError: error => errors.push(error.message) });
    stream.write(new Uint8Array(2000));
    await advance(160);
    expect(pending).toHaveLength(1);
    pending[0].reject(Error("pulse: timing request timed out"));
    await flush();
    expect(errors).toEqual(["pulse: timing request timed out"]);
    await advance(16);
    expect(pending).toHaveLength(2);
    stream.kill();
    pending[1].reject(Error("late timeout"));
    await flush();
    await advance(160);
    expect(pending).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(times).toEqual([]);
  });
});
