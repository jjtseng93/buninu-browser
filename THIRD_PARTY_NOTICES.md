# Third-Party Notices

This file records third-party material that is present in this repository.
Planned or referenced dependencies are listed separately in `README.md` and do
not become distributed components until their source or artifacts are added.

## Happy DOM

- Project: Happy DOM
- Upstream: https://github.com/capricorn86/happy-dom
- Version: `v20.14.5`
- Commit: `0d4cdbe7442af49d16b49ddf1acf7cc9684ed318`
- Vendored path: `vendor/happy-dom`
- License: MIT
- Copyright: Copyright (c) 2019 David Ortner (capricorn86)
- Local license copy: `LICENSES/happy-dom.txt`
- Upstream license: `vendor/happy-dom/LICENSE`

Happy DOM starts from the exact upstream revision above and carries the local
patch queue documented in [`patches/happy-dom/README.md`](patches/happy-dom/README.md).
Project-specific behavior belongs in project-owned adapters; every necessary
upstream-file modification must be recorded in that queue with its reason and
corresponding test.

## SES (Hardened JavaScript)

- Project: SES, part of Endo
- Upstream: https://github.com/endojs/endo/tree/master/packages/ses
- Version: `2.3.0` (npm release, `dist/ses.mjs`)
- Vendored path: `vendor/ses`
- License: Apache-2.0
- Copyright: Copyright Agoric and contributors (see `vendor/ses/LICENSE`)
- Local license copies: `LICENSES/ses.txt`, plus the licenses SES carries for
  code it derives from: `LICENSES/ses-aura.txt` (Salesforce Aura),
  `LICENSES/ses-caja.txt` (Google Caja, Apache-2.0), `LICENSES/ses-corejs.txt`
  (core-js, MIT), `LICENSES/ses-v8.txt` (V8, BSD-3-Clause)

The renderer calls `lockdown()` and runs page scripts in SES compartments
(`lib/renderer/page-realm.js`). The bundle is used unmodified; its SHA-256 is
`1e40a59ccf5e72da8e260dda007a19ebd20304394b1b7288d0aab21733b9cd95`.

## Acorn

- Project: Acorn
- Upstream: https://github.com/acornjs/acorn
- Version: `8.18.0` (npm release, `dist/acorn.mjs`)
- Vendored path: `vendor/acorn`
- License: MIT
- Copyright: Copyright (C) 2012-2022 by various contributors (see upstream AUTHORS)
- Local license copy: `LICENSES/acorn.txt`

`lib/renderer/script-rewrite.js` parses classic scripts with Acorn to lift
top-level declarations onto the page's global object. The bundle is used
unmodified; its SHA-256 is
`953573b8fdab71599749ea5f2b33d3e760c2116178f9423ee7458dbe39d59453`.

## wasmpeg / FFmpeg

- Project: wasmpeg CPU build, incorporating FFmpeg
- Upstream: https://github.com/wasmpeg/wasmpeg
- Version: `@wasmpeg/cpu` 1.0.1, upstream tag `v1.0.1`, commit
  `173b41e30f4dd21d15f4e564c3ad26cba5d89d80`
- Vendored path: `vendor/wasmpeg`
- License: LGPL-2.1-or-later for wasmpeg and its FFmpeg code
- Local license copies: `vendor/wasmpeg/LICENSE`, `LICENSES/wasmpeg.txt`
- Upstream notice copy: `vendor/wasmpeg/NOTICE`
- Corresponding source, including the FFmpeg tree and build scripts:
  `vendor/wasmpeg/source-v1.0.1.tar.gz`, mirrored from
  https://github.com/wasmpeg/wasmpeg/tree/v1.0.1

`cpu.js` and `cpu.wasm` are copied without modification from the published CPU
npm package. The JavaScript sources are copied from it with the local changes
recorded in [`patches/wasmpeg/`](patches/wasmpeg/README.md): one line of
`src/js/gpu.js`, so the WASM path also resolves on Windows. `cpu.wasm` is a separate file that users
can replace. The exact artifact hashes, source download, and rebuild command
are in [`vendor/wasmpeg/VENDORING.md`](vendor/wasmpeg/VENDORING.md).

The CPU build also links the Emscripten zlib port. Its binary reports zlib
1.3.2; zlib is copyright (C) 1995-2026 Jean-loup Gailly and Mark Adler and
uses the zlib license. The license text is in `LICENSES/zlib.txt`, and its
source is https://github.com/madler/zlib/tree/v1.3.2 .

The generated `cpu.js`/`cpu.wasm` artifacts also contain Emscripten runtime
code. Upstream's build instructions pin Emscripten SDK 6.0.8. Emscripten's
MIT / University of Illinois-NCSA license text (including its embedded
third-party notices) is in `LICENSES/emscripten.txt`; source:
https://github.com/emscripten-core/emscripten/tree/6.0.8 .

## TermDOM-derived references

- Project: TermDOM
- Upstream: https://github.com/bikeshaving/termdom
- Commit: `b92f36d5f3d83770f3ea8c38fdeae0a192dc235e`
- License: MIT
- Copyright: Copyright (c) 2026 Brian Kim
- Local license copy: `LICENSES/termdom.txt`

The initial computed-style model and its tests are informed by TermDOM's UA
stylesheet categories and cascade tests. Buninu Browser retains its own DOM,
style representation, CSS parser boundary, pixel layout, and implementation.

`test/flex.test.js` ports cases from TermDOM's `tests/flex.test.ts`
(flex-basis, §9.7 min/max freezing, auto margins, gaps, automatic minimum
size), keeping TermDOM's hand-derived expected values and re-expressing each
case as an HTML/CSS fixture. The flex layout in `lib/layout/text-layout.js`
also follows TermDOM's `resolveFlexibleLengths` rule that growing requires a
definite main size; no TermDOM source text is copied.

`test/grid.test.js` likewise ports TermDOM's `tests/grid.test.ts` cases for
track sizing, `repeat()`/`auto-fill`/`auto-fit`, line placement, sparse and
dense auto-placement, implicit tracks, gaps, and alignment, re-expressed as
HTML fixtures in a 30px-wide container with 1px characters (TermDOM's 30-cell
terminal). The grid layout itself is written from the CSS Grid 2 algorithm.

## Chromium (Blink) references

- Project: Chromium
- Upstream: https://chromium.googlesource.com/chromium/src
- Commit: `2e7327eeeab051c4837bc03a17cbeae763449bcd`
- License: BSD-3-Clause
- Copyright: Copyright The Chromium Authors (per-file years, e.g. 2012, 2013, 2014, 2024)
- Local license copy: `LICENSES/chromium.txt`

Only Chromium files under the BSD-3-Clause `LICENSE` are used. Blink files
under other licenses (for example the LGPL `html.css` user-agent stylesheet)
are not used; user-agent defaults come from the HTML Standard instead.

`resolveFlexibleLengths` in `lib/layout/text-layout.js` follows the behavior of
Blink's `third_party/blink/renderer/core/layout/flex/line_flexer.cc`
(content-box flex base sizes, early exit when free space has the wrong sign,
freezing by total violation). It is a JavaScript reimplementation of that
behavior; no Chromium source text is copied.

`lib/renderer/syscall-numbers.js` is generated from Chromium's
`sandbox/linux/system_headers/x86_64_linux_syscalls.h` and
`arm64_linux_syscalls.h` (syscall number tables). The renderer seccomp policy in
`lib/renderer/seccomp.js` follows the structure of Chromium's
`sandbox/linux/seccomp-bpf-helpers/baseline_policy.cc` and `syscall_sets.cc`
(allowlist categories, threads-only `clone`, `clone3` as `ENOSYS`, signals only
to the own process); the BPF program itself is written in JavaScript.

Two performance designs follow BSD-licensed Chromium files; both are
reimplemented in JavaScript, and no Chromium source text is copied:

- Declaration blocks are parsed on first use (`lib/style/computed-style.js`),
  after `third_party/blink/renderer/core/css/parser/css_lazy_parsing_state.cc`.
- A rebuild that yields an unchanged display list reuses the previous raster
  tile (`lib/renderer/page-renderer.js`), after the display-item reuse in
  `third_party/blink/renderer/platform/graphics/paint/paint_controller.cc`.

## PulseAudio native protocol (independent implementation)

`lib/audio/pulse-client.js` is the client side of the PulseAudio native
protocol (protocol version 8: command packets as tagstructs, audio frames with
a 20-byte header), written for this project from the protocol's documented
wire format. It contains no source code from PulseAudio or from jspulse, both
of which are LGPL-licensed; jspulse was used only as a separate server process
to test against, never imported by this repository's code or tests.

## WHATWG HTML Standard

- Project: HTML Living Standard
- Upstream: https://html.spec.whatwg.org/multipage/rendering.html
- License: Creative Commons Attribution 4.0 International (CC BY 4.0)
- Copyright: Copyright © WHATWG (Apple, Google, Mozilla, Microsoft)
- License text: `LICENSES/CC-BY-4.0.txt`
- License URL: https://creativecommons.org/licenses/by/4.0/

The user-agent default declarations in `lib/style/computed-style.js`
(`UA_DECLARATIONS`: body margin, paragraph and heading margins and sizes, list
indentation, monospace elements) are adapted from the suggested rendering rules
in the HTML Standard §15.3; this is a modified implementation rather than a
verbatim copy of that section.

## Dropflow-derived references

- Project: Dropflow
- Upstream: https://github.com/chearon/dropflow
- Commit: `13552695d3446ac68f39952ea89dc69c4499dde2`
- License: MIT
- Copyright: Copyright 2024 Caleb Hearon
- Local license copy: `LICENSES/dropflow.txt`

The initial box-layout separation is informed by Dropflow's distinction between
the initial containing block, block flow, inline formatting, and painting.
Buninu Browser retains its own JavaScript data model and CanvasKit renderer;
Dropflow and its TypeScript/WASM runtime are not distributed dependencies.

`lib/layout/text-layout.js` follows the structure of Dropflow's
`src/layout-flow.ts` (block containers of blocks versus inlines, anonymous
block boxes around inline runs, margin collapsing through margin struts). It is
a clean reimplementation over Buninu's `RenderNode` input; no Dropflow source
text is copied. Text shaping stays with CanvasKit instead of Dropflow's
HarfBuzz build.

## Standalone graphics runtime

The files below are inherited from the sibling Buninu Linux source tree for a
standalone Buninu Browser distribution. Inside a Buninu Linux image these paths
must be symlinks to the system copies instead, as documented in `usr/README.md`.

| Distributed path | Component and source | License |
|---|---|---|
| `usr/lib/canvaskit/canvaskit.js`, `canvaskit.wasm` | CanvasKit 0.41.1 from the official `canvaskit-wasm` npm release | BSD-3-Clause; `LICENSES/BSD-3-Clause-Skia.txt` |
| `usr/share/fonts/DejaVuSansMono.ttf`, `DejaVuSansMono-Bold.ttf` | DejaVu fonts 2.37 from Debian `fonts-dejavu-core` | Bitstream Vera; `LICENSES/Bitstream-Vera.txt` |
| `usr/share/fonts/NotoSansCJK-Regular.ttc` | Noto Sans CJK 2.004 from Android system fonts | SIL Open Font License 1.1; `LICENSES/OFL-1.1.txt` |
| `usr/share/fonts/NotoColorEmoji.ttf`, `NotoColorEmojiFlags.ttf` | Noto Color Emoji 2.047 from Android system fonts | SIL Open Font License 1.1 |
| `usr/share/fonts/NotoSansSymbols-Regular-Subsetted.ttf`, `NotoSansSymbols-Regular-Subsetted2.ttf` | Android Noto Sans Symbols subsets | SIL Open Font License 1.1 |
| `usr/share/fonts/Roboto-Regular.ttf` | Roboto 3.005 from Android system fonts | Apache-2.0; `LICENSES/Apache-2.0.txt` |

CanvasKit's WASM also incorporates third-party code. Its published npm
tarball supplies only Skia's top-level license, so the following license
texts are included separately based on the components identified in the
binary and CanvasKit's upstream build configuration:

| Component | License text | Source |
|---|---|---|
| HarfBuzz text shaping | `LICENSES/harfbuzz.txt` (Old MIT) | https://github.com/harfbuzz/harfbuzz |
| ICU Unicode data and processing (binary reports ICU 74) | `LICENSES/icu.txt` (Unicode License v3) | https://github.com/unicode-org/icu |
| FreeType fonts | `LICENSES/freetype.txt` (FreeType License) | https://gitlab.freedesktop.org/freetype/freetype |
| libpng | `LICENSES/libpng.txt` (PNG Reference Library License) | https://github.com/pnggroup/libpng |
| libjpeg-turbo / IJG JPEG | `LICENSES/libjpeg-turbo.txt`, `LICENSES/libjpeg-ijg.txt` (BSD-style and IJG terms) | https://github.com/libjpeg-turbo/libjpeg-turbo |
| libwebp | `LICENSES/libwebp.txt` (BSD-3-Clause) | https://github.com/webmproject/libwebp |
| Wuffs image decoding | `LICENSES/wuffs.txt` (MIT or Apache-2.0) | https://github.com/google/wuffs |
| WOFF2 fonts | `LICENSES/woff2.txt` (MIT) | https://github.com/google/woff2 |
| zlib | `LICENSES/zlib.txt` (zlib) | https://github.com/madler/zlib |
| Emscripten-generated runtime | `LICENSES/emscripten.txt` (MIT or University of Illinois/NCSA) | https://github.com/emscripten-core/emscripten |

The exact revisions of these libraries in the inherited CanvasKit binary
have not been independently reconstructed; the top-level artifact is the
official `canvaskit-wasm` 0.41.1 release.

The source asset directory also retains the license files next to the fonts and
CanvasKit artifacts. Versions and provenance above mirror
`../buninu-linux/NOTICE.md`; update both records when refreshing these files.
