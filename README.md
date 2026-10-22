# Buninu Browser

**Buninu Browser is a browser engine written in JavaScript and WebAssembly for Bun.**

Its first frontend is a headless shell intended to replace Chromium Headless
Shell in [Buninu Linux](https://github.com/jjtseng93/buninu-linux). The
engine's userspace components can be inspected, modified, and executed
directly as JavaScript and WebAssembly.

> [!WARNING]
> Buninu Browser is in an early experimental stage and is not yet a
> general-purpose browser engine or replacement for Chromium. The headless
> shell is the initial frontend; a standard Wayland frontend is experimental.

## Experimental Wayland frontend

`bun index.js --wayland URL` opens a standard Wayland SHM window using
`WAYLAND_DISPLAY` and `XDG_RUNTIME_DIR`. Casty remains the default.
See [frontend details and limitations](frontends/wayland/README.md).
This does not yet provide full Quickshell/Flea/Omastorm compatibility.

## Usage

```sh
# Install Bun if you don't have it
npm i -g bun

# Open casty's home page
npx buninu-browser

# Open a URL
npx buninu-browser buninu.org

# WebKit/Safari compatibility identity is the default
npx buninu-browser https://youtu.be/jf-pn0a-Twk

# Switch back to the Chromium compatibility identity
npx buninu-browser buninu.org -- --chromium

# Arguments after -- go to the
# browser engine; --mobile presents
# it as a phone (mobile user agent,
# phone-width layout)
npx buninu-browser github.com \
  -- --mobile

# The engine alone, as a CDP
# endpoint for any client
npx buninu-browser --headless \
  --remote-debugging-port=9222

# capture a page and exit
npx buninu-browser --headless --screenshot=page.png \
  --window-size=1280,800 https://example.com
```

Screenshot mode waits for the page's `load` event before capture. For content
that appears later, add `--screenshot-wait=1000` (real milliseconds). The output
format follows the filename extension: PNG, JPEG, or WebP. Chromium's
`--virtual-time-budget` is not implemented; a real-time delay does not advance
page timers the same way.

The first run downloads this package
(about 50 MB: fonts, CanvasKit and
the video decoder), then the terminal
frontend
[`@drxiaozhi/casty`](https://www.npmjs.com/package/@drxiaozhi/casty)
([source on GitHub](https://github.com/jjtseng93/casty)).
npx asks before each install.

The launcher sets `CASTY_BROWSER` to
this package's `buninu-browser.js`
and starts casty with `npx` when npx
and Bun are both installed, otherwise
with `bunx`, or `bun x`.
No adjacent casty checkout is needed. From a local Buninu Browser checkout,
`bun index.js [URL] [-- BROWSER_FLAGS...]` uses the same package-based launcher.

The engine defaults to a WebKit/Safari compatibility identity in casty,
headless, and screenshot modes. `--webkit` explicitly selects this default;
`--chromium` selects the previous desktop Chromium identity. Pass these flags
after `--` through casty, or directly after `--headless`. If both desktop flags
are supplied, the last one wins. `--mobile` takes priority over either desktop
identity and retains the Android phone profile. These flags select browser
identities, not native WebKit or Chromium engines. API callers can use
`createBrowser({ webkit: false })` to select the Chromium identity.

The first argument picks a frontend;
the rest is passed on:

- `--casty`, or anything else: casty
  in the terminal (the default; every
  argument goes to casty)
- `--headless`: the engine alone, as
  a CDP endpoint
- `--win32`, `--gtk`, `--appkit`,
  `--qt`: native windowed frontends
  (reserved, not implemented yet)
- `--help`/`-h`, `--version`/`-V`,
  `--readme`: this launcher's help,
  version and backend details, and
  this README

casty's and the engine's options:
`--casty --help`, `--headless --help`.

### Websites with self-signed certificates

To browse a website with an untrusted self-signed HTTPS certificate, set
`NODE_TLS_REJECT_UNAUTHORIZED=0` for that invocation:

```sh
env NODE_TLS_REJECT_UNAUTHORIZED=0 npx buninu-browser https://localhost:8443

# From a local checkout
env NODE_TLS_REJECT_UNAUTHORIZED=0 bun index.js https://localhost:8443
```

This disables TLS certificate verification for the process and inherited
child processes, including requests to other sites. Use it only for trusted
test sites; avoid exporting it globally. Without this variable, certificate
verification remains enabled.

### Requirements

- [Bun](https://bun.sh) 1.4.2 or
  later on `PATH`, also with npx:
  the engine and casty run on Bun.
- For casty, a terminal with the
  [Kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/)
  (kitty, Ghostty, WezTerm, Konsole):
  casty draws pages as images.
  `--headless` needs no terminal.

### Updating

npx checks the registry on each start
and installs a newer buninu-browser
or casty by itself; only the first
install asks. casty prints its
version on the last line when it
exits.

To reinstall from scratch, remove
the cached copies:

```sh
# npm 11 or later.
# List what npx installed: a key,
# then the package it holds
npm cache npx ls
#   03ebb78f79e8ceae: buninu-browser
#   0a9f496dd562f3e1: @drxiaozhi/casty

# Remove both. A key is a hash of
# the package name, so these are
# the same on every machine
npm cache npx rm 03ebb78f79e8ceae \
  0a9f496dd562f3e1

# Or remove everything npx cached,
# other tools' packages too
npm cache npx rm --force

# When casty runs through bunx or
# bun x
bun pm cache rm
```

With an older npm, delete the npx
cache directory: `~/.npm/_npx`
(Windows:
`%LocalAppData%\npm-cache\_npx`).

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
screen test so far have been done in casty itself. casty launches the
browser named by `CASTY_BROWSER` before looking for Chromium. The package
launcher sets this automatically and obtains casty through the package runner:

```sh
npx buninu-browser buninu.org
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

The package entry [`index.js`](index.js) is the `npx buninu-browser`
launcher and re-exports the engine's API. The engine itself is
[`buninu-browser.js`](buninu-browser.js), which `--headless` runs. Both keep
their command lines behind `import.meta.main`, so importing the package does
not start a browser process or CDP listener.

### Page sandbox

Pages can copy text with `navigator.clipboard.writeText()` after a user click
or key press on HTTPS (or localhost). The controller writes the clipboard,
preferring `xclip -selection clipboard`, with platform clipboard commands as
fallbacks. Clipboard command access stays outside the page sandbox; unavailable
providers reject the promise instead of reporting a successful copy.

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
without waiting. Standard screenshots are encoded with `Bun.Image`.

Casty can negotiate raw RGBA/BGRA file screenshots with native bunterm. Raw
pixels travel over the compositor's binary channel to the controller, which
owns a private temporary directory and returns a versioned file descriptor
through CDP. The renderer cannot create files: its seccomp policy is unchanged.
Each delivery has a unique file, bounded to 16 outstanding files / 128 MiB;
abandoned files expire on subsequent writes after 60 seconds, and closing the
host removes the directory. Standard PNG/JPEG/WebP output and CLI screenshots
retain their existing behavior. Casty falls back to its configured codec when
raw transport is unsupported.

Standard CDP `clip` rectangles also apply to raw captures. Fractional CSS
width/height are retained until physical-pixel rounding, so a 1.75× viewport
can deliver exactly 1918×1053 pixels. At `clip.scale: 1`, a full-width crop
borrows a contiguous raster view instead of rescaling; encoded output uses
the same crop. `Page.getLayoutMetrics` provides the viewport position so
Casty can follow document scrolling.

Casty also sends a private `clip` on `Page.startScreencast`. It takes precedence over fallback max limits and crops at native pixel density, without resizing. Width/height are CSS units; output pixels still follow device scale. This extension is not standard CDP.

Casty 也會在 `Page.startScreencast` 傳入私有 `clip`；優先於相容用的 max 限制，以原像素密度裁切、不縮放。寬高是 CSS 單位，實體像素仍隨 device scale 換算。此擴充不是標準 CDP。

標準 CDP `clip` 也適用於 raw 截圖；小數 CSS 尺寸保留到最後才換算成實體像素，
避免字體大小改變後差一列而觸發 bunterm 縮放。`clip.scale: 1` 的全寬裁切
直接借用連續像素，不重新縮放；Casty 透過 viewport 位置跟隨頁面捲動。

Read-only captures interrupted by an origin renderer swap retry once against
its replacement, after the new renderer has loaded its document. Scroll
commands are never replayed, avoiding duplicate input.

跨來源導航更換 renderer 時，唯讀截圖會等待新的 renderer 載入文件後重試一次；
捲動命令不會重送，避免重複套用輸入。

DOM-triggered rendering coalesces updates with a 16 ms minimum wait, increased
to twice the last style/layout rebuild time for expensive documents. This is
separate from Casty's screenshot interval and is not a 60 FPS guarantee:
raster work and frame delivery still take time. More frequent updates can
increase CPU usage on continuously animated pages.

DOM 變更觸發的繪製會以至少 16 ms 等待合併更新；排版昂貴時則延長為上次
樣式／排版重建耗時的兩倍。這與 Casty 的截圖間隔不同，也不保證 60 FPS；
光柵繪製與畫面傳遞仍需時間，持續動畫的 CPU 用量可能增加。

The compositor now connects to an authenticated, length-prefixed loopback
socket before the sandbox is installed, instead of reading numeric fd 3.
It connects directly to the controller, so a busy page main thread cannot
block screenshot or scroll requests. This removes the previous Windows-only
compositor disablement; the same tests can run on Windows, but this change
has so far been executed on Linux only. No additional native library is used.

原生 bunterm 可與 Casty 協商 RGBA／BGRA 原始像素檔案。renderer 經二進位通道
交給 controller 寫檔，不放寬 seccomp；標準截圖與不支援 raw 的終端維持原路徑。
compositor 改用沙箱啟用前建立、帶驗證的本機連線，不再依賴 fd 3，因此移除了
Windows 專用的停用條件；目前已實測 Linux，Windows 仍待真機驗證。

`bun tools/bench-raw-capture.js` measures changing-viewport capture delivery
(including controller file writes for raw), not terminal FPS.

`<video>` can decode and display MP4 video frames with basic playback and
seeking. Video bytes are fetched through the controller; the renderer uses
vendored wasmpeg JavaScript and WebAssembly without native media bindings.
Audio plays through a PulseAudio server on 127.0.0.1:4713, such as jspulse.
No npm install is needed for the decoder.

Clicked `a download` links (including `data:` and `blob:` URLs up to 64 MB) and responses with `Content-Disposition: attachment`
save to the user's Downloads folder by default (including a relocated Windows
Downloads folder); the directory is created when needed. A CDP
client can set the directory with `Browser.setDownloadBehavior` and receive
`Browser.downloadWillBegin` and `Browser.downloadProgress` events. Standalone
text and structured-document previews have a Download button at the top right
that saves the original response bytes. As in Chromium, `allowAndName` saves
the file under its download GUID; `allow` keeps the suggested filename.

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
and `navigator.userAgent` use an Android 16 Chrome user agent, and the
`hover`/`pointer` media features report a touch screen (`hover: none`,
`pointer: coarse`). User agent overrides sent over CDP are ignored so the
flag stays in effect under clients that set a desktop user agent, such as
casty. A viewport wider than 412 CSS pixels, a phone's width, is laid out
412 pixels wide and scaled up to fill it, so frames keep the size the client
asked for; input coordinates are scaled back, and pages see the factor as
`visualViewport.scale`.

```sh
npx buninu-browser github.com -- --mobile
```

### Video and audio

The default desktop WebKit/Safari compatibility identity (also selectable with
`--webkit`) matches Bun's JavaScriptCore more closely than the optional
`--chromium` identity. It presents macOS Safari even on other operating systems, sets the
matching navigator vendor/platform, and omits Chromium User-Agent Client Hints.
This can help pages that compare their declared browser with JavaScript engine
behavior. The flag applies to every site and keeps the page sandbox enabled.

```sh
npx buninu-browser https://youtu.be/jf-pn0a-Twk -- --webkit
```

The casty package version must support non-Chromium CDP backends without
replacing their advertised identity or applying Chrome-specific page patches.
The default and explicit
`--webkit` profiles ignore CDP user-agent overrides. The same flag works with
`--headless` and screenshot mode. This is a compatibility workaround, not a
guarantee that a service will accept every session.

`<video>` and `<audio>` share one pipeline; an `<audio controls>` is a
300x32 control bar with no picture. Clicking plays or pauses, clicking the
progress track seeks, and page script has `play()`, `pause()`,
`currentTime` (settable), `duration`, `paused`, `ended` and the matching
events. wasmpeg decodes what its LGPL build supports (H.264, HEVC, VP8/VP9,
MPEG-4, Theora, MPEG-1/2; MP3, AAC, FLAC, Vorbis, Opus, WAV).

Sound, a video's included, plays through a PulseAudio native-protocol server
on `127.0.0.1:4713`, such as [jspulse](https://github.com/jjtseng93/jspulse)
or PulseAudio itself; without one, video plays silently. Start jspulse with
the backend appropriate for your platform:

```sh
npx @drxiaozhi/jspulse --sles   # Android OpenSL ES
npx @drxiaozhi/jspulse --alsa   # Linux ALSA
npx @drxiaozhi/jspulse --win32  # Windows waveform audio
```

Keep the server on its default port, `4713`, when using Buninu Browser.
Although jspulse supports `-p` / `--port`, the browser currently connects to
`127.0.0.1:4713` and does not read `PULSE_SERVER`.

The controller
holds the connection, since renderers cannot open sockets. For media playback
it polls the server's playback cursor and measured sink latency; video follows
the reported audio progress, not the amount of PCM submitted or elapsed wall
time. Missing timing feedback holds the clock and is logged, rather than being
replaced by a fixed A/V delay. Audio queued ahead is bounded, including across
network stalls and decoder reopens.

Synchronization requires the standard PulseAudio timing query and an output
backend that reports its measured queue latency. jspulse provides a common
timing interface across ALSA, Windows, and OpenSL ES: ALSA uses hardware delay
and software queue measurements; Windows and OpenSL ES track buffer completion.
The shared Windows/ALSA mixer accounts for each stream separately.
Use a jspulse version that includes this timing support; older OpenSL ES
backends lack it. A server reporting zero latency while retaining an
unreported device queue cannot provide accurate synchronization.
Buffer-completion timing has buffer-sized resolution and does not measure
additional unreported downstream latency, such as Bluetooth output latency.
With `BUNINU_LOG`, `media sync` records reported audio progress, the latest
rendered video position, and the output queue/latency for diagnosis.

### Diagnostics

[`test/fixtures/browser-raw-demo.html`](test/fixtures/browser-raw-demo.html)
is a self-contained animated page for checking rendering, scrolling, and links
through Casty and bunterm. Serve it over a local HTTP server to reuse the visual
demo; it does not require external assets.

casty does not show the browser's stderr. Set `BUNINU_LOG=1` to also write
it to `buninu-browser.log` in the working directory, or set
`BUNINU_LOG=<path>` to choose the file. The log includes:

- page errors and page `console` output;
- per-phase load timings;
- renderer crashes and watchdog kills.

Renderers cannot open files under seccomp, so the controller collects their
output and writes the log.

```sh
BUNINU_LOG=1 npx buninu-browser github.com
```

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
| **SES (Hardened JavaScript)** | First sandbox layer for page scripts: `lockdown()` and one compartment per document | Vendored at an exact npm release in [`vendor/ses/`](vendor/ses/), with local changes recorded in [`patches/ses/`](patches/ses/); page globals are project-owned bindings, never Happy DOM objects |
| **Acorn** | JavaScript parser used to give classic scripts browser-style shared globals under SES | Vendored unmodified at an exact npm release in [`vendor/acorn/`](vendor/acorn/) |
| **wasmpeg / FFmpeg** | CPU WebAssembly video decoding | Vendored `@wasmpeg/cpu` 1.0.1 under [`vendor/wasmpeg/`](vendor/wasmpeg/), licensed LGPL-2.1-or-later; the WASM remains a separate, replaceable file. See its [`VENDORING.md`](vendor/wasmpeg/VENDORING.md) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) |
| **Web Platform Tests** | Conformance testing | Use a pinned external checkout or sparse test snapshot; do not place the complete WPT repository in the runtime vendor tree |

These projects retain their respective licenses and attribution. Material that
is actually distributed in this repository is recorded in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), with license texts under
[`LICENSES/`](LICENSES/). Buninu Browser maintains its own render tree, browser
lifecycle, security model, layout integration, display list, and automation API.
