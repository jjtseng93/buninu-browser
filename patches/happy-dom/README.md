# Happy DOM patch queue

The vendored Happy DOM tree is based on upstream tag `v20.14.5`, commit
`0d4cdbe7442af49d16b49ddf1acf7cc9684ed318`:

- Upstream: <https://github.com/capricorn86/happy-dom>
- Vendored tree: `vendor/happy-dom`
- Patch paths are relative to the root of the upstream Happy DOM repository.

Apply patches in numeric order after checking out the upstream commit into
`vendor/happy-dom`:

```sh
git -C vendor/happy-dom apply --check ../../patches/happy-dom/0001-use-bun-entity-adapter.patch
git -C vendor/happy-dom apply ../../patches/happy-dom/0001-use-bun-entity-adapter.patch
git -C vendor/happy-dom apply --check ../../patches/happy-dom/0002-use-bun-platform-adapters.patch
git -C vendor/happy-dom apply ../../patches/happy-dom/0002-use-bun-platform-adapters.patch
git -C vendor/happy-dom apply --check ../../patches/happy-dom/0003-defer-script-events-to-renderer.patch
git -C vendor/happy-dom apply ../../patches/happy-dom/0003-defer-script-events-to-renderer.patch
git -C vendor/happy-dom apply --check ../../patches/happy-dom/0004-insert-adjacent-html-in-order.patch
git -C vendor/happy-dom apply ../../patches/happy-dom/0004-insert-adjacent-html-in-order.patch
git -C vendor/happy-dom apply --check ../../patches/happy-dom/0005-invalidate-matches-on-structure-changes.patch
git -C vendor/happy-dom apply ../../patches/happy-dom/0005-invalidate-matches-on-structure-changes.patch
```

For the already-patched vendored tree, verify that the recorded patch can be
removed cleanly without changing files:

```sh
git -C vendor/happy-dom apply --reverse --check ../../patches/happy-dom/0001-use-bun-entity-adapter.patch
git -C vendor/happy-dom apply --reverse --check ../../patches/happy-dom/0002-use-bun-platform-adapters.patch
git -C vendor/happy-dom apply --reverse --check ../../patches/happy-dom/0003-defer-script-events-to-renderer.patch
git -C vendor/happy-dom apply --reverse --check ../../patches/happy-dom/0004-insert-adjacent-html-in-order.patch
git -C vendor/happy-dom apply --reverse --check ../../patches/happy-dom/0005-invalidate-matches-on-structure-changes.patch
```

## Patch manifest

| Patch | Modified upstream file | Reason | Verification |
|---|---|---|---|
| `0001-use-bun-entity-adapter.patch` | `packages/happy-dom/src/utilities/XMLEncodeUtility.ts` | Route entity decoding through the project-owned `Bun.markdown.render()` adapter instead of installing the external `entities` package. | `bun test test/entities-adapter.test.js` |
| `0002-use-bun-platform-adapters.patch` | `packages/happy-dom/src/file/FileReader.ts`, `packages/happy-dom/src/nodes/html-image-element/HTMLImageElement.ts`, `packages/happy-dom/src/web-socket/WebSocket.ts` | Route the remaining static package imports through project-owned adapters backed by Bun APIs, so importing the DOM tree does not require installing npm dependencies. | `bun test test/html-parser.test.js test/happy-dom-platform-adapters.test.js` |
| `0003-defer-script-events-to-renderer.patch` | `packages/happy-dom/src/nodes/html-script-element/HTMLScriptElement.ts` | Suppress Happy DOM's synthetic load/error event when its own script loader is disabled; the renderer fetches and executes scripts and dispatches the real outcome itself. | `bun test test/page-scripts.test.js` (`page-inserted scripts run; innerHTML scripts do not; on* handlers fire`) |
| `0004-insert-adjacent-html-in-order.patch` | `packages/happy-dom/src/nodes/element/Element.ts` | `insertAdjacentHTML` inserted the parsed nodes one at a time, which reversed their order at `afterbegin` and `afterend`; insert the parsed fragment as a whole. | `bun test test/page-scripts.test.js` (`insertAdjacentHTML keeps the order of the inserted nodes at every position`) |
| `0005-invalidate-matches-on-structure-changes.patch` | `packages/happy-dom/src/query-selector/QuerySelector.ts` | `Element.matches()` cached results that were invalidated only by changes to the elements the matcher visited, so structural pseudo-classes and sibling combinators stayed stale after a child list change, and `:has()` after any change in the subtree; register the parent of every visited element, and do not cache `:has()` matches. | `bun test test/happy-dom-matches.test.js` |

Keep each local Happy DOM change in a separate numbered patch and add it to
this table with its reason and focused test. When updating Happy DOM, regenerate
and re-check the queue against the new pinned commit before changing the version
record in `THIRD_PARTY_NOTICES.md`.
