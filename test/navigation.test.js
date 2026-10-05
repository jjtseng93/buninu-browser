import { afterAll, beforeAll, expect, test } from "bun:test";
import { createBrowser } from "../lib/headless-shell.js";

let server;
let browser;
const posts = [];
beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const html = (body, init = {}) => new Response(`<!doctype html>${body}`, { ...init, headers: { "content-type": "text/html" } });
      if (pathname === "/start") return new Response(null, { status: 302, headers: { location: "/dir/form?step=1#top" } });
      if (pathname === "/dir/form") {
        // An error status with a page, as some challenge pages come.
        return html(`<title>form</title><form id="f" action="submit" method="post">
          <input name="q" value="a b&amp;c"><input type="hidden" name="continue" value="/next"></form>`, { status: 429 });
      }
      if (pathname === "/dir/submit") {
        posts.push({
          method: request.method,
          body: await request.text(),
          type: request.headers.get("content-type"),
          origin: request.headers.get("origin"),
          referer: request.headers.get("referer"),
        });
        return new Response(null, { status: 303, headers: { location: "/done" } });
      }
      if (pathname === "/done") return html(`<title>done ${request.method}</title>`);
      return new Response("missing", { status: 404 });
    },
  });
  browser = await createBrowser({ spareRenderer: false });
});
afterAll(() => {
  browser?.close();
  server?.stop(true);
});

test("a redirected document has the URL it ended on, and its POST form submits there", async () => {
  const { context } = browser;
  const origin = `http://127.0.0.1:${server.port}`;
  await context.navigate(`${origin}/start`);
  // The final URL, with the request's fragment carried over; relative URLs resolve against it.
  expect(await context.evaluate(`[location.href, document.baseURI, document.getElementById("f").action]`))
    .toEqual([`${origin}/dir/form?step=1#top`, `${origin}/dir/form?step=1#top`, `${origin}/dir/submit`]);

  await context.evaluate(`document.getElementById("f").submit()`);
  const deadline = Date.now() + 10_000;
  while (await context.title() !== "done GET" && Date.now() < deadline) await Bun.sleep(50);
  expect(await context.title()).toBe("done GET");
  expect(posts).toEqual([{
    method: "POST",
    body: "q=a+b%26c&continue=%2Fnext",
    type: "application/x-www-form-urlencoded",
    origin,
    referer: `${origin}/dir/form?step=1`,
  }]);
  // The 303 after it was followed with a GET, and the document is at its URL.
  expect(await context.evaluate("location.href")).toBe(`${origin}/done`);
});
