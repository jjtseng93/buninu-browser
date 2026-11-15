# Flea QML startup measurements

Run from native Termux, not inside proot. The application entry is
`file://.../flea-qml/ui/boot/shell.qml` in the sibling checkout. Measurements
include a fresh browser process; no persistent compiled-QML cache is used.
Do not run multiple benchmarks simultaneously.

## Headless renderer

```sh
bun test/manual-flea-startup.js --runs=3 --output="$TMPDIR/flea-headless-results"
```

Creates three temporary folders, checks their names and folder glyph through
CDP, and saves a PNG. Inspect the PNG: DOM text alone does not prove painting.
The timer ends when the CDP screenshot arrives, excluding terminal transport.
The 100ms polling interval and time spent awaiting a busy renderer affect the
observation; this is not an exact timestamp for the first painted pixel.
The 120-second watchdog belongs to the diagnostic, not browser startup policy.

## Casty and Kitty transport

```sh
bun test/manual-flea-casty-startup.js "$TMPDIR/flea-kitty-results"
bun test/manual-flea-casty-startup.js "$TMPDIR/flea-home-results" --path="$HOME"
```

Output directories must be empty. The default creates three temporary folders;
`--path` uses an existing directory and does not remove it during cleanup.
The test starts the sibling Casty checkout with `CASTY_BROWSER` pointing to
this browser, preserves the user's configuration, and supplies a 1280×800
Kitty peer supporting inline PNG. A manually configured incompatible image
format can prevent recording; inspect `terminal.log` if no PNG frames arrive.

For 15 seconds it records complete page image packets without evaluating page
JavaScript. `frames.json` contains packet-arrival times; inspect the PNGs to
find the first one with folder icons. URL-bar overlays are excluded. Packet
arrival does **not** measure WebView decoding, painting or screen presentation.
Owned Casty/browser processes are stopped after measurement.

## Recorded native Android results

Bun 1.4.4, ROG Phone 9 Pro Edition, 2026-11-15. These are sequential runs,
not a controlled thermal/frequency experiment; small differences are noise.

| Checkpoint | Headless screenshot completion, three runs |
| --- | --- |
| Before the final native optimization passes | 5.68 / 5.22 / 4.97 s |
| Skip disposable component DOM trees | 3.85 / 3.55 / 3.57 s |
| Reuse local declaration analysis | 3.73 / 3.39 / 3.46 s |
| Overlap initial blank and confirmed local QML renderer startup | 3.18 / 2.89 / 2.87 s |
| Read published style snapshots instead of serializing CSS | 3.17 / 2.85 / 2.88 s |

The large change after skipping disposable DOM also coincided with faster
unmodified phases, so it cannot all be attributed to that change. Startup logs
do confirm parallel renderer initialization for the overlap change.

Casty at 1280×800 received the complete three-folder frame at **3.10 s**.
The real home directory listed **408 items**; its first frame showing visible
folder icons arrived at **3.85 s**. These use a different viewport and endpoint
from the 900×600 headless test and are not interchangeable measurements.

The remaining work is mostly QML compilation/instance initialization and CSS
style computation, with additional delegate work for larger directories.
Existing isolation remains: only a successfully fetched local QML document
gets an application host; ordinary HTML stays sandboxed. Prepared hosts are
closed on failed startup or browser shutdown. Compiler caches are scoped to
one compilation; the optional script worker is closed with its renderer.

Final native regression check passed 46 tests across nine files: outline
painting, inline-block/math spacing, inline geometry/SVG text, MathML layout,
SVG text rasterization, QML language/style updates, spare-renderer lifecycle
and the Kitty measurement peer. A separate 42-test pass covered initial
renderer isolation, QML imports/dynamic components and lifecycle. These are
targeted regression runs, not a claim that the entire browser test suite passes.
