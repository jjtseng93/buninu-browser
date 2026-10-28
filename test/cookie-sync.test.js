import { expect, test } from "bun:test";
import { RendererHost } from "../lib/renderer/host.js";
import { NetworkService } from "../lib/network/network-service.js";

const origin = "https://cookie.test";
const pairs = value => value.split("; ").filter(Boolean).sort();
async function fixture(fetch) {
  const network = new NetworkService({ fetch });
  const renderer = new RendererHost({ network, timeout: 20_000 });
  await renderer.start();
  const load = (url = origin + "/main/page.html") => renderer.call("loadDocument", {
    url, source: "<!doctype html><p>Cookies</p>", contentType: "text/html",
  });
  await load();
  return { network, renderer, load, evaluate: source => renderer.call("evaluate", source) };
}

for (const deleting of [false, true]) {
  test(`delayed response headers preserve a newer script ${deleting ? "deletion" : "write"} and unrelated server cookies`, async () => {
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const { renderer, network, evaluate } = await fixture(() => new Promise(resolve => {
      release = resolve; entered();
    }));
    try {
      await evaluate(`document.cookie = 'key=before; Path=/'; undefined;`);
      await evaluate(`window.finished = fetch('/delayed').then(() => document.cookie); undefined;`);
      await started;
      // The controller receives headers while the page is executing a task.
      // The setter runs before that task ends and before headers can be delivered.
      const busy = evaluate(`const start = performance.now(); while(performance.now() - start < 180) {};
        document.cookie = ${JSON.stringify(deleting ? "key=; Max-Age=0; Path=/" : "key=after; Path=/")}; document.cookie;`);
      const timer = setTimeout(() => release(new Response("complete", { headers: [
        ["set-cookie", "server=2; Path=/"], ["set-cookie", "secret=hidden; Path=/; HttpOnly"],
      ] })), 30);
      await busy;
      clearTimeout(timer);
      const result = await evaluate("finished");
      expect(pairs(result)).toEqual(deleting ? ["server=2"] : ["key=after", "server=2"]);
      expect(pairs(await evaluate("document.cookie"))).toEqual(pairs(network.documentCookie(origin + "/main/page.html")));
      expect(result).not.toContain("secret");
    } finally { renderer.close(); }
  });
}

test("same-origin frames share writes immediately while retaining their own cookie paths", async () => {
  const { renderer, network, evaluate } = await fixture(() => new Response("<!doctype html><p>Frame</p>", {
    headers: { "content-type": "text/html" },
  }));
  try {
    await evaluate(`window.frame = document.createElement('iframe');
      window.frameReady = new Promise(resolve => frame.onload = resolve);
      frame.src = '/frame/path/page.html'; document.body.append(frame); undefined;`);
    await evaluate("frameReady.then(() => true)");
    const result = await evaluate(`document.cookie = 'shared=parent; Path=/';
      const first = frame.contentDocument.cookie;
      frame.contentDocument.cookie = 'inside=frame';
      frame.contentDocument.cookie = 'shared=child; Path=/';
      [first, document.cookie, frame.contentDocument.cookie];`);
    expect(pairs(result[0])).toEqual(["shared=parent"]);
    expect(pairs(result[1])).toEqual(["shared=child"]);
    expect(pairs(result[2])).toEqual(["inside=frame", "shared=child"]);
    await evaluate("new Promise(resolve => setTimeout(resolve, 20))");
    expect(pairs(network.documentCookie(origin + "/frame/path/other.html"))).toEqual(["inside=frame", "shared=child"]);
    expect(network.documentCookie(origin + "/main/page.html")).toBe("shared=child");
  } finally { renderer.close(); }
});

test("credential-free responses retain the mirror and navigation uses the new document origin", async () => {
  const { renderer, network, evaluate, load } = await fixture(() => new Response("done", {
    headers: { "set-cookie": "shared=ignored; Path=/" },
  }));
  try {
    await evaluate(`document.cookie = 'shared=kept; Path=/'; undefined;`);
    expect(await evaluate(`fetch('/omit', {credentials: 'omit'}).then(() => document.cookie)`)).toBe("shared=kept");
    network.setDocumentCookie("https://other.test/", "other=2; Path=/");
    await load("https://other.test/page");
    expect(await evaluate("document.cookie")).toBe("other=2");
    await load(origin + "/another/page");
    expect(await evaluate("document.cookie")).toBe("shared=kept");
  } finally { renderer.close(); }
});
