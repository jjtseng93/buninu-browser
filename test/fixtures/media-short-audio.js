// Exercise the renderer and independent decoder worker with real tracks of different lengths.
import assert from 'node:assert/strict';
import { createPageRenderer } from '../../lib/renderer/page-renderer.js';
import { startVideoChannel } from '../../lib/renderer/video-channel.js';
import wasmpeg from '../../vendor/wasmpeg/src/js/index.js';

await wasmpeg.load();
const video = await Bun.file(new URL('long-video.mp4', import.meta.url)).bytes();
const audio = await Bun.file(new URL('tone.mp3', import.meta.url)).bytes();
const videoInfo = await wasmpeg.probe(video), audioInfo = await wasmpeg.probe(audio);
const tracks = {
  probe: async () => ({ ...videoInfo, audio: audioInfo.audio, streams: [...videoInfo.streams, ...audioInfo.streams] }),
  decode: (...args) => wasmpeg.decode(...args),
  decodeAudio: () => wasmpeg.decodeAudio(audio),
};
const outputs = [], bindings = [], errors = [];
let renderer;
const channel = await startVideoChannel(() => {}, report => renderer.videoReport(report));
renderer = await createPageRenderer({
  onFrame() {}, videoDecoder: tracks, reportError: error => errors.push(String(error)),
  fetchResource: async () => ({ ok: true, body: video, contentType: 'video/mp4' }),
  onVideo(message) {
    if (message.type === 'video-open') channel.open(message);
    if (message.type === 'video-stop') channel.stop(message.id);
    if (message.type === 'video-bind') {
      bindings.push(message);
      channel.bind(message.id, message.audioId, message.audioStart, message.time, message.endTime, message.hasAudio);
    }
  },
  audio: {
    open(options, send) { return outputs.push({ ...options, send, bytes: 0, finished: false }); },
    write(id, pcm) { outputs[id - 1].bytes += pcm.byteLength; },
    finish(id) { outputs[id - 1].finished = true; },
    close() { return 0; },
  },
});
const ev = code => renderer.evaluate(code);
async function until(condition, description) {
  for (let i = 0; i < 300; i++) {
    if (await condition()) return;
    await Bun.sleep(10);
  }
  throw Error(description + ': ' + JSON.stringify({ frame: channel.frame?.time, errors, bindings }));
}
try {
  renderer.resize(240, 180, 1);
  renderer.setScripting('host');
  await renderer.loadDocument({ url: 'https://short-audio.test/', contentType: 'text/html',
    source: '<video id="v" src="clip.mp4" width="128" height="96"></video>' });
  await renderer.whenLoaded();
  await ev('globalThis.v = document.getElementById("v"); v.play()');
  await until(() => outputs.length === 1, 'open first output');
  const device = outputs[0];
  device.send({ event: 'request', bytes: 262144 });
  await until(() => device.finished && channel.frame, 'decode first picture and queue final audio');
  const audioEnd = device.bytes / (2 * device.channels * device.rate);
  assert(audioEnd > 0 && audioEnd < videoInfo.duration);
  channel.timing(1, audioEnd / 2);
  device.send({ event: 'timing', seconds: audioEnd / 2 });
  device.send({ event: 'ended' }); // drain can arrive after the last periodic timing sample
  assert.equal(bindings.at(-1).hasAudio, false);
  assert.equal(bindings.at(-1).time, audioEnd);
  await until(() => channel.frame?.time >= audioEnd + 0.25, 'present frames in the silent tail');

  const oldId = channel.config.id;
  await ev('v.style.display = "none"');
  await until(() => !channel.config, 'hide video layer');
  await ev('v.style.display = "block"');
  await until(() => channel.config && channel.config.id !== oldId, 'recreate video layer');
  assert.equal(channel.config.hasAudio, false);

  await ev('v.currentTime = 4');
  await until(() => channel.frame?.time >= 4.25, 'seek into tail and keep presenting');
  assert.equal(outputs.length, 1);
  await ev('v.currentTime = 0.25');
  await until(() => outputs.length === 2, 'seek back into audio reopens output');
  device.send({ event: 'ended' }); // stale drain from the retired output
  outputs[1].send({ event: 'request', bytes: 262144 });
  await until(() => outputs[1].finished, 'replay the remaining PCM');
  assert(outputs[1].bytes > 0 && outputs[1].bytes < device.bytes);
  outputs[1].send({ event: 'ended' });
  assert.equal(bindings.at(-1).time, audioEnd, 'after seek the drain cursor is absolute');
  await ev('v.currentTime = v.duration - 0.5');
  await until(() => ev('v.ended'), 'the video ends after its silent tail');
  await ev('v.play()');
  await until(() => outputs.length === 3, 'replaying an ended video restores audio');
  assert.equal(await ev('v.currentTime'), 0);
  assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ pass: true }) + '\n');
} finally {
  renderer.dispose();
  channel.stop();
  channel.worker.terminate();
}
