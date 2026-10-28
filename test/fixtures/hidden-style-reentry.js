import assert from "node:assert/strict";
const root = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
if (process.argv.includes("--ses")) {
  await import(root + "/vendor/ses/dist/ses.mjs");
  lockdown({
    errorTaming: "safe",
    overrideTaming: "severe",
    consoleTaming: "unsafe",
    localeTaming: "unsafe",
    stackFiltering: "concise",
    reporting: "none",
  });
}
const { parseHTMLDocument } = await import(root + "/lib/happy-dom/parser.js");
const { StyleEngine, computeElementStyle } = await import(
  root + "/lib/style/computed-style.js"
);
let assertions = 0;
function snapshot(engine, node) {
  return {
    width: engine.get(node).width,
    fontSize: engine.get(node).fontSize,
    custom: engine.customPropertiesOf(node).get("--x") ?? null,
    pseudo: engine.getPseudo(node, "before")?.width ?? null,
  };
}
function scenario(deferHidden, kind, warm = false) {
  const f = parseHTMLDocument(
    '<div id="hide" style="display:' +
      (warm ? "block" : "none") +
      '"><section id="parent" style="' +
      (kind === "descendant" || kind === "parentpseudo"
        ? "width:1ch;font-size:24px"
        : "") +
      '"><span id="target" style="font-size:30px;--x:value;width:1ch"></span></section></div>',
  );
  const target = f.document.getElementById("target"),
    parent = f.document.getElementById("parent");
  let calls = 0,
    inner = [];
  const sheets =
    kind === "pseudo"
      ? ['#target::before{content:"b";width:1ch}']
      : kind === "parentpseudo"
        ? ['#parent::before{content:"b";width:1ch}']
        : [];
  const engine = new StyleEngine({
    deferHidden,
    measureText() {
      if (++calls > 5) throw Error("reentry was not bounded");
      inner.push({
        target: snapshot(engine, target),
        parent: snapshot(engine, parent),
      });
      return kind === "pseudo" ? engine.get(target).fontSize : 7;
    },
  });
  try {
    engine.compute(f.document, sheets);
    if (warm) {
      f.document.getElementById("hide").style.display = "none";
      target.style.fontSize = "40px";
      calls = 0;
      inner = [];
      engine.compute(
        f.document,
        sheets,
        {},
        new Set([f.document.getElementById("hide")]),
      );
    }
    const result = {
      target: snapshot(engine, target),
      parent: snapshot(engine, parent),
      calls,
      inner,
    };
    return result;
  } finally {
    f.window.happyDOM.abort();
  }
}
for (const kind of ["same", "descendant", "pseudo", "parentpseudo"])
  for (const warm of [false, true]) {
    const eager = scenario(false, kind, warm),
      lazy = scenario(true, kind, warm);
    assert.deepEqual(
      lazy,
      eager,
      kind + " reentrant values match eager snapshots",
    );
    assert.equal(
      lazy.calls,
      kind === "same" ? 1 : kind === "parentpseudo" ? 3 : 2,
    );
    assertions += 2;
  }
// Ownership begins before ancestor/key extraction as well as measurements.
for (const ancestor of [false, true]) {
  const f = parseHTMLDocument(
    '<div id="hide" style="display:none"><span id="target" style="width:17px"></span></div>',
  );
  const target = f.document.getElementById("target"),
    hooked = ancestor ? f.document.getElementById("hide") : target;
  const engine = new StyleEngine({ deferHidden: true });
  engine.compute(f.document);
  let calls = 0,
    inner = [];
  const getAttribute = hooked.getAttribute;
  Object.defineProperty(hooked, "getAttribute", {
    configurable: true,
    value(name) {
      if (name === "id") {
        if (++calls > 3) throw Error("key reentry was not bounded");
        inner.push(engine.get(target).width);
      }
      return getAttribute.call(this, name);
    },
  });
  try {
    assert.equal(engine.get(target).width, 17);
    assert.equal(calls, 1);
    assert.deepEqual(inner, ["auto"]);
    assertions += 3;
  } finally {
    delete hooked.getAttribute;
    f.window.happyDOM.abort();
  }
}
// A failure in a pseudo occurs after the principal values were stored. They
// must not make the next query mistake that failed node for a complete result.
{
  const f = parseHTMLDocument(
    '<html style="font-size:21px"><body><div id="hide" style="display:none"><span id="target" style="width:1ch"></span></div></body></html>',
  );
  const target = f.document.getElementById("target");
  let calls = 0,
    fail = true;
  const engine = new StyleEngine({
    deferHidden: true,
    measureText() {
      calls++;
      if (fail && calls === 2)
        Object.defineProperty(target, "matches", {
          configurable: true,
          get() {
            throw Error("pseudo failure");
          },
        });
      return 7;
    },
  });
  try {
    engine.compute(f.document, [
      '#target::before{content:"b";width:1ch} #hide #target::after{content:"a"}',
    ]);
    let thrown = false;
    try {
      engine.get(target);
    } catch (error) {
      thrown = error.message === "pseudo failure";
    }
    assert.equal(thrown, true);
    assert.equal(calls, 2);
    delete target.matches;
    fail = false;
    const initial = f.document.createElement("i");
    initial.style.width = "2rem";
    assert.equal(computeElementStyle(initial).width, 32);
    assert.equal(engine.get(target).width, 7);
    assert.equal(engine.getPseudo(target, "before").width, 7);
    assert.equal(engine.getPseudo(target, "after").content, "a");
    assert.equal(calls, 4);
    assertions += 7;
  } finally {
    f.window.happyDOM.abort();
  }
}
// The guard belongs to an ensured generation, not the engine globally. A
// callback may start another document or another compute of the same document.
for (const sameDocument of [false, true]) {
  const first = parseHTMLDocument(
    '<div style="display:none;color:red"><span id="target" style="width:1ch;height:10vw"></span></div>',
  );
  const second = sameDocument
    ? first
    : parseHTMLDocument(
        '<div style="display:none;color:blue"><span id="target" style="width:1ch;height:10vw"></span></div>',
      );
  const oldTarget = first.document.getElementById("target"),
    newTarget = second.document.getElementById("target");
  let calls = 0,
    nested = null;
  const engine = new StyleEngine({
    deferHidden: true,
    measureText() {
      calls++;
      if (calls === 1) {
        engine.compute(second.document, [], { width: 400 });
        nested = engine.get(newTarget);
      }
      return 7;
    },
  });
  try {
    engine.compute(first.document, [], { width: 800 });
    engine.get(oldTarget);
    assert.equal(calls, 2);
    assert.equal(nested.width, 7);
    assert.equal(nested.height, 40);
    assert.equal(engine.get(newTarget), nested);
    assert.equal(
      engine.get(newTarget).color,
      sameDocument ? "rgba(255, 0, 0, 1)" : "rgba(0, 0, 255, 1)",
    );
    assertions += 5;
    if (!sameDocument) {
      assert.equal(engine.get(oldTarget).width, "auto");
      assertions++;
    }
  } finally {
    first.window.happyDOM.abort();
    if (!sameDocument) second.window.happyDOM.abort();
  }
}
console.log(
  JSON.stringify({
    pass: true,
    assertions,
    mode: process.argv.includes("--ses") ? "ses" : "plain",
  }),
);
