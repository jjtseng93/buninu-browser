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
