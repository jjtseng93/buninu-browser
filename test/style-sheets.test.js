import { afterAll, beforeAll, expect, test } from "bun:test";
import { RendererHost } from "../lib/renderer/host.js";

let renderer;
const requests = [];
beforeAll(async () => {
  renderer = new RendererHost({ timeout: 20_000, fetch: async url => {
    requests.push(String(url));
    return new Response("#target { color: blue }", { headers: { "content-type": "text/css" } });
  }});
  await renderer.start();
});
afterAll(() => renderer?.close());
const read = (code = "") => renderer.call("evaluate", `(()=>{${code};return getComputedStyle(document.getElementById('target')).color})()`);
async function load(source) {
  await renderer.call("loadDocument", { url: "https://style.test/", contentType: "text/html", status: 200, source });
  await renderer.call("whenLoaded");
}

test("inline sheet media and type are respected after mutation and viewport changes", async () => {
  await renderer.call("resize", 800, 600, 1);
  await load(`<!doctype html><style>#target{color:red}</style>
    <style media="print">#target{color:purple}</style>
    <style id="responsive" media="screen and (max-width:500px)">#target{color:green}</style>
    <style id="typed" type="text/plain">#target{color:blue}</style><div id="target">Text</div>`);
  expect(await read()).toBe("rgba(255, 0, 0, 1)");
  await renderer.call("resize", 400, 600, 1);
  expect(await read()).toBe("rgba(0, 128, 0, 1)");
  expect(await read("document.getElementById('responsive').setAttribute('media','print')")).toBe("rgba(255, 0, 0, 1)");
  expect(await read("document.getElementById('typed').setAttribute('type','text/css')")).toBe("rgba(0, 0, 255, 1)");
});

test("linked sheet media can change without refetching and disabled sheets fetch on enable", async () => {
  requests.length = 0;
  await load(`<!doctype html><style>#target{color:red}</style>
    <link id="linked" rel="stylesheet" href="/linked.css" media="print"><div id="target">Text</div>`);
  expect(await read()).toBe("rgba(255, 0, 0, 1)");
  expect(requests).toEqual(["https://style.test/linked.css"]);
  expect(await read("document.getElementById('linked').setAttribute('media','screen')")).toBe("rgba(0, 0, 255, 1)");
  expect(requests.length).toBe(1);
  expect(await read("document.getElementById('linked').setAttribute('disabled','')")).toBe("rgba(255, 0, 0, 1)");
  await load(`<!doctype html><style>#target{color:red}</style>
    <link id="linked" rel="stylesheet" disabled href="/disabled.css"><div id="target">Text</div>`);
  expect(await read()).toBe("rgba(255, 0, 0, 1)");
  expect(requests.length).toBe(1);
  await read("document.getElementById('linked').removeAttribute('disabled')");
  const deadline = Date.now() + 3000;
  while (await read() !== "rgba(0, 0, 255, 1)" && Date.now() < deadline) await Bun.sleep(10);
  expect(await read()).toBe("rgba(0, 0, 255, 1)");
  expect(requests).toEqual(["https://style.test/linked.css", "https://style.test/disabled.css"]);
});
