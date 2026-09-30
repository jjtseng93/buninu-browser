import { expect, test } from "bun:test";
import { connect } from "node:net";
import { floatToS16, PulseClient } from "../lib/audio/pulse-client.js";

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

test("connecting without a server fails with an error, not a hang", async () => {
  await expect(PulseClient.connect({ port: 1 })).rejects.toThrow();
});
