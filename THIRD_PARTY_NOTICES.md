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

## WHATWG HTML Standard

- Project: HTML Living Standard
- Upstream: https://html.spec.whatwg.org/multipage/rendering.html
- License: Creative Commons Attribution 4.0 International (CC BY 4.0)
- Copyright: Copyright © WHATWG (Apple, Google, Mozilla, Microsoft)

The user-agent default declarations in `lib/style/computed-style.js`
(`UA_DECLARATIONS`: body margin, paragraph and heading margins and sizes, list
indentation, monospace elements) are adapted from the suggested rendering rules
in the HTML Standard §15.3.

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

The source asset directory also retains the license files next to the fonts and
CanvasKit artifacts. Versions and provenance above mirror
`../buninu-linux/NOTICE.md`; update both records when refreshing these files.
