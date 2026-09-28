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

Happy DOM is currently kept as an unmodified upstream baseline. Buninu Browser
code must access it through project-owned adapters. If local patches are added,
their source file, upstream commit, reason, and corresponding tests must be
recorded here or in an adjacent patch manifest.

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
