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
```

For the already-patched vendored tree, verify that the recorded patch can be
removed cleanly without changing files:

```sh
git -C vendor/happy-dom apply --reverse --check ../../patches/happy-dom/0001-use-bun-entity-adapter.patch
```

## Patch manifest

| Patch | Modified upstream file | Reason | Verification |
|---|---|---|---|
| `0001-use-bun-entity-adapter.patch` | `packages/happy-dom/src/utilities/XMLEncodeUtility.ts` | Route entity decoding through the project-owned `Bun.markdown.render()` adapter instead of installing the external `entities` package. | `bun test test/entities-adapter.test.js` |

Keep each local Happy DOM change in a separate numbered patch and add it to
this table with its reason and focused test. When updating Happy DOM, regenerate
and re-check the queue against the new pinned commit before changing the version
record in `THIRD_PARTY_NOTICES.md`.
