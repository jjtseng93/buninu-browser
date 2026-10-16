#!/usr/bin/env bun
// Exercise redirects through real HTTP servers, using Chromium as a reference.
import { launch } from "./browser-lab.js";
import { resolve } from "node:path";

const [engine = "buninu", output = "/tmp/buninu-network-reference"] = process.argv.slice(2);
const calls = [];
let source, target;
const handler = async request => {
  const url = new URL(request.url);
  calls.push({ method: request.method, path: url.pathname, host: url.host, origin: request.headers.get("origin"),
    cookie: request.headers.get("cookie"), authorization: request.headers.get("authorization"),
    preflight: request.headers.get("access-control-request-headers") });
  const cors = { "access-control-allow-origin": request.headers.get("origin") ?? source,
    "access-control-allow-credentials": "true", "access-control-allow-methods": "PUT", "access-control-allow-headers": "x-custom" };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (url.pathname === "/") return new Response("<!doctype html><title>Network reference</title><p>Redirect fixture</p>", { headers: { "content-type": "text/html" } });
  if (url.pathname.startsWith("/redirect/")) return new Response(null, { status: 307, headers: { location: target + url.pathname.slice(9) } });
  if (url.pathname === "/chain") return new Response(null, { status: 302, headers: { ...cors, location: source + "/finish" } });
  return new Response("visible body", { headers: { ...(url.pathname === "/denied" ? {} : cors),
    "x-private": "hidden", "x-public": "visible", "access-control-expose-headers": "x-public" } });
};
const first = Bun.serve({ port: 0, fetch: handler });
const second = Bun.serve({ port: 0, fetch: handler });
source = `http://localhost:${first.port}`; target = `http://localhost:${second.port}`;
let browser;
const report = { engine, cases: [] };
try {
  browser = await launch(engine, resolve(output));
  await browser.cdp.send("Page.navigate", { url: source + "/" });
  await Bun.sleep(300);
  await browser.cdp.evaluate('document.cookie="private=fixture; SameSite=Lax"; undefined;');
  for (const [name, url, init] of [
    ["denied", source + "/redirect/denied", {}],
    ["allowed", source + "/redirect/allowed", {}],
    ["same-origin", source + "/redirect/allowed", { mode: "same-origin" }],
    ["opaque", source + "/redirect/allowed", { mode: "no-cors" }],
    ["preflight", source + "/redirect/allowed", { method: "PUT", headers: { authorization: "Bearer fixture", "x-custom": "yes" }, body: "body" }],
    ["chain", target + "/chain", {}],
  ]) {
    calls.length = 0;
    const result = await browser.cdp.evaluate(`(async()=>{try {const r=await fetch(${JSON.stringify(url)},${JSON.stringify(init)});
      return {type:r.type,status:r.status,body:await r.text(),private:r.headers.get('x-private'),public:r.headers.get('x-public')};
      } catch(e) {return {error:e.name};}})()`);
    report.cases.push({ name, result, calls: calls.slice() });
  }
  await Bun.write(resolve(output, "network.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser?.stop(); first.stop(true); second.stop(true); }
