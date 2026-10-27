import { test, expect } from "bun:test";
import { cropViewport, rawFrame } from "../lib/paint/frame.js";
import { VideoPresentation, compositeVideo } from "../lib/renderer/video-presentation.js";
import wasmpeg from "../vendor/wasmpeg/src/js/index.js";

test("video predecode is bounded and waits for measured audio, skipping stale frames", async () => {
  let frames = 0, closed = 0;
  const reports = [];
  const engine = { decode: async () => ({ width: 2, height: 2, fps: 30,
    nextFrame: () => { frames++; return new Uint8Array(16).fill(frames); }, close: () => closed++ }) };
  const video = new VideoPresentation(engine, () => {}, r => reports.push(r));
  try {
    await video.open({ id: 1, time: 0, hasAudio: true, audioId: 4, audioStart: 0 });
    await Bun.sleep(100);
    expect(frames).toBeLessThanOrEqual(24);
    expect(video.queue.length).toBeLessThanOrEqual(video.limit);
    expect(video.frame.time).toBe(0);
    const first = reports.length;
    await Bun.sleep(80);
    expect(reports).toHaveLength(first);
    video.timing(4, 0.5);
    await Bun.sleep(60);
    expect(video.frame.time).toBeCloseTo(0.5);
    expect(reports.filter(r => r.time > 0).length).toBe(1);
    video.stop(1);
    video.timing(4, 2);
    await Bun.sleep(30);
    expect(video.frame).toBeNull();
    expect(closed).toBe(1);
  } finally { video.stop(); }
});

test("a late decoder open cannot replace a newer playback generation", async () => {
  let resolve, closed = 0;
  const video = new VideoPresentation({ decode: () => new Promise(r => resolve = r) }, () => {}, () => {});
  const opening = video.open({ id: 1, time: 0 });
  video.stop();
  resolve({ close: () => closed++ });
  await opening;
  expect(closed).toBe(1);
  expect(video.config).toBeNull();
});

test("queued timing after a synchronous decoder open is read before seeking", async () => {
  let at = 0;
  const seeks = [];
  const video = new VideoPresentation({ decode: () => {
    // Like a worker timing message queued while WASM is opening: this task
    // runs after decode's await continuation, before the resumed seek.
    setTimeout(() => video.timing(14, 3), 0);
    return { width: 2, height: 2, fps: 10,
      seek(ms) { seeks.push(ms); at = Math.floor(ms / 1000); },
      nextFrame(w, h) { const pixels = new Uint8Array(w * h * 4).fill(Math.floor(at) + 1); at += 0.1; return pixels; },
      close() {} };
  } }, () => {}, () => {});
  try {
    video.timing(14, 0);
    await video.open({ id: 8, time: 10, startTime: 10, endTime: 20,
      hasAudio: true, audioId: 14, audioStart: 10 });
    expect(seeks[0]).toBe(13000);
    expect(video.resumeTime).toBe(13);
    expect(video.frame.time).toBeCloseTo(13);
  } finally { video.stop(); }
});

test("stopping during the post-open task closes the decoder without seeking or publishing", async () => {
  let closed = 0, sought = 0, decoded = 0, changed = 0;
  const reports = [];
  const video = new VideoPresentation({ decode: () => {
    setTimeout(() => video.stop(), 0);
    return { width: 2, height: 2, fps: 10,
      seek() { sought++; }, nextFrame() { decoded++; return new Uint8Array(16); }, close() { closed++; } };
  } }, () => changed++, report => reports.push(report));
  try {
    await video.open({ id: 9, time: 10, startTime: 0, hasAudio: true });
    expect(closed).toBe(1);
    expect(sought).toBe(0);
    expect(decoded).toBe(0);
    expect(changed).toBe(0);
    expect(reports).toEqual([]);
    expect(video.config).toBeNull();
    expect(video.decoder).toBeNull();
  } finally { video.stop(); }
});

test("a delayed snapshot open seeks against audio progress without resetting its clock", async () => {
  let finish, at = 0;
  const seeks = [], reports = [];
  const video = new VideoPresentation({ decode: () => new Promise(resolve => { finish = resolve; }) },
    () => {}, report => reports.push(report));
  try {
    video.timing(12, 0);
    const opening = video.open({ id: 6, time: 10, startTime: 10, endTime: 20,
      hasAudio: true, audioId: 12, audioStart: 10 });
    video.timing(12, 4);
    finish({ width: 2, height: 2, fps: 10,
      seek(ms) { seeks.push(ms); at = Math.floor(ms / 1000); },
      nextFrame(w, h) { const pixels = new Uint8Array(w * h * 4).fill(Math.floor(at) + 1); at += 0.1; return pixels; },
      close() {} });
    await opening;
    expect(seeks[0]).toBe(14000);
    expect(video.resumeTime).toBe(14);
    expect(video.config.time).toBe(10);
    expect(video.time()).toBe(14);
    expect(video.frame.time).toBeCloseTo(14);
    expect(reports.filter(report => report.time !== undefined).every(report => report.time >= 13.9)).toBe(true);
  } finally { video.stop(); }
});

test("a delayed open that has passed its epoch reports the boundary without decoding obsolete frames", async () => {
  let finish, decoded = 0, sought = 0;
  const reports = [];
  const video = new VideoPresentation({ decode: () => new Promise(resolve => { finish = resolve; }) },
    () => {}, report => reports.push(report));
  try {
    video.timing(13, 0);
    const opening = video.open({ id: 7, time: 10, startTime: 10, endTime: 12,
      hasAudio: true, audioId: 13, audioStart: 10 });
    video.timing(13, 3);
    finish({ width: 2, height: 2, fps: 10,
      seek() { sought++; }, nextFrame() { decoded++; return new Uint8Array(16); }, close() {} });
    await opening;
    expect(video.resumeTime).toBe(12);
    expect(sought).toBe(0);
    expect(decoded).toBe(0);
    expect(reports).toEqual([{ id: 7, end: 12 }]);
  } finally { video.stop(); }
});

test("reopening at a keyframe does not show the prefix before the resume position", async () => {
  let at = 0;
  const reports = [];
  const video = new VideoPresentation({ decode: async () => ({ width: 2, height: 2, fps: 10,
    seek() { at = 0; }, nextFrame(w, h) { at++; return new Uint8Array(w * h * 4).fill(at); }, close() {} }) },
    () => {}, report => reports.push(report));
  try {
    video.timing(9, 2);
    await video.open({ id: 2, time: 2, hasAudio: true, audioId: 9, audioStart: 0 });
    await Bun.sleep(100);
    expect(reports.some(report => report.time >= 1.9)).toBe(true);
    expect(reports.every(report => report.time === undefined || report.time >= 1.9)).toBe(true);
  } finally { video.stop(); }
});

test("discarded GOP frames use tiny output while the resume boundary keeps full-size pixels", async () => {
  for (const time of [0.5, 0.51]) {
    let at = 0;
    const calls = [];
    const video = new VideoPresentation({ decode: async () => ({ width: 8, height: 4, fps: 4,
      seek() { at = 0; calls.length = 0; },
      nextFrame(w, h) { calls.push([w, h]); return new Uint8Array(w * h * 4).fill(++at); },
      close() {} }) }, () => {}, () => {});
    try {
      video.timing(20, time);
      await video.open({ id: 10, time, hasAudio: true, audioId: 20, audioStart: 0 });
      // The frame ending exactly at 0.5 is discarded, but the frame spanning
      // 0.5–0.75 must keep its full image for both an exact and fractional seek.
      expect(calls.slice(0, 2)).toEqual([[1, 1], [1, 1]]);
      expect(calls.slice(2).length).toBeGreaterThan(0);
      expect(calls.slice(2).every(([w, h]) => w === 8 && h === 4)).toBe(true);
      expect(video.frame.time).toBe(0.5);
      expect(video.frame.pixels[0]).toBe(3);
      for (const frame of [video.frame, ...video.queue]) {
        expect([frame.width, frame.height, frame.pixels.length]).toEqual([8, 4, 128]);
      }
    } finally { video.stop(); }
  }
});

test("real interframe decoders preserve every displayed pixel after tiny GOP-prefix output", async () => {
  await wasmpeg.load();
  for (const [fixture, resume] of [["long-video.mp4", 15.125], ["mse-switch-large.mp4", 3.75]]) {
    const bytes = new Uint8Array(await Bun.file(new URL(`./fixtures/${fixture}`, import.meta.url)).arrayBuffer());
    const run = async fullPrefix => {
      let smallFrames = 0;
      const reports = [];
      const engine = { decode: async () => {
        const decoder = await wasmpeg.decode(bytes);
        return { ...decoder, nextFrame(w, h) {
          if (w === 1 && h === 1) {
            smallFrames++;
            // Reference: retain the old behavior, producing normal-sized
            // RGBA even for frames which the presentation discards.
            if (fullPrefix) return decoder.nextFrame(decoder.width, decoder.height);
          }
          return decoder.nextFrame(w, h);
        } };
      } };
      const video = new VideoPresentation(engine, () => {}, report => reports.push(report));
      const result = [];
      const pump = () => {
        for (let steps = 0; steps < 100 && !video.eof && video.nextTime <= video.time() + 0.75
          && video.queue.length < video.limit; steps++) {
          clearTimeout(video.timer);
          video.step();
        }
        clearTimeout(video.timer);
        expect(video.frame).not.toBeNull();
        for (const frame of [video.frame, ...video.queue]) {
          expect(frame.pixels.length).toBe(frame.width * frame.height * 4);
        }
        result.push([video.frame, ...video.queue]);
      };
      try {
        video.timing(21, resume);
        await video.open({ id: 11, time: resume, hasAudio: true, audioId: 21, audioStart: 0 });
        pump();
        video.timing(21, resume + 0.5);
        pump();
        expect(smallFrames).toBeGreaterThan(0);
        expect(reports.some(report => report.error)).toBe(false);
        return result;
      } finally { video.stop(); }
    };
    expect(await run(false)).toEqual(await run(true));
  }
});

test("a presentation keeps absolute epoch times and ends before replaced frames", async () => {
  let at = 0;
  const seeks = [], reports = [];
  const video = new VideoPresentation({ decode: async () => ({ width: 2, height: 2, fps: 10,
    seek(ms) { seeks.push(ms); at = 0; },
    nextFrame(w, h) { return new Uint8Array(w * h * 4).fill(++at); }, close() {} }) },
    () => {}, report => reports.push(report));
  const tick = seconds => {
    clearTimeout(video.timer);
    video.timing(9, seconds - 12);
    video.step();
  };
  try {
    video.timing(9, 0.2);
    await video.open({ id: 3, time: 12.2, startTime: 12, endTime: 12.5,
      hasAudio: true, audioId: 9, audioStart: 12 });
    expect(Math.min(...seeks)).toBe(12000);
    expect(video.frame.time).toBeCloseTo(12.2);
    expect(reports.some(report => report.end !== undefined)).toBe(false);
    tick(12.49);
    expect(video.frame.time).toBeCloseTo(12.4);
    expect(reports.some(report => report.end !== undefined)).toBe(false);
    tick(12.5);
    tick(13);
    expect(reports.filter(report => report.end !== undefined)).toEqual([{ id: 3, end: 12.5 }]);
    expect(reports.filter(report => report.time !== undefined).every(report => report.time >= 12.2 && report.time < 12.5)).toBe(true);
  } finally { video.stop(); }
});

test("a short epoch snapshot reports its actual EOF so playback can request more bytes", async () => {
  let at = 0;
  const reports = [];
  const video = new VideoPresentation({ decode: async () => ({ width: 2, height: 2, fps: 10,
    seek() { at = 0; },
    nextFrame(w, h) { return ++at <= 2 ? new Uint8Array(w * h * 4).fill(at) : null; }, close() {} }) },
    () => {}, report => reports.push(report));
  try {
    video.timing(10, 0.25);
    await video.open({ id: 4, time: 40, startTime: 40, endTime: 45,
      hasAudio: true, audioId: 10, audioStart: 40 });
    // Audio already passed both frames: request the next snapshot without
    // flashing this obsolete prefix over the previously displayed picture.
    expect(video.frame).toBeNull();
    expect(reports.find(report => report.end !== undefined)?.end).toBeCloseTo(40.2);
  } finally { video.stop(); }
});

test("a later epoch discards queued old frames at its boundary without accepting stale bindings", async () => {
  const reports = [];
  const video = new VideoPresentation({ decode: async () => ({ width: 2, height: 2, fps: 10,
    nextFrame(w, h) { return new Uint8Array(w * h * 4); }, close() {} }) },
    () => {}, report => reports.push(report));
  try {
    video.timing(11, 0);
    await video.open({ id: 5, time: 10, startTime: 10,
      hasAudio: true, audioId: 11, audioStart: 10 });
    expect(video.queue.some(frame => frame.time > 10.3)).toBe(true);
    video.bind(4, 11, 10, 10, 10.1);
    expect(video.config.endTime).toBeUndefined();
    video.bind(5, undefined, undefined, undefined, 10.3);
    expect(video.config.audioId).toBe(11);
    expect(video.config.audioStart).toBe(10);
    expect(video.config.time).toBe(10);
    clearTimeout(video.timer);
    video.timing(11, 0.3);
    video.step();
    expect(video.frame.time).toBeCloseTo(10.2);
    expect(reports.find(report => report.end !== undefined)).toEqual({ id: 5, end: 10.3 });
    expect(video.queue).toHaveLength(0);
  } finally { video.stop(); }
});

test("video layer preserves opaque controls, translucent overlays and clipped pixels", () => {
  const base = new Uint8Array([0,0,0,255, 255,255,255,255, 0,0,128,255, 10,20,30,255]);
  const mask = new Uint8Array([255,255,255,0, 0,0,0,0, 127,127,127,0, 0,0,0,0]);
  const tile = { pixelWidth: 4, pixelHeight: 1, pixels: base,
    videoLayer: { base, mask, rect: { x: 0, y: 0, width: 4, height: 1 } } };
  const frame = { width: 1, height: 1, pixels: new Uint8Array([200,100,0,255]) };
  expect([...compositeVideo(tile, frame).pixels]).toEqual([
    200,100,0,255, 255,255,255,255, 100,50,128,255, 10,20,30,255,
  ]);
  expect(compositeVideo(tile, null)).toBe(tile);
});

test("cached video masks match scalar composition across fractional, clipped and resized layers", () => {
  const base = Uint8Array.from({length: 13 * 9 * 4}, (_, i) => i * 29 % 256);
  const mask = Uint8Array.from(base, (_, i) => i % 7 === 0 ? 127 : i % 3 ? 255 : 0);
  for (let i=0;i<base.length;i+=4) if (i%12===0) {
    base[i]=base[i+1]=base[i+2]=0;
    mask[i]=mask[i+1]=mask[i+2]=255;
  }
  for (const rect of [{x:-2.3,y:1.2,width:12.4,height:5.8},{x:3.2,y:-2.7,width:15,height:13}]) {
    const tile={pixelWidth:13,pixelHeight:9,pixels:base,videoLayer:{base,mask,rect}};
    for (const [w,h] of [[5,3],[5,3],[7,4]]) {
      const frame={width:w,height:h,pixels:Uint8Array.from({length:w*h*4},(_,i)=>i*71%256)};
      const expected=new Uint8Array(base);
      for(let py=Math.max(0,Math.floor(rect.y));py<Math.min(9,Math.ceil(rect.y+rect.height));py++) {
        const sy=Math.max(0,Math.min(h-1,Math.floor((py-rect.y)/rect.height*h)));
        for(let px=Math.max(0,Math.floor(rect.x));px<Math.min(13,Math.ceil(rect.x+rect.width));px++) {
          const sx=Math.max(0,Math.min(w-1,Math.floor((px-rect.x)/rect.width*w)));
          const d=(py*13+px)*4,s=(sy*w+sx)*4;
          for(let c=0;c<3;c++) expected[d+c]=Math.min(255,base[d+c]+Math.round(frame.pixels[s+c]*mask[d+c]/255));
        }
      }
      expect(compositeVideo(tile,frame).pixels).toEqual(expected);
      const bgra = new Uint8Array(expected);
      for (let i=0;i<bgra.length;i+=4) [bgra[i],bgra[i+2]]=[bgra[i+2],bgra[i]];
      expect(compositeVideo(tile,frame,"bgra").pixels).toEqual(bgra);
      expect(compositeVideo(tile,frame).pixels).toEqual(expected);
      expect(tile.pixels).toBe(base);
    }
  }
});

test("BGRA composition preserves the page background when clipping outside its tile", () => {
  const base=Uint8Array.of(0,0,0,255),mask=Uint8Array.of(255,255,255,0);
  const tile={x:0,y:0,width:1,height:1,scale:1,pixelWidth:1,pixelHeight:1,pixels:base,
    background:[12,34,56,255],videoLayer:{base,mask,rect:{x:0,y:0,width:1,height:1}}};
  const frame={width:1,height:1,pixels:Uint8Array.of(20,40,60,255)};
  const rgba=cropViewport(compositeVideo(tile,frame),-1,-1,3,3);
  const bgra=cropViewport(compositeVideo(tile,frame,"bgra"),-1,-1,3,3);
  expect(bgra.pixels).toEqual(rawFrame(rgba.pixels,3,3,"bgra").pixels);
  expect(tile.background).toEqual([12,34,56,255]);
});

test("upscaled opaque rows keep masks, alpha and fresh frame pixels in both channel orders", () => {
  const width = 19, height = 11, rect = {x:-1.25,y:0.6,width:22.5,height:10.2};
  const base = new Uint8Array(width*height*4), mask = new Uint8Array(base.length);
  for (let i=0;i<width*height;i++) {
    // Full opaque rows and interrupted spans, plus transparent and blended pixels.
    const kind = i < width*3 ? 0 : i%4, d=i*4;
    base[d+3] = kind === 1 ? 93 : 255;
    if (kind === 2) base.set([20,30,40,200],d);
    if (kind !== 3) mask.set(kind === 2 ? [127,80,190,0] : [255,255,255,0],d);
  }
  const tile={pixelWidth:width,pixelHeight:height,pixels:base,videoLayer:{base,mask,rect}};
  for (const offset of [0,1]) for (const tick of [0,17]) {
    const pixels=new Uint8Array(new ArrayBuffer(5*3*4+offset),offset);
    for(let i=0;i<pixels.length;i++) pixels[i]=(i*71+tick)%256;
    const frame={width:5,height:3,pixels};
    const expected=new Uint8Array(base);
    for(let py=Math.max(0,Math.floor(rect.y));py<Math.min(height,Math.ceil(rect.y+rect.height));py++) {
      const sy=Math.max(0,Math.min(2,Math.floor((py-rect.y)/rect.height*3)));
      for(let px=Math.max(0,Math.floor(rect.x));px<Math.min(width,Math.ceil(rect.x+rect.width));px++) {
        const sx=Math.max(0,Math.min(4,Math.floor((px-rect.x)/rect.width*5)));
        const d=(py*width+px)*4,s=(sy*5+sx)*4;
        for(let c=0;c<3;c++) expected[d+c]=Math.min(255,base[d+c]+Math.round(pixels[s+c]*mask[d+c]/255));
      }
    }
    expect(compositeVideo(tile,frame).pixels).toEqual(expected);
    const bgra=new Uint8Array(expected);
    for(let i=0;i<bgra.length;i+=4) [bgra[i],bgra[i+2]]=[bgra[i+2],bgra[i]];
    expect(compositeVideo(tile,frame,"bgra").pixels).toEqual(bgra);
    expect(tile.pixels).toBe(base);
  }
});
