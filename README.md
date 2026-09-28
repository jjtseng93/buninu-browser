# Buninu Browser

**A headless browser engine written in JavaScript for Bun.**

Buninu Browser is an experimental effort to replace Chromium Headless
Shell in Buninu Linux with a browser engine whose userspace components
can be inspected, modified, and executed directly as JavaScript and
WebAssembly.

Original Buninu Browser code is licensed under the MIT License. Standalone
graphics and font assets live under [`usr/`](usr/); Buninu Linux packages use
symlinks to their system copies instead. See [`usr/README.md`](usr/README.md)
and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

It implements its own browser lifecycle, rendering pipeline, process
model, layout integration, and headless interface while building on
selected open-source implementations of web standards.

The first integration target is `../casty`: minimal compatible CDP discovery,
target lifecycle, navigation, screenshot/screencast, viewport, and input are
part of the initial vertical slice rather than a later compatibility layer.

> [!WARNING]
> Buninu Browser is in an early experimental stage and is not yet a
> general-purpose replacement for Chromium.

## Open-source components

The planned integration form is intentionally different for each upstream:

| Component | Role | Source policy |
|---|---|---|
| **Happy DOM** | DOM, HTML elements, events, and Web APIs | Vendored at an exact tag; accessed through a project-owned adapter |
| **parse5** | Standards-compliant HTML parsing | Exact package dependency; do not vendor separately while Happy DOM supplies the required version |
| **Dropflow** | Block, inline, float, and text layout foundations | Vendor an exact commit before porting because derived algorithms and its bundled third-party code need source-level provenance |
| **TermDOM** | Flex, grid, table, invalidation, and test references | Reference upstream; copy only selected algorithms/tests with per-file attribution when a port is approved |
| **CanvasKit** | Skia-based WASM rasterization | Pin the official `canvaskit-wasm` release artifacts and integrity; do not vendor the full Skia repository |
| **HarfBuzz** | Text shaping | Prefer the implementation already carried by the chosen Dropflow/CanvasKit build; vendor a separate WASM build only if the text-engine boundary requires it |
| **Web Platform Tests** | Conformance testing | Use a pinned external checkout or sparse test snapshot; do not place the complete WPT repository in the runtime vendor tree |

These projects retain their respective licenses and attribution. Material that
is actually distributed in this repository is recorded in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), with license texts under
[`LICENSES/`](LICENSES/). Buninu Browser maintains its own render tree, browser
lifecycle, security model, layout integration, display list, and headless API.
