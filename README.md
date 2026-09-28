# Buninu Browser

**A headless browser engine written in JavaScript for Bun.**

Buninu Browser is an experimental effort to replace Chromium Headless
Shell in Buninu Linux with a browser engine whose userspace components
can be inspected, modified, and executed directly as JavaScript and
WebAssembly.

It implements its own browser lifecycle, rendering pipeline, process
model, layout integration, and headless interface while building on
selected open-source implementations of web standards.

> [!WARNING]
> Buninu Browser is in an early experimental stage and is not yet a
> general-purpose replacement for Chromium.

## Built on open source
Buninu Browser vendors or adapts selected components from:

- **Happy DOM** — DOM, HTML elements, events, and Web APIs
- **parse5** — standards-compliant HTML parsing
- **Dropflow** — block, inline, and text layout foundations
- **TermDOM** — flex, grid, table, and invalidation references
- **CanvasKit** — Skia-based WASM rasterization
- **HarfBuzz WASM** — text shaping
- **Web Platform Tests** — conformance testing

These projects retain their respective licenses and attribution.
Buninu Browser maintains its own render tree, browser lifecycle,
security model, layout integration, display list, and headless API.
