import { afterAll, beforeAll, expect, test } from "bun:test";
import { RendererHost } from "../lib/renderer/host.js";

const requests = [], navigations = [];
let renderer;
beforeAll(async () => {
  renderer = new RendererHost({ timeout: 20_000, onNavigate: url => navigations.push(url), fetch: async url => {
    requests.push(String(url));
    const path = new URL(url).pathname;
    if (path === "/assets/sheet.css") return new Response("#target { color:blue }", {headers:{"content-type":"text/css"}});
    if (path === "/assets/classic.js") return new Response("window.classicURL=document.currentScript.src;window.classicRuns=(window.classicRuns||0)+1", {headers:{"content-type":"text/javascript"}});
    if (path === "/assets/module.js") return new Response("export const answer=42", {headers:{"content-type":"text/javascript"}});
    if (path === "/assets/worker.js") return new Response("onmessage=()=>postMessage(location.href)", {headers:{"content-type":"text/javascript"}});
    if (path === "/assets/pixel.png") return new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEElEQVR4nGP4z8AARAwoFABE0AX7pM/egAAAAABJRU5ErkJggg==","base64"),
      {headers:{"content-type":"image/png","cache-control":"max-age=60"}});
    return new Response("missing", {status:404});
  }});
  await renderer.start();
});
afterAll(() => renderer?.close());
const evaluate = source => renderer.call("evaluate", source);
async function load(source) {
  await renderer.call("loadDocument",{url:"https://base.test/page/index.html",contentType:"text/html",status:200,source});
  await renderer.call("whenLoaded");
}
async function until(predicate) {
  const deadline=Date.now()+3000;
  while (!await predicate() && Date.now()<deadline) await Bun.sleep(10);
  expect(await predicate()).toBeTrue();
}

test("document base URL consistently resolves scripts, styles, images, backgrounds and workers", async () => {
  requests.length=0;
  await load(`<!doctype html><base target="_self"><base href="/assets/">
    <link rel="stylesheet" href="sheet.css"><style>#background{width:10px;height:10px;background-image:url(pixel.png)}</style>
    <div id="target">Target</div><img id="image" src="pixel.png"><div id="background"></div>
    <script src="classic.js"></script><script type="module">import {answer} from './module.js';window.moduleAnswer=answer;window.moduleURL=import.meta.url</script>`);
  expect(await evaluate("[classicRuns,classicURL,moduleAnswer,moduleURL,document.baseURI,document.URL]")).toEqual([
    1,"https://base.test/assets/classic.js",42,"https://base.test/assets/","https://base.test/assets/","https://base.test/page/index.html",
  ]);
  expect(await evaluate("[getComputedStyle(document.getElementById('target')).color,document.getElementById('image').naturalWidth,document.styleSheets[0].href]"))
    .toEqual(["rgba(0, 0, 255, 1)",2,"https://base.test/assets/sheet.css"]);
  expect(requests.every(url=>url.startsWith("https://base.test/assets/"))).toBeTrue();
  expect(requests.filter(url=>url.endsWith('/classic.js'))).toHaveLength(1);
  expect(await evaluate("new Promise((resolve,reject)=>{const worker=new Worker('worker.js');worker.onmessage=e=>{resolve(e.data);worker.terminate()};worker.onerror=reject;worker.postMessage('go')})"))
    .toBe("https://base.test/assets/worker.js");
  expect(await evaluate("(()=>{document.querySelector('base[href]').href='https://foreign.test/';try{new Worker('worker.js');return 'allowed'}catch(error){return error.name}})()"))
    .toBe("SecurityError");
});

test("link activation and form actions use the base while an empty form action uses the document URL", async () => {
  navigations.length=0;
  await load(`<!doctype html><base href="/assets/"><a id="link" href="next">Next</a>
    <form id="relative" action="submit"><input name="q" value="one"></form>
    <form id="empty" action=""><input name="q" value="two"></form>`);
  await evaluate("document.getElementById('link').click()");
  await until(()=>navigations.length===1);
  expect(navigations[0]).toBe("https://base.test/assets/next");
  await evaluate("document.querySelector('base').href='/changed/';document.getElementById('link').click()");
  await until(()=>navigations.length===2);
  expect(navigations[1]).toBe("https://base.test/changed/next");
  await evaluate("document.getElementById('relative').requestSubmit()");
  await until(()=>navigations.length===3);
  expect(navigations[2]).toBe("https://base.test/changed/submit?q=one");
  await evaluate("document.getElementById('empty').requestSubmit()");
  await until(()=>navigations.length===4);
  expect(navigations[3]).toBe("https://base.test/page/index.html?q=two");
});

test("base selection ignores target-only entries and unsupported schemes; hyperlink components share its URL", async () => {
  await load(`<!doctype html><base target="_self"><base id="base" href="/assets/"><a id="link" href="next?q=1#part">Next</a>`);
  expect(await evaluate("[document.baseURI,document.getElementById('link').pathname,document.getElementById('link').search,document.getElementById('link').hash]"))
    .toEqual(["https://base.test/assets/","/assets/next","?q=1","#part"]);
  expect(await evaluate("(()=>{const a=document.getElementById('link');a.hash='other';return a.href})()"))
    .toBe("https://base.test/assets/next?q=1#other");
  for (const href of ["javascript:void(0)","data:text/plain,base","http://["]) {
    expect(await evaluate(`document.getElementById('base').setAttribute('href',${JSON.stringify(href)});document.baseURI`))
      .toBe("https://base.test/page/index.html");
  }
});

test("inline modules with a common base execute independently and expose the actual base URL", async () => {
  await load(`<!doctype html><base href="/assets/">
    <script type="module">const local=1;window.modules=[local,import.meta.url,import.meta.resolve('./module.js')]</script>
    <script type="module">const local=2;window.modules.push(local,import.meta.url)</script>`);
  expect(await evaluate("modules")).toEqual([1,"https://base.test/assets/","https://base.test/assets/module.js",2,"https://base.test/assets/"]);
});
