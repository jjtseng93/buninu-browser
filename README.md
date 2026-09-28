# Buninu Browser

**Buninu Browser is a browser engine written in JavaScript and WebAssembly for Bun.**

Its first frontend is a headless shell intended to replace Chromium Headless
Shell in Buninu Linux. The engine's userspace components can be inspected,
modified, and executed directly as JavaScript and WebAssembly.

Future Win32, GTK, Android, and other windowed frontends should remain thin
platform adapters. They provide a native window and drawing surface, forward
input, clipboard, and IME events, and present frames produced by the shared
engine; DOM, JavaScript, navigation, layout, paint, networking, and automation
remain in the platform-independent core.

Original Buninu Browser code is licensed under the MIT License. Standalone
graphics and font assets live under [`usr/`](usr/); Buninu Linux packages use
symlinks to their system copies instead. See [`usr/README.md`](usr/README.md)
and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

It implements its own browser lifecycle, rendering pipeline, process model,
layout integration, and automation interface while building on selected
open-source implementations of web standards.

The first integration target is `../casty`: minimal compatible CDP discovery,
target lifecycle, navigation, screenshot/screencast, viewport, and input are
part of the initial vertical slice rather than a later compatibility layer.

The top-level [`buninu-browser.js`](buninu-browser.js) is both the executable
and public module entry. Its CLI startup is guarded by `import.meta.main`, so
importing the package does not start a browser process or CDP listener.

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
| **SES (Hardened JavaScript)** | Planned: first sandbox layer for page scripts (`lockdown()` and compartments) | Pin an exact npm release when it is introduced; keep page globals behind project-owned bindings |
| **Web Platform Tests** | Conformance testing | Use a pinned external checkout or sparse test snapshot; do not place the complete WPT repository in the runtime vendor tree |

These projects retain their respective licenses and attribution. Material that
is actually distributed in this repository is recorded in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), with license texts under
[`LICENSES/`](LICENSES/). Buninu Browser maintains its own render tree, browser
lifecycle, security model, layout integration, display list, and automation API.
