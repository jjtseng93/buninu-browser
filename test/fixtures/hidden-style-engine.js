import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const root = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
if (process.argv.includes("--ses")) {
  await import(pathToFileURL(root + "/vendor/ses/dist/ses.mjs"));
  lockdown({
    errorTaming: "safe",
    overrideTaming: "severe",
    consoleTaming: "unsafe",
    localeTaming: "unsafe",
    stackFiltering: "concise",
    reporting: "none",
  });
}
const { parseHTMLDocument } = await import(
  pathToFileURL(root + "/lib/happy-dom/parser.js")
);
const { StyleEngine, computeElementStyle } = await import(
  pathToFileURL(root + "/lib/style/computed-style.js")
);
let assertions = 0,
  states = 0,
  metric = 7,
  measurements = 0;
const measureText = (text, style) => {
  measurements++;
  return { width: text.length * metric, height: style.fontSize };
};
const f = parseHTMLDocument(
  `<html style="font-size:18px"><body><section id="visible" style="color:purple;--tone:green"></section><div id="outer" style="color:red;--tone:blue"><div id="nested" style="display:none;font-size:20px"><i id="nestedchild" class="child"></i></div><div id="chain" style="font-size:1.2em;line-height:1.5"><span id="leaf" class="child" style="width:inherit"><b id="grand" class="child"></b></span></div><svg id="svg"><g id="g"><path id="path" style="fill:currentColor"/></g></svg></div></body></html>`,
);
let sheets = [
  `.child{background:var(--tone);margin:2rem;padding:2ch;max-width:20vw}.child::before{content:"before";color:inherit;width:2ch} #outer:has(.active) .child {color:orange} #visible .child {font-weight:bold} @media(min-width:600px){.child{height:4em}}`,
];
let viewport = { width: 800, height: 600 },
  lazy = new StyleEngine({ deferHidden: true, measureText }),
  lastRestyled;
const el = (id) => f.document.getElementById(id);
function run(label, { dirty = null, self = null } = {}) {
  lazy.compute(f.document, sheets, viewport, dirty, self);
  lastRestyled = lazy.restyled;
  const full = new StyleEngine({ measureText }).compute(
    f.document,
    sheets,
    viewport,
  );
  // Query descendants before their ancestors to exercise path materialization.
  const elements = [...f.document.querySelectorAll("*")].reverse();
  for (const e of elements) {
    assert.deepEqual(lazy.get(e), full.get(e), label + " style " + e.id);
    assertions++;
    assert.deepEqual(
      lazy.customPropertiesOf(e),
      full.customPropertiesOf(e),
      label + " custom " + e.id,
    );
    assertions++;
    for (const p of ["before", "after"]) {
      assert.deepEqual(
        lazy.getPseudo(e, p),
        full.getPseudo(e, p),
        label + " pseudo " + e.id,
      );
      assertions++;
    }
  }
  assert.equal(
    lazy.restyled,
    lastRestyled,
    label + " query does not affect traversal counter",
  );
  assertions++;
  states++;
}
try {
  run("visible with nested hidden");
  el("outer").style.display = "none";
  el("nested").style.fontSize = "31px";
  run("outer hides stale nested boundary", { dirty: new Set([el("outer")]) });
  el("outer").style.color = "green";
  el("outer").style.setProperty("--tone", "pink");
  run("hidden boundary inherit self", {
    dirty: new Set(),
    self: new Set([el("outer")]),
  });
  el("chain").style.fontSize = "33px";
  el("leaf").style.width = "77px";
  el("leaf").classList.add("active");
  run("hidden inside roots", { dirty: new Set([el("chain"), el("leaf")]) });
  el("nestedchild").style.cssText = "all:inherit;--tone:yellow";
  run("hidden self inheritance", {
    dirty: new Set(),
    self: new Set([el("nestedchild")]),
  });
  sheets = [
    ...sheets,
    ".child{border:2px solid currentColor} #chain{width:91px}",
  ];
  run("added sheet hidden", { dirty: new Set() });
  viewport = { width: 500, height: 700 };
  run("viewport full");
  f.document.documentElement.style.fontSize = "22px";
  run("root rem self", {
    dirty: new Set(),
    self: new Set([f.document.documentElement]),
  });
  metric = 11;
  run("font environment full");
  assert.equal(lazy.usesFontMetrics, true);
  assertions++;
  el("nested").style.display = "block";
  run("nested reveal under hidden ancestor", {
    dirty: new Set([el("nested")]),
  });
  el("outer").style.display = "block";
  run("outer reveal", { dirty: new Set(), self: new Set([el("outer")]) });
  el("visible").append(el("chain"));
  run("move to visible different inherit", { dirty: new Set([el("chain")]) });
  el("outer").style.display = "none";
  run("hide again", { dirty: new Set([el("outer")]) });
  el("outer").append(el("chain"));
  run("move into hidden", { dirty: new Set([el("chain")]) });
  el("chain").insertAdjacentHTML(
    "beforeend",
    '<em id="new" class="child" style="width:inherit"><strong id="newchild" style="font:inherit">new</strong></em>',
  );
  run("insert new hidden subtree", {
    dirty: new Set([el("new"), el("newchild")]),
  });
  el("visible").append(el("nested"));
  run("move stale former boundary visible", { dirty: new Set([el("nested")]) });
  el("outer").classList.add("active");
  run("hidden has ancestor dirty", { dirty: new Set([el("outer")]) });
  f.document.body.style.display = "none";
  run("body none conservative");
  f.document.documentElement.style.display = "none";
  run("html none conservative");
  // Deterministic mutation stress with legal full/subtree invalidation.
  let seed = 13;
  const rnd = (n) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % n;
  };
  const ids = ["outer", "nested", "chain", "leaf", "grand", "new", "newchild"];
  for (let i = 0; i < 120; i++) {
    const e = el(ids[rnd(ids.length)]),
      op = rnd(6);
    if (op === 0) e.style.display = rnd(2) ? "none" : "block";
    if (op === 1) e.style.color = ["red", "blue", "green", "inherit"][rnd(4)];
    if (op === 2)
      e.style.setProperty("--tone", ["pink", "orange", "teal"][rnd(3)]);
    if (op === 3) e.style.fontSize = 12 + rnd(15) + "px";
    if (op === 4) e.style.width = ["inherit", "3rem", "5ch", "42px"][rnd(4)];
    if (op === 5) e.classList.toggle("active");
    run("stress " + i, { dirty: new Set([op === 5 ? f.document.body : e]) });
  }
  // Query only one hidden chain; siblings must stay uncomputed until requested.
  const select = parseHTMLDocument(
    '<div id="hide" style="display:none">' +
      Array.from(
        { length: 500 },
        (_, i) => `<span id="x${i}" style="width:1ch"></span>`,
      ).join("") +
      "</div>",
  );
  try {
    const limited = new StyleEngine({ deferHidden: true, measureText });
    measurements = 0;
    limited.compute(select.document);
    assert.equal(measurements, 0);
    const count = limited.restyled;
    limited.get(select.document.getElementById("x250"));
    assert.equal(measurements, 1);
    assert.equal(limited.restyled, count);
    limited.get(select.document.getElementById("x250"));
    assert.equal(measurements, 1);
    assertions += 4;
  } finally {
    select.window.happyDOM.abort();
  }
  // A new document/adopted subtree must use only its new context and maps.
  const a = parseHTMLDocument(
    '<div style="display:none;color:red;--x:old"><span id="adopted" style="width:3em"></span></div>',
  );
  const b = parseHTMLDocument(
    '<div id="newhost" style="display:none;color:blue;font-size:25px;--x:new"></div>',
  );
  try {
    const engine = new StyleEngine({ deferHidden: true }).compute(a.document),
      node = a.document.getElementById("adopted");
    const old = engine.get(node);
    b.document.getElementById("newhost").append(node);
    engine.compute(b.document);
    assert.equal(engine.get(node).width, 75);
    assert.equal(engine.get(node).color, "rgba(0, 0, 255, 1)");
    assert.equal(engine.customPropertiesOf(node).get("--x"), "new");
    assert.notEqual(engine.get(node), old);
    assert.equal(engine.get(a.document.documentElement).display, "inline");
    assertions += 5;
  } finally {
    a.window.happyDOM.abort();
    b.window.happyDOM.abort();
  }
  // Lazy metric callbacks may compute another engine; their saved environment
  // must not replace this query's viewport/rem context or survive an exception.
  const envDoc = parseHTMLDocument(
    '<html style="font-size:21px"><body><div style="display:none"><section id="partial" style="font-size:1.2em;width:11vw"><span id="metric" style="width:2ch;height:10vw;margin:2rem"></span></section></div></body></html>',
  );
  const otherDoc = parseHTMLDocument('<div style="width:10vw"></div>');
  try {
    const envEngine = new StyleEngine({
      deferHidden: true,
      measureText() {
        new StyleEngine().compute(otherDoc.document, [], { width: 200 });
        return 9;
      },
    }).compute(envDoc.document, [], { width: 800 });
    const metricNode = envDoc.document.getElementById("metric");
    Object.defineProperty(metricNode, "getAttribute", {
      configurable: true,
      value() {
        throw Error("query failure");
      },
    });
    let thrown = false;
    try {
      envEngine.get(metricNode);
    } catch (error) {
      thrown = error.message === "query failure";
    }
    assert.equal(thrown, true);
    delete metricNode.getAttribute;
    const initial = envDoc.document.createElement("span");
    initial.style.width = "2rem";
    assert.equal(computeElementStyle(initial).width, 32);
    assert.equal(
      envEngine.get(envDoc.document.getElementById("partial")).width,
      88,
    );
    assertions += 2;
    const computed = envEngine.get(envDoc.document.getElementById("metric"));
    assert.equal(computed.width, 18);
    assert.equal(computed.height, 80);
    assert.deepEqual(computed.margin, [42, 42, 42, 42]);
    assertions += 4;
  } finally {
    envDoc.window.happyDOM.abort();
    otherDoc.window.happyDOM.abort();
  }
  console.log(
    JSON.stringify({
      pass: true,
      states,
      assertions,
      mode: process.argv.includes("--ses") ? "ses" : "plain",
    }),
  );
} finally {
  f.window.happyDOM.abort();
}
