import { beforeAll, expect, test } from "bun:test";
import CanvasKitInit from "../usr/lib/canvaskit/canvaskit.js";
import { createImageResourceLoader } from "../lib/renderer/image-resources.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEElEQVR4nGP4z8AARAwoFABE0AX7pM/egAAAAABJRU5ErkJggg==", "base64");
let CanvasKit;
beforeAll(async () => {
  CanvasKit = await CanvasKitInit({ wasmBinary: await Bun.file(new URL("../usr/lib/canvaskit/canvaskit.wasm", import.meta.url)).arrayBuffer() });
});

test("concurrent image consumers share one fetch and encoded image while owning independent handles", async () => {
  let fetched = 0;
  let decoded = 0;
  const makeImage = CanvasKit.MakeImageFromEncoded;
  CanvasKit.MakeImageFromEncoded = (bytes) => { decoded++; return makeImage(bytes); };
  const load = createImageResourceLoader(CanvasKit, async url => {
    fetched++;
    return { ok: true, url, body: PNG };
  });
  const resources = [];
  try {
    const document = {};
    resources.push(...await Promise.all(Array.from({ length: 20 }, () => load(document, "https://image.test/icon.png"))));
    expect(fetched).toBe(1);
    expect(decoded).toBe(1);
    expect(resources[0]).not.toBe(resources[1]);
    expect(resources[0].image).not.toBe(resources[1].image);
    expect(resources[0].image.isAliasOf(resources[1].image)).toBe(true);
    expect([resources[0].width, resources[0].height]).toEqual([2, 3]);
    resources.shift().image.delete();
    expect(resources[0].image.width()).toBe(2);
    // Completed requests are not a permanent cache of possibly stale bytes.
    resources.push(await load(document, "https://image.test/icon.png"));
    expect(fetched).toBe(2);
    expect(decoded).toBe(2);
  } finally {
    for (const resource of resources) resource.image.delete();
    CanvasKit.MakeImageFromEncoded = makeImage;
  }
});

test("image failures retry and requests from different documents do not coalesce", async () => {
  let fetched = 0;
  const load = createImageResourceLoader(CanvasKit, async url => {
    fetched++;
    return { ok: fetched > 1, status: fetched > 1 ? 200 : 404, url, body: PNG };
  });
  const document = {};
  const failures = await Promise.allSettled([load(document, "https://image.test/a.png"), load(document, "https://image.test/a.png")]);
  expect(fetched).toBe(1);
  expect(failures.every(result => result.status === "rejected")).toBe(true);
  const resources = await Promise.all([load(document, "https://image.test/a.png"), load({}, "https://image.test/a.png")]);
  try {
    expect(fetched).toBe(3);
    expect(resources[0].image.isAliasOf(resources[1].image)).toBe(false);
  } finally {
    for (const resource of resources) resource.image.delete();
  }
});

test("CORS image policies remain separate from unfiltered images and pending CORS loads cancel with their document", async () => {
  let unfiltered = 0, aborted = 0;
  const requests = [];
  const load = createImageResourceLoader(CanvasKit, async url => {
    unfiltered++;
    return { ok: true, url: `${url}?redirected`, body: PNG };
  }, request => {
    requests.push(request);
    if (request.url.endsWith("pending")) {
      const deferred = Promise.withResolvers();
      deferred.promise.abort = () => { aborted++; deferred.reject(new Error("aborted")); };
      return deferred.promise;
    }
    return Promise.resolve({ status: 200, url: request.url, body: new Blob([PNG]).stream() });
  });
  const document = {};
  const url = "https://foreign.test/icon.png";
  const resources = await Promise.all([load(document, url), load(document, url, "same-origin"),
    load(document, url, "same-origin"), load(document, url, "include")]);
  try {
    expect(unfiltered).toBe(1);
    expect(requests.map(request => [request.mode, request.credentials])).toEqual([["cors", "same-origin"], ["cors", "include"]]);
    expect(resources.map(resource => resource.originClean)).toEqual([undefined, true, true, true]);
    expect(resources[0].requestedURL).toBe(url);
    expect(resources[0].url).toBe(`${url}?redirected`);
    expect(resources[1].image.isAliasOf(resources[2].image)).toBe(true);
    const pending = load(document, "https://foreign.test/pending", "same-origin");
    load.cancelDocument(document);
    await expect(pending).rejects.toThrow("aborted");
    expect(aborted).toBe(1);
  } finally {
    for (const resource of resources) resource.image.delete();
  }
});
