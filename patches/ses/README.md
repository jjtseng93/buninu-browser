# SES patch queue

The vendored SES bundle is the `ses` 2.3.0 npm release. Patch paths are
relative to `vendor/ses`.

For the already-patched tree, verify the recorded patch without changing files:

```sh
git -C vendor/ses apply --reverse --check ../../patches/ses/0001-allow-regexp-own-tostring.patch
```

| Patch | Modified file | Reason | Verification |
|---|---|---|---|
| `0001-allow-regexp-own-tostring.patch` | `dist/ses.mjs` | Allow a page script to assign an own `toString` method to a `RegExp` instance despite the frozen prototype. This does not make the prototype writable. | `bun test test/page-scripts.test.js` |

Keep future local SES changes in numbered patches and update this manifest.
