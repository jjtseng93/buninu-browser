# SES patch queue

The vendored SES bundle is the `ses` 2.3.0 npm release. Patch paths are
relative to `vendor/ses`.

For the already-patched tree, verify the recorded patch without changing files:

```sh
git -C vendor/ses apply --reverse --check ../../patches/ses/0002-embedder-native-functions-source-text-sloppy-code.patch
git -C vendor/ses apply --reverse --check ../../patches/ses/0001-allow-regexp-own-tostring.patch
```

| Patch | Modified file | Reason | Verification |
|---|---|---|---|
| `0001-allow-regexp-own-tostring.patch` | `dist/ses.mjs` | Allow a page script to assign an own `toString` method to a `RegExp` instance despite the frozen prototype. This does not make the prototype writable. | `bun test test/page-scripts.test.js` |
| `0002-embedder-native-functions-source-text-sloppy-code.patch` | `dist/ses.mjs` | Three embedder hooks for browser fidelity: (1) the toString taming's `markVirtualizedNativeFunction` is left on the host global under `Symbol.for("ses.markVirtualizedNativeFunction")` (taken and deleted by `lib/renderer/native-functions.js`) so Web APIs print as `[native code]`, and the taming's own `toString` is marked native; (2) a `Symbol.for("ses.setFunctionSourceTextTransform")` setter lets the embedder map rewritten source text back to the page's text in `Function.prototype.toString`; (3) an `__sloppyCode__` evaluate option drops the evaluator's `'use strict'`, so classic scripts run as sloppy-mode code. Page code only gets (3) for sources the rewriter parsed, which routes every sloppy `this` through a helper that never yields the host global. | `bun test test/page-scripts.test.js test/script-rewrite.test.js` |

Keep future local SES changes in numbered patches and update this manifest.
