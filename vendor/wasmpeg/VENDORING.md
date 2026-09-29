# Vendored wasmpeg CPU 1.0.1

This directory contains the JavaScript and CPU WebAssembly files from the
`@wasmpeg/cpu` 1.0.1 npm release. The WebAssembly and `dist/cpu.js` are
unmodified; the JavaScript loader carries the local patches recorded in
[`patches/wasmpeg/`](../../patches/wasmpeg/README.md) (currently one line in
`src/js/gpu.js`, so the WASM path works on Windows). It also keeps the release's LGPL
license and FFmpeg notice. Buninu Browser loads only `src/js/index.js` and
`dist/cpu.js`/`dist/cpu.wasm`; no native media bindings are used.

The complete corresponding source is included as `source-v1.0.1.tar.gz`. It
contains wasmpeg's JavaScript and C code, its vendored FFmpeg source tree,
license files, and build scripts. It is a `git archive` of upstream tag
[`v1.0.1`](https://github.com/wasmpeg/wasmpeg/tree/v1.0.1), commit
`173b41e30f4dd21d15f4e564c3ad26cba5d89d80`.
The source archive includes FFmpeg's optional GPL files; the shipped CPU
binary is the upstream LGPL preset and does not link those optional codecs.
The vendored `src/js` files match that tag byte for byte apart from those
patches. Upstream's CPU LGPL
build command is `PRESET=lgpl TARGET=cpu bash scripts/build.sh`, after setting
up Emscripten SDK 6.0.8 as described by its build instructions. This repository
distributes the published binary rather than rebuilding it.

SHA-256 of the published release artifacts:

| File | SHA-256 |
|---|---|
| `dist/cpu.js` | `9f31a4ed555f74ef3744769d631e5f961ba10611e24509bbd369ea35da210878` |
| `dist/cpu.wasm` | `c752f1a2d7f99cfb96f86b24aede0153e5b4a417938324723bbe88e763c91bba` |
| `source-v1.0.1.tar.gz` | `b811cd4b3206a703175a07f76b75c0be96d68f87d1d92784c08a7418958f43e4` |

The browser loads `dist/cpu.wasm` as a separate file at runtime. A user may
replace it with a compatible WASM build at that path without changing Buninu
Browser's code. Modified wasmpeg or FFmpeg builds retain their respective LGPL
source and notice obligations.

The upstream build uses Emscripten's zlib port. The shipped WASM identifies
zlib 1.3.2; its license and source are recorded in the repository's
`LICENSES/zlib.txt` and `THIRD_PARTY_NOTICES.md`.
