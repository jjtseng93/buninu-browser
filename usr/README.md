# Runtime assets

This directory is the standalone runtime asset root. Its layout deliberately
resembles a small `/usr` tree so application code can resolve stable paths in
both standalone checkouts and Buninu Linux images.

| Standalone path | Buninu Linux source | Buninu Linux installed target |
|---|---|---|
| `usr/lib/canvaskit/` | `initramfs/lib/canvaskit/` | `/lib/canvaskit/` |
| `usr/share/fonts/` | `initramfs/usr/share/fonts/` | `/usr/share/fonts/` |

In a standalone distribution these are vendored files, including their license
texts. When Buninu Browser is packaged inside Buninu Linux, replace the two
entries above with symlinks to the installed targets instead of shipping a
second copy. Do not commit absolute symlinks in this standalone checkout: they
would be broken on ordinary development hosts.

Do not inherit Buninu Linux's `/lib/canvas.js`: it is a framebuffer adapter and
imports `fbdev.js`, which in turn uses Bun FFI. The headless engine loads the
vendored CanvasKit module/WASM directly and will provide its own raster adapter.
