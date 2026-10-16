import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowser } from "../lib/headless-shell.js";

const pulseAvailable = await new Promise((resolve) => {
  const socket = connect({ host: "127.0.0.1", port: 4713 });
  const finish = (available) => { clearTimeout(timer); socket.destroy(); resolve(available); };
  const timer = setTimeout(() => finish(false), 1000);
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
});

let directory, browser, server, videoURL, audioURL;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "buninu-local-media-"));
  videoURL = Bun.pathToFileURL(join(directory, "影片 空白.mp4")).href;
  audioURL = Bun.pathToFileURL(join(directory, "音訊 空白.mp3")).href;
  await Bun.write(Bun.fileURLToPath(videoURL), Bun.file(new URL("./fixtures/long-video.mp4", import.meta.url)));
  await Bun.write(Bun.fileURLToPath(audioURL), Bun.file(new URL("./fixtures/tone.mp3", import.meta.url)));
  server = Bun.serve({ port: 0, fetch: () => new Response(
    `<!doctype html><video src="${videoURL}"></video>`, { headers: { "content-type": "text/html" } },
  ) });
  browser = await createBrowser({ spareRenderer: false });
});
afterAll(async () => {
  browser?.close();
  server?.stop(true);
  if (directory) await rm(directory, { recursive: true, force: true });
});

const evaluate = (source) => browser.context.evaluate(source);
async function until(expression) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await Bun.sleep(25);
  }
  expect(await evaluate(expression)).toBe(true);
}

test("a standalone file video with spaces and Unicode in its URL decodes and plays", async () => {
  await browser.context.navigate(videoURL);
  expect(await evaluate("document.querySelector('video').src")).toBe(videoURL);
  await evaluate("document.querySelector('video').play()");
  await until("(() => { const v = document.querySelector('video'); return v.readyState >= 2 && v.currentTime > 0.1; })()");
  expect(await evaluate("document.querySelector('video').error")).toBe(null);
  expect(await evaluate("document.querySelector('video').duration")).toBeGreaterThan(1);
  await evaluate("document.querySelector('video').pause()");
});

test("a standalone file audio document decodes and seeks without requiring an output server", async () => {
  await browser.context.navigate(audioURL);
  expect(await evaluate("document.querySelector('audio').src")).toBe(audioURL);
  await evaluate("document.querySelector('audio').currentTime = 0.1");
  await until("document.querySelector('audio').readyState >= 2");
  expect(await evaluate("document.querySelector('audio').error")).toBe(null);
  expect(await evaluate("document.querySelector('audio').duration")).toBeGreaterThan(0.5);
  expect(await evaluate("document.querySelector('audio').currentTime")).toBeCloseTo(0.1);
  // Local rendering permission does not grant JavaScript file fetch access.
  expect(await evaluate(`fetch(${JSON.stringify(audioURL)}).then(() => 'read', () => 'blocked')`)).toBe("blocked");
});

test.skipIf(!pulseAvailable)("a standalone file audio document advances playback with an output server", async () => {
  await browser.context.navigate(audioURL);
  await evaluate("document.querySelector('audio').play()");
  await until("(() => { const a = document.querySelector('audio'); return a.readyState >= 2 && a.currentTime > 0.1; })()");
  expect(await evaluate("document.querySelector('audio').error")).toBe(null);
  await evaluate("document.querySelector('audio').pause()");
});

test("HTTP and data documents cannot load file media or fetch local bytes after local navigation", async () => {
  const html = `<!doctype html><video src="${videoURL}"></video>`;
  for (const url of [`http://127.0.0.1:${server.port}/`, `data:text/html,${encodeURIComponent(html)}`]) {
    await browser.context.navigate(url);
    await evaluate("document.querySelector('video').play()");
    await until("document.querySelector('video').error !== null");
    expect(await evaluate("document.querySelector('video').error.message")).toBe("blocked video request for file:");
    expect(await evaluate("document.querySelector('video').readyState")).toBe(0);
    expect(await evaluate(`fetch(${JSON.stringify(audioURL)}).then(() => 'read', () => 'blocked')`)).toBe("blocked");
  }
});
