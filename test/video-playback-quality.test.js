import { beforeAll, afterAll, expect, test } from 'bun:test';
import { RendererHost } from '../lib/renderer/host.js';
import { VideoPresentation } from '../lib/renderer/video-presentation.js';
import { createVideoQualityCounters, readVideoQuality } from '../lib/media/video-quality.js';

let host;
beforeAll(async () => { host = new RendererHost({ timeout: 20000 }); await host.start(); });
afterAll(() => host?.close());

test('VideoPlaybackQuality has branded readonly snapshots and empty video counters', async () => {
  await host.call('loadDocument', { url: 'https://quality.test/', contentType: 'text/html', source: '<!doctype html><video></video><audio></audio>' });
  await host.call('whenLoaded');
  const result = JSON.parse(await host.call('evaluate', `JSON.stringify((() => {
    const video = document.querySelector('video'), before = performance.now();
    const q = video.getVideoPlaybackQuality(), after = performance.now();
    const failures = [];
    for (const action of [() => new VideoPlaybackQuality(), () => VideoPlaybackQuality(),
      () => video.getVideoPlaybackQuality.call(document.querySelector('audio')),
      () => video.getVideoPlaybackQuality.call(document.createElementNS('http://www.w3.org/2000/svg','VIDEO')),
      () => Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'webkitDecodedFrameCount').get.call(document.createElementNS('urn:test','VIDEO')),
      () => Object.getOwnPropertyDescriptor(VideoPlaybackQuality.prototype, 'totalVideoFrames').get.call({}),
      () => Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'webkitDecodedFrameCount').get.call({}),
      () => new video.getVideoPlaybackQuality()]) {
      try { action(); failures.push('accepted'); } catch (e) { failures.push(e instanceof TypeError); }
    }
    const fields = ['creationTime','totalVideoFrames','droppedVideoFrames','corruptedVideoFrames'];
    const readonly = fields.every(key => { const d = Object.getOwnPropertyDescriptor(VideoPlaybackQuality.prototype, key); return d.get && !d.set && d.enumerable && d.configurable; });
    q.totalVideoFrames = 99;
    return { counts: [q.totalVideoFrames,q.droppedVideoFrames,q.corruptedVideoFrames,video.webkitDecodedFrameCount,video.webkitDroppedFrameCount],
      timestamp: before <= q.creationTime && q.creationTime <= after,
      shape: [q instanceof VideoPlaybackQuality, Object.prototype.toString.call(q), Object.keys(q).length,
        Object.getPrototypeOf(VideoPlaybackQuality.prototype) === Object.prototype,
        Object.getPrototypeOf(video.getVideoPlaybackQuality) === Function.prototype,
        q !== video.getVideoPlaybackQuality(), 'getVideoPlaybackQuality' in document.querySelector('audio')],
      failures, readonly };
  })())`));
  expect(result).toEqual({ counts: [0,0,0,0,0], timestamp: true,
    shape: [true,'[object VideoPlaybackQuality]',0,true,true,true,false], failures: [true,true,true,true,true,true,true,true], readonly: true });
});

test('worker counts decoded frames and only genuinely superseded ready frames as dropped', async () => {
  const quality = createVideoQualityCounters();
  let at = 0;
  const engine = { decode: async () => ({ width: 2, height: 2, fps: 10,
    nextFrame(w,h) { at++; return new Uint8Array(w*h*4); }, close() {} }) };
  const video = new VideoPresentation(engine, () => {}, () => {});
  try {
    await video.open({ id: 1, time: 0, hasAudio: true, audioId: 1, audioStart: 0, quality });
    clearTimeout(video.timer);
    const decoded = at;
    expect(readVideoQuality(quality)).toEqual({ totalVideoFrames: decoded, droppedVideoFrames: 0, corruptedVideoFrames: 0 });
    const due = video.queue.filter(frame => frame.time <= 0.5 + 1e-6).length;
    video.timing(1, 0.5);
    expect(readVideoQuality(quality).droppedVideoFrames).toBe(due - 1);
    const frozen = readVideoQuality(quality);
    video.timing(1, 0.5); video.present(0.5); video.stop();
    expect(readVideoQuality(quality)).toEqual(frozen);
    // A new decoder for the same media resource does not reset its totals.
    await video.open({ id: 2, time: 0, hasAudio: true, audioId: 2, audioStart: 0, quality });
    clearTimeout(video.timer);
    expect(readVideoQuality(quality).totalVideoFrames).toBeGreaterThan(frozen.totalVideoFrames);
    expect(readVideoQuality(createVideoQualityCounters()).totalVideoFrames).toBe(0);
  } finally { video.stop(); }
});

test('keyframe verification and replayed seek prefixes are excluded from playback counts', async () => {
  const quality = createVideoQualityCounters(), calls = [];
  let at = 0;
  const engine = { decode: async () => ({ width: 2, height: 2, fps: 10,
    seek(ms) { at = Math.floor(ms / 1000) * 10; },
    nextFrame(w,h) { calls.push({ w,h,at }); return new Uint8Array(w*h*4).fill(++at); }, close() {} }) };
  const video = new VideoPresentation(engine, () => {}, () => {});
  try {
    await video.open({ id: 3, time: 2.5, hasAudio: true, audioId: 3, audioStart: 2.5, quality });
    clearTimeout(video.timer);
    expect(calls.some(c => c.w === 32)).toBe(true);
    expect(calls.some(c => c.w === 1)).toBe(true);
    expect(readVideoQuality(quality).totalVideoFrames).toBe(calls.filter(c => c.w === 2).length);
    expect(readVideoQuality(quality).droppedVideoFrames).toBe(0);
  } finally { video.stop(); }
});

test('independent decoder counts a pending picture overwritten before compositor delivery', async () => {
  const worker = new Worker(new URL('../lib/renderer/video-worker.js', import.meta.url).href);
  const quality = createVideoQualityCounters(), frames = [], reports = [];
  let ready = false, error;
  worker.addEventListener('message', ({data}) => {
    if (data.type === 'ready') ready = true;
    if (data.type === 'frame') frames.push(data);
    if (data.type === 'report') reports.push(data.report);
  });
  worker.addEventListener('error', value => { error = value; });
  const until = async predicate => {
    for (let i = 0; i < 300; i++) {
      if (error) throw error;
      if (predicate()) return;
      await Bun.sleep(10);
    }
    throw Error('video worker did not progress');
  };
  try {
    await until(() => ready);
    // This fixture is 4 FPS: each clock update makes exactly one frame due.
    const bytes = await Bun.file(new URL('./fixtures/long-video.mp4', import.meta.url)).bytes();
    worker.postMessage({type:'open', config:{id:1,bytes,time:0,hasAudio:true,audioId:2,audioStart:0,quality,
      shared:new SharedArrayBuffer(16 + 480 * 480 * 4)}});
    await until(() => frames.length === 1);
    worker.postMessage({type:'timing', id:2, seconds:.25});
    await until(() => reports.some(report => report.time === .25));
    expect(readVideoQuality(quality).droppedVideoFrames).toBe(0);
    worker.postMessage({type:'timing', id:2, seconds:.5});
    await until(() => reports.some(report => report.time === .5));
    expect(readVideoQuality(quality).droppedVideoFrames).toBe(1);
    expect(readVideoQuality(quality).totalVideoFrames).toBeGreaterThanOrEqual(3);
    expect(frames).toHaveLength(1);
    worker.postMessage({type:'frame-ack', id:1, delivery:frames[0].delivery});
    await until(() => frames.length === 2);
    expect(frames[1].frame.time).toBe(.5);
    expect(readVideoQuality(quality).droppedVideoFrames).toBe(1);
    worker.postMessage({type:'timing', id:2, seconds:.5});
    worker.postMessage({type:'stop', id:1});
    await Bun.sleep(30);
    expect(readVideoQuality(quality).droppedVideoFrames).toBe(1);
    expect(reports.some(report => report.error)).toBe(false);
  } finally { worker.terminate(); }
}, 15000);

for (const source of ['file', 'mse']) test(`${source} playback reports real drops, retains snapshots across seeks and resets resources`, async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/video-playback-quality.js', import.meta.url).pathname, source], { stdout: 'pipe', stderr: 'pipe' });
  try {
    const [out,error,code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    expect({code,error}).toEqual({code:0,error:''});
    expect(out).toContain('video playback quality passed');
  } finally { child.kill(); }
}, 15000);
