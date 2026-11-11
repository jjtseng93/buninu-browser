# SES patch queue

The vendored SES bundle is the `ses` 2.3.0 npm release (`dist/ses.mjs`,
SHA-256 `1e40a59ccf5e72da8e260dda007a19ebd20304394b1b7288d0aab21733b9cd95`).
Patch paths are relative to `vendor/ses`.

Every patch applies in numeric order to the pristine npm bundle, and the whole
queue reproduces `vendor/ses/dist/ses.mjs` exactly:

```sh
mkdir -p /tmp/ses-check && cd /tmp/ses-check
curl -sL https://registry.npmjs.org/ses/-/ses-2.3.0.tgz | tar xz
cd package && git init -q && for patch in /path/to/buninu-browser/patches/ses/0*.patch; do
  git apply "$patch"
done
cmp dist/ses.mjs /path/to/buninu-browser/vendor/ses/dist/ses.mjs
```

For the already-patched tree, verify the queue without changing files, last
patch first:

```sh
for patch in $(ls -r patches/ses/0*.patch); do
  git -C vendor/ses apply --reverse --check "../../$patch"
done
```

| Patch | Modified file | Reason | Verification |
|---|---|---|---|
| `0001-allow-regexp-own-tostring.patch` | `dist/ses.mjs` | Add `%RegExpPrototype%` to the `severe` override enablements, so a page script can assign its own `toString`, `exec` or other method to a `RegExp` instance despite the frozen prototype (the override mistake). `RegExp.prototype` itself stays read-only: assigning to it still throws. As with the existing `severe` enablements, the prototype's data properties become accessors, so their descriptors report `get`/`set`; measured regex throughput under `lockdown()` is unchanged. | `bun test test/page-scripts.test.js -t "RegExp instances"` |
| `0002-embedder-native-functions-source-text-sloppy-code.patch` | `dist/ses.mjs` | Three embedder hooks for browser fidelity: (1) the toString taming's `markVirtualizedNativeFunction` is left on the host global under `Symbol.for("ses.markVirtualizedNativeFunction")` (taken and deleted by `lib/renderer/native-functions.js`) so Web APIs print as `[native code]`, and the taming's own `toString` is marked native; (2) a `Symbol.for("ses.setFunctionSourceTextTransform")` setter lets the embedder map rewritten source text back to the page's text in `Function.prototype.toString`; (3) an `__sloppyCode__` evaluate option drops the evaluator's `'use strict'`, so classic scripts run as sloppy-mode code. Page code only gets (3) for sources the rewriter parsed, which routes every sloppy `this` through a helper that never yields the host global. | `bun test test/page-scripts.test.js test/script-rewrite.test.js` |
| `0003-cache-sloppy-evaluators.patch` | `dist/ses.mjs` | `evaluate()` with `sloppyGlobalsMode` or `__sloppyCode__` built a new safe evaluator on every call (scanning the global object for constants and compiling a new evaluator function), which made each page `eval`, `Function` and classic script cost hundreds of microseconds. The evaluator is now kept per compartment and option combination; it only binds non-writable, non-configurable globals as constants, which cannot change. `__moduleShimLexicals__` evaluations are not cached. | `bun test test/page-scripts.test.js test/script-rewrite.test.js` |

Keep future local SES changes in numbered patches and update this manifest.
