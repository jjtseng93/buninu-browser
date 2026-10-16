#!/usr/bin/env bun
// Compare deterministic script preparation, independent of network/site timing.
import { resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";

const [modulePath = "lib/renderer/script-rewrite.js", ...files] = process.argv.slice(2);
const { rewriteClassicScriptSource } = await import(pathToFileURL(resolve(modulePath)).href);
const cases = [
  ["top-level-functions", Array.from({ length: 3000 }, (_, i) =>
    `function function${i}(x) { return callback(x) + this.offset + value${i}; }`).join("\n")],
  ["bundled-functions", `(function(){${Array.from({ length: 3000 }, (_, i) =>
    `function function${i}(x) { return callback(x) + this.offset + value${i}; }`).join("\n")}result = function2999(1);})();`],
];
for (const file of files) cases.push([basename(file), await Bun.file(file).text()]);
for (const [name, source] of cases) {
  const samples = []; let result;
  for (let i = 0; i < 7; i++) {
    Bun.gc(true);
    const start = performance.now(); result = rewriteClassicScriptSource(source);
    samples.push(performance.now() - start);
  }
  const sorted = samples.slice(2).sort((a, b) => a - b);
  console.log(JSON.stringify({ name, inputLength: source.length, outputLength: result.code.length,
    outputHash: Bun.hash(result.code).toString(16), parsed: result.parsed, medianMs: sorted[2], samples }));
}
