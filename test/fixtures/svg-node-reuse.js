import assert from "node:assert/strict";
import "../../vendor/ses/dist/ses.mjs";
import { createPageRenderer } from "../../lib/renderer/page-renderer.js";
import { StyleEngine } from "../../lib/style/computed-style.js";

const compute = StyleEngine.prototype.compute;
let currentDocument;
StyleEngine.prototype.compute = function (...args) {
  currentDocument = args[0];
  return compute.apply(this, args);
};
lockdown({ errorTaming: "safe", overrideTaming: "severe", consoleTaming: "unsafe", localeTaming: "unsafe", stackFiltering: "concise", reporting: "none" });

const icon = `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><g>
  <path d="M2 2h12v12H2z"/><circle cx="16" cy="16" r="4" fill="blue"/></g></svg>`;
const source = `<!doctype html><style>body{margin:0;font:14px sans-serif;color:#246}
  main{display:flex;flex-wrap:wrap;gap:4px}article{box-sizing:border-box;width:150px;padding:3px;
  border:1px solid #abc;position:relative}h3{font-size:14px;margin:0}svg{vertical-align:middle}
  .badge{position:absolute;right:2px;top:1px}</style><main>` + Array.from({ length: 6 }, (_, i) =>
  `<article id="card${i}"><h3>Card ${i}</h3><span class="icons">${icon}${icon}</span>
  <span class="badge">${i}</span><p>Text within card ${i}.</p></article>`).join("") + "</main>";

async function open(source) {
  const renderer = await createPageRenderer({
    fetchResource: async url => ({ ok: false, status: 404, url, body: new Uint8Array() }),
  });
  renderer.resize(480, 360, 1);
  await renderer.loadDocument({ url: "https://svg-reuse.test/", contentType: "text/html", source });
  await renderer.whenLoaded();
  return { renderer, document: currentDocument };
}

async function capture(renderer) {
  const geometry = renderer.inspect("article,svg", ["width", "height", "color", "visibility", "transform"], 100);
  const image = await renderer.screenshot({ format: "rgba" });
  return { geometry, pixels: Buffer.from(image.pixels) };
}

try {
  const live = await open(source), snapshots = [];
  try {
    const card = live.document.getElementById("card0"), svg = card.querySelector("svg");
    const group = svg.querySelector("g"), path = svg.querySelector("path"), circle = svg.querySelector("circle");
    const phases = [
      ["initial", () => {}],
      ["sibling text moves retained cards", () => { live.document.querySelector("#card1 h3").firstChild.data = "Changed title wraps to another line"; }],
      ["child path", () => path.setAttribute("d", "M1 1h20v8H1z")],
      ["child fill", () => path.setAttribute("fill", "red")],
      ["inherited currentColor", () => { path.setAttribute("fill", "currentColor"); card.style.color = "purple"; }],
      ["descendant currentColor", () => { path.style.color = "green"; }],
      ["group transform", () => group.setAttribute("transform", "translate(2 3) rotate(15)")],
      ["child transform", () => circle.setAttribute("transform", "scale(.6)")],
      ["child visibility", () => { path.style.visibility = "hidden"; }],
      ["restore child visibility", () => { path.style.visibility = "visible"; }],
      ["group display", () => { group.style.display = "none"; }],
      ["restore group display", () => { group.style.display = "inline"; }],
      ["dimensions", () => { svg.setAttribute("width", "40"); svg.setAttribute("height", "32"); }],
      ["viewBox", () => svg.setAttribute("viewBox", "0 0 48 48")],
      ["CSS dimensions", () => { svg.style.width = "50px"; svg.style.height = "44px"; }],
      ["root transform", () => { svg.style.transform = "translate(8px,5px)"; }],
      ["root and group opacity", () => { svg.style.opacity = ".4"; group.style.opacity = ".5"; }],
      ["stroke paint", () => { path.style.stroke = "currentColor"; path.style.strokeWidth = "3px"; path.style.strokeOpacity = ".3"; }],
      ["fill paint", () => { path.style.fillOpacity = ".2"; path.style.fillRule = "evenodd"; }],
      ["remove shape", () => circle.remove()],
      ["reorder shape", () => group.insertBefore(circle, path)],
      ["auto dimensions", () => { svg.removeAttribute("width"); svg.removeAttribute("height"); svg.style.width = "auto"; svg.style.height = "auto"; }],
      ["root visibility", () => { svg.style.visibility = "hidden"; }],
      ["restore markup", () => { card.querySelector(".icons").innerHTML = icon + icon; card.style.color = ""; }],
    ];
    for (const [name, mutate] of phases) {
      mutate();
      live.renderer.resize(480, 360, 1);
      snapshots.push({ name, source: live.document.documentElement.outerHTML, actual: await capture(live.renderer) });
    }
  } finally { live.renderer.dispose(); }

  for (const { name, source, actual } of snapshots) {
    const fresh = await open(source);
    try { assert.deepEqual(actual, await capture(fresh.renderer), `${name}: fresh renderer geometry and pixels`); }
    finally { fresh.renderer.dispose(); }
  }
  process.stdout.write("SVG node reuse renderer oracle passed\n");
} finally { StyleEngine.prototype.compute = compute; }
