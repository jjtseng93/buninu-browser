# wasmpeg patch queue

The vendored wasmpeg JavaScript is the `@wasmpeg/cpu` 1.0.1 npm release, which
matches upstream tag `v1.0.1`, commit `173b41e30f4dd21d15f4e564c3ad26cba5d89d80`:

- Upstream: <https://github.com/wasmpeg/wasmpeg>
- Vendored tree: `vendor/wasmpeg`
- Patch paths are relative to the root of the npm package (`vendor/wasmpeg`).

The patches change only wasmpeg's JavaScript loader; `dist/cpu.js` and
`dist/cpu.wasm` (FFmpeg) are the published files, unmodified.

For the already-patched vendored tree, verify that the recorded patch can be
removed cleanly without changing files:

```sh
git -C vendor/wasmpeg apply --reverse --check ../../patches/wasmpeg/0001-windows-wasm-path.patch
```

## Patch manifest

| Patch | Modified upstream file | Reason | Verification |
|---|---|---|---|
| `0001-windows-wasm-path.patch` | `src/js/gpu.js` | Read `cpu.wasm` from `fileURLToPath(path)` instead of `new URL(path).pathname`, which is `/C:/...` on Windows and not a file path there. | `bun test test/page-scripts.test.js` (every renderer start loads the decoder) |

Keep each local change in a separate numbered patch and add it to this table
with its reason and focused test. When updating wasmpeg, re-check the queue
against the new release and update `vendor/wasmpeg/VENDORING.md`.
