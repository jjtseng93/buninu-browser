import { expect, test } from "bun:test";
import { parseHTMLDocument } from "../lib/happy-dom/parser.js";
import { StyleEngine } from "../lib/style/computed-style.js";

test("computed font-metric dependencies include resolved variables, pseudos and root lengths", () => {
  const cases = [
    ["#box{font-size:20px;line-height:normal;width:10em;height:2rem}", false],
    ["#box{--unused:10ch;width:20px}", false],
    ["#box{width:10ch}", true],
    ["body{--size:4ch}#box{width:calc(var(--size) + 2px)}", true],
    ["#box{width:var(--missing,3ch)}", true],
    ["#box::before{content:'x';width:2ch}", true],
    ["html{font-size:2ch}#box{width:10rem}", true],
  ];
  for (const [sheet, dependent] of cases) {
    const { document, window } = parseHTMLDocument('<div id="box">text</div>');
    try {
      const engine = new StyleEngine({ measureText: () => 7 }).compute(document, [sheet]);
      expect(engine.usesFontMetrics).toBe(dependent);
      engine.compute(document, [sheet], {}, new Set(), new Set([document.getElementById("box")]));
      expect(engine.usesFontMetrics).toBe(dependent);
    } finally { window.happyDOM.abort(); }
  }
});

test("font-metric dependencies survive incremental changes but reset for a new document", () => {
  const first = parseHTMLDocument('<div id="box" style="width:2ch">first</div>');
  const second = parseHTMLDocument('<div>second</div>');
  try {
    const engine = new StyleEngine({ measureText: () => 8 }).compute(first.document);
    expect(engine.usesFontMetrics).toBe(true);
    first.document.getElementById("box").style.width = "20px";
    engine.compute(first.document, [], {}, new Set(), new Set([first.document.getElementById("box")]));
    expect(engine.usesFontMetrics).toBe(true);
    engine.compute(second.document);
    expect(engine.usesFontMetrics).toBe(false);
  } finally { first.window.happyDOM.abort(); second.window.happyDOM.abort(); }
});

test("font completion refreshes geometry with pixel parity while avoiding unnecessary cascades", async () => {
  const child = Bun.spawn([process.execPath, new URL("./fixtures/font-metrics-invalidation.js", import.meta.url).pathname], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, error }).toEqual({ code: 0, error: "" });
  expect(out).toContain("font metrics invalidation integration passed");
}, 30_000);

test("font definition edits refresh geometry and pixels without unnecessary full cascades", async () => {
  const child = Bun.spawn([process.execPath, new URL("./fixtures/font-definition-invalidation.js", import.meta.url).pathname], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, error }).toEqual({ code: 0, error: "" });
  expect(out).toContain("font definition invalidation integration passed");
}, 30_000);
