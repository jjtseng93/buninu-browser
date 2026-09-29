# Buninu Browser

**Buninu Browser is a browser engine written in JavaScript and WebAssembly for Bun.**

Its first frontend is a headless shell intended to replace Chromium Headless
Shell in Buninu Linux. The engine's userspace components can be inspected,
modified, and executed directly as JavaScript and WebAssembly.

## Why replace Chromium Headless Shell

Buninu Browser exists to work together with
[casty](https://github.com/jjtseng93/casty), a terminal browser that renders
pages by driving a headless browser over the Chrome DevTools Protocol and
drawing its frames in the terminal. The fork linked here (of
[sanohiro/casty](https://github.com/sanohiro/casty)) adapts casty to Buninu
Linux. casty normally launches Chromium Headless Shell; Buninu Browser is
meant to take that place as a CDP backend written in JavaScript and
WebAssembly, so casty can run in Bun-only environments such as Buninu Linux
without a native Chromium binary.

Compatibility with casty is therefore part of the initial vertical slice
rather than a later layer: CDP discovery, target lifecycle, navigation,
screenshots and screencast, viewport, and input. Early development and every
screen test so far have been done in casty itself. The
[`test/chromium-headless-shell`](test/chromium-headless-shell) shim puts
Buninu Browser where casty looks for Chromium:

```sh
PATH="$PWD/test:$PATH" bun ../casty/bin/casty.js buninu.org
```

## Design

Future Win32, GTK, Android, and other windowed frontends should remain thin
platform adapters. They provide a native window and drawing surface, forward
input, clipboard, and IME events, and present frames produced by the shared
engine; DOM, JavaScript, navigation, layout, paint, networking, and automation
remain in the platform-independent core.

Original Buninu Browser code is licensed under the MIT License. Standalone
graphics and font assets live under [`usr/`](usr/); Buninu Linux packages use
symlinks to their system copies instead. See [`usr/README.md`](usr/README.md)
and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
Video decoding uses the separately stored `vendor/wasmpeg/dist/cpu.wasm`,
which contains FFmpeg code under LGPL-2.1-or-later. The MIT license does not
cover that third-party component. Its license, notice, exact release source,
build instructions, and replacement path are documented in
[`vendor/wasmpeg/VENDORING.md`](vendor/wasmpeg/VENDORING.md).

It implements its own browser lifecycle, rendering pipeline, process model,
layout integration, and automation interface while building on selected
open-source implementations of web standards.

The top-level [`buninu-browser.js`](buninu-browser.js) is both the executable
and public module entry. Its CLI startup is guarded by `import.meta.main`, so
importing the package does not start a browser process or CDP listener.

### Page sandbox

Page JavaScript runs behind three layers:

1. **SES and bindings.** The renderer calls `lockdown()`, and each document
   gets its own compartment. That compartment sees only project-owned DOM
   and Web API bindings, never Bun, `process`, or Happy DOM objects.
2. **Process isolation.** The controller spawns one renderer per origin with
   an empty environment, talks to it over IPC, and kills and restarts it if
   it misses a deadline. Cookies, CORS, redirects, and history stay in the
   controller. A cross-origin navigation moves to a fresh, pre-warmed
   process. Isolation is per origin rather than per site because no Public
   Suffix List is bundled.
3. **seccomp.** Before lockdown, each renderer installs a syscall allowlist
   modelled on Chromium's baseline policy.

`--no-sandbox` is accepted for Chromium compatibility but ignored.
`--dangerously-allow-host-js` turns the sandbox off for every page.

### Rendering and loading

Each renderer has two threads, following Chromium's main and compositor
threads:

- The **main thread** runs page scripts, style, layout, and raster.
- The **compositor thread** is a Worker that keeps the latest raster tile. It
  answers screenshots and scrolling over its own socket to the controller,
  so the page stays visible and scrollable while the main thread is busy
  with a relayout or a long script.

When idle, the main thread rasterizes a tile reaching half a viewport above
and one viewport below the visible area, so the compositor can scroll
without waiting. Screenshots are encoded with `Bun.Image`.

`<video>` can decode and display MP4 video frames after a click, with a basic
play/pause control. Video bytes are fetched through the controller; the
renderer uses vendored wasmpeg JavaScript and WebAssembly without native
media bindings. Audio, seeking, and full HTML media controls are not yet
implemented. No npm install is needed for the decoder.

Documents load in stages:

1. **Preview.** If stylesheets and images take longer than 300 ms, the
   document is shown first with only the user-agent defaults and its inline
   `<style>` sheets.
2. **Styled page.** When the stylesheets and images arrive, the styled page
   replaces the preview and keeps the scroll position.
3. **Scripts.** Scripts run after that.

`Page.navigate` returns at the first paint. `DOMContentLoaded` and `load`
are reported over CDP when the page reaches them. Every visible change
pushes a screencast frame.

### Mobile presentation

Pages see a desktop browser unless `--mobile` is given. With it, requests
and `navigator.userAgent` use an Android 16 WebView user agent, and the
`hover`/`pointer` media features report a touch screen (`hover: none`,
`pointer: coarse`). User agent overrides sent over CDP are ignored so the
flag stays in effect under clients that set a desktop user agent, such as
casty. A viewport wider than 412 CSS pixels, a phone's width, is laid out
412 pixels wide and scaled up to fill it, so frames keep the size the client
asked for; input coordinates are scaled back, and pages see the factor as
`visualViewport.scale`.

```sh
CASTY_BROWSER="$PWD/buninu-browser.js" bun ../casty/bin/casty.js github.com -- --mobile
```

### Diagnostics

casty does not show the browser's stderr. Set `BUNINU_LOG=1` to also write
it to `buninu-browser.log` in the working directory, or set
`BUNINU_LOG=<path>` to choose the file. The log includes:

- page errors and page `console` output;
- per-phase load timings;
- renderer crashes and watchdog kills.

Renderers cannot open files under seccomp, so the controller collects their
output and writes the log.

```sh
BUNINU_LOG=1 PATH="$PWD/test:$PATH" bun ../casty/bin/casty.js github.com
```

> [!WARNING]
> Buninu Browser is in an early experimental stage and is not yet a
> general-purpose browser engine or replacement for Chromium. The headless
> shell is the initial frontend; native windowed frontends are planned later.

## Open-source components

The integration form is intentionally different for each upstream:

| Component | Role | Source policy |
|---|---|---|
| **Happy DOM** | DOM, HTML elements, events, Web APIs, and selector matching | Vendored at an exact tag; accessed through project-owned adapters, with local changes recorded in [`patches/happy-dom/`](patches/happy-dom/) |
| **Happy DOM HTMLParser** | Initial HTML parsing and tree construction | Use through the project parser adapter; keep scripts and subresource loading disabled until the renderer scheduler owns their lifecycle |
| **Dropflow** | Structural reference for block formatting, anonymous boxes, and margin collapsing | Reference only: the layout is a clean reimplementation and no Dropflow source is copied; vendor an exact commit first if code is ever ported |
| **TermDOM** | Flex, grid, table, and invalidation references; hand-derived test cases | Port selected tests with per-file attribution (flex and grid so far); algorithms are written from the CSS specifications |
| **Chromium** | Behavioural reference; Linux syscall tables and the renderer seccomp policy structure | Use only BSD-3-Clause files, with attribution; Blink files under other licenses (such as the LGPL `html.css`) are not used |
| **WHATWG HTML Standard** | User-agent default styles | Adapt the suggested rendering rules (§15.3) with attribution under CC BY 4.0 |
| **CanvasKit** | Skia-based WASM rasterization and text shaping (SkParagraph with its bundled HarfBuzz) | Pin the official `canvaskit-wasm` release artifacts and integrity; do not vendor the full Skia repository or a separate HarfBuzz |
| **SES (Hardened JavaScript)** | First sandbox layer for page scripts: `lockdown()` and one compartment per document | Vendored unmodified at an exact npm release in [`vendor/ses/`](vendor/ses/); page globals are project-owned bindings, never Happy DOM objects |
| **Acorn** | JavaScript parser used to give classic scripts browser-style shared globals under SES | Vendored unmodified at an exact npm release in [`vendor/acorn/`](vendor/acorn/) |
| **wasmpeg / FFmpeg** | CPU WebAssembly video decoding | Vendored `@wasmpeg/cpu` 1.0.1 under [`vendor/wasmpeg/`](vendor/wasmpeg/), licensed LGPL-2.1-or-later; the WASM remains a separate, replaceable file. See its [`VENDORING.md`](vendor/wasmpeg/VENDORING.md) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) |
| **Web Platform Tests** | Conformance testing | Use a pinned external checkout or sparse test snapshot; do not place the complete WPT repository in the runtime vendor tree |

These projects retain their respective licenses and attribution. Material that
is actually distributed in this repository is recorded in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), with license texts under
[`LICENSES/`](LICENSES/). Buninu Browser maintains its own render tree, browser
lifecycle, security model, layout integration, display list, and automation API.
