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

## Contents

- [Usage](#usage)
  - [Frontends](#frontends-and-command-routing)
  - [Clipboard and text editing](#clipboard-and-text-editing)
  - [Downloads](#downloads)
  - [Sound](#sound)
  - [Screenshots and viewport size](#screenshots-and-viewport-size)
- [Why replace Chromium Headless Shell](#why-replace-chromium-headless-shell)
- [Design](#design)
- [Experimental Wayland frontend](#experimental-wayland-frontend)
- [Open-source components](#open-source-components)

## Usage

The default frontend, [Casty](https://github.com/jjtseng93/casty), displays web
pages in your terminal through the Kitty graphics protocol. It requires a
terminal that supports Kitty graphics.

### Requirements

- [Bun](https://bun.sh) 1.4.2 or
  later on `PATH`, also with npx:
  the engine and casty run on Bun.
- For casty, a terminal with the
  [Kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/)
  (kitty, Ghostty, WezTerm, Konsole):
  casty draws pages as images.
  `--headless` needs no terminal.

### Basic browsing

```sh
# Install Bun if you don't have it
npm i -g bun

# Open casty's home page
npx buninu-browser

# Open a URL
npx buninu-browser buninu.org
```

After opening a page, press **Alt+L** to edit the address, **Ctrl+E** to open
Casty's command line, or **Ctrl+Q** to quit. In the address bar, **Ctrl+C**
copies selected text and **Ctrl+V** pastes. See [Casty's controls](https://github.com/jjtseng93/casty#readme)
for the complete keyboard and mouse controls. Native Win32 uses the same Casty
controls; Wayland has its own [address bar](frontends/wayland/README.md).

The first terminal/Win32 run downloads this package
(about 50 MB: fonts, CanvasKit and
the video decoder), then the terminal
frontend
[`@drxiaozhi/casty`](https://www.npmjs.com/package/@drxiaozhi/casty)
([source on GitHub](https://github.com/jjtseng93/casty)).
npx may ask for confirmation before installing a missing package.

The launcher sets `CASTY_BROWSER` to
this package's `buninu-browser.js`
and starts casty with `npx` when npx
and Bun are both installed, otherwise
with `bunx`, or `bun x`.
No adjacent casty checkout is needed. From a local Buninu Browser checkout,
`bun index.js [URL] [-- BROWSER_FLAGS...]` uses the same package-based launcher.

### Frontends and command routing

The frontend selector must be the first argument. Use `npx buninu-browser`,
`bunx buninu-browser`, or `bun index.js` from a local checkout with the same
arguments.

| First argument | Behavior |
| --- | --- |
| No selector, or `--casty` | Terminal frontend; remaining arguments go to Casty. Requires Kitty graphics. |
| `--headless` | Engine only, exposing the Chrome DevTools Protocol (CDP) for Casty or automation clients, without a local window. |
| `--win32` | Casty's native Windows window; remaining arguments go to Casty. Windows only. |
| `--wayland` | Experimental Wayland window for a URL or local file; accepts `--window-size=WIDTH,HEIGHT`. See [Wayland details](#experimental-wayland-frontend). |
| `--quickshell-wayland` | Experimental QML application in a Wayland window. |
| `--quickshell-headless` | Experimental QML application exposed through CDP. |
| `--quickshell-casty` | Experimental QML application displayed through Casty. |
| `--gtk`, `--appkit`, `--qt` | Reserved; not implemented. |

```sh
# Native Windows window
npx buninu-browser --win32 https://example.com

# Existing Wayland compositor (for example, buninu-land)
npx buninu-browser --wayland https://example.com --window-size=1280,800

# A local document through the terminal frontend
npx buninu-browser file:///absolute/path/to/document.html

# Run a QML file or a directory containing shell.qml
npx buninu-browser --quickshell-wayland -p /absolute/path/to/shell.qml

# Headless QML, with engine options after --
npx buninu-browser --quickshell-headless -p /absolute/path/to/config \
  -- --remote-debugging-port=9222 --window-size=1280,800

# Named QML configuration through Casty
# First -- separates QML options; second -- introduces engine options
npx buninu-browser --quickshell-casty -c my-config -- -- --chromium
```

The QML entries accept `-p`/`--path FILE_OR_DIRECTORY` and
`-c`/`--config NAME` (under `$XDG_CONFIG_HOME/quickshell`). Without either,
they use the default Quickshell configuration lookup. They also honor
`QS_CONFIG_PATH`, `QS_CONFIG_NAME` and `QML_IMPORT_PATH`. Arguments after `--`
go to the selected backend. This is the experimental Buninu QML runtime,
not native Qt/Quickshell; see [supported features and recipes](lib/qml/README.md).
Local QML runs as a trusted application with Bun/host capabilities, rather than
inside the ordinary web-page sandbox. Only run QML files you trust; see
[QML isolation](lib/qml/README.md#local-host-services-and-isolation).

### Engine options

Pass these directly after `--headless`. With the Casty or Win32 frontend,
put engine options after `--`; options before it belong to Casty.
The standalone Wayland entry currently accepts a URL/file and `--window-size`,
not the full engine option set.

| Option | Behavior |
| --- | --- |
| `--remote-debugging-port=PORT` | CDP port; default `9222`, or `0` to choose a free port. |
| `--webkit` | Default desktop WebKit/Safari compatibility identity. |
| `--chromium` | Desktop Chromium compatibility identity. |
| `--mobile` | Phone identity, layout and touch media features; takes priority over desktop identity flags. |
| `--no-sandbox` | Accepted for Chromium CLI compatibility; ignored. |
| `--dangerously-allow-host-js` | Disables the page sandbox for every page; exposes host JavaScript capabilities. Only use with trusted content. |

For engine diagnostics, `BUNINU_LOG=1` writes `./buninu-browser.log`;
`BUNINU_LOG=/path/to/file.log` chooses a file. See [diagnostics](#diagnostics)
and [render scheduling](#render-scheduling) for further controls.

The engine defaults to a WebKit/Safari compatibility identity in casty,
headless, and screenshot modes. `--webkit` explicitly selects this default;
`--chromium` selects the previous desktop Chromium identity. Pass these flags
after `--` through casty, or directly after `--headless`. If both desktop flags
are supplied, the last one wins. `--mobile` takes priority over either desktop
identity and retains the Android phone profile. These flags select browser
identities, not native WebKit or Chromium engines. API callers can use
`createBrowser({ webkit: false })` to select the Chromium identity.

```sh
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
```

For sound in the YouTube example, first start an [audio server](#sound).

### Help and documentation

```sh
npx buninu-browser --help
npx buninu-browser --casty --help
npx buninu-browser --headless --help
npx buninu-browser --wayland --help
npx buninu-browser --quickshell-wayland --help
npx buninu-browser --quickshell-headless --help
npx buninu-browser --quickshell-casty --help
npx buninu-browser --version
npx buninu-browser --readme
```

Launcher aliases: `-h`/`-help` for `--help`, `-V`/`-version` for
`--version`, and `--docs` for `--readme`. Casty's own options and commands
are documented in [Casty's README](https://github.com/jjtseng93/casty#readme).

### Dialogs and file selection

`alert()`, `confirm()` and `prompt()` show a browser-owned modal dialog in the
page image, including through Casty and the Wayland frontend. For example,
enter `javascript:alert(1+2)` in the address bar. Alert has an OK button;
confirm and prompt also have Cancel. Enter accepts, Escape dismisses, and
prompt initially selects its default text. Long messages scroll and their
text can be selected and copied. Page scripts wait synchronously for the
answer; confirm returns a boolean and a cancelled prompt returns `null`.
The dialog lives in a separate renderer, outside the page's DOM and realm.

CDP exposes `Page.javascriptDialogOpening`, `Page.javascriptDialogClosed`
and `Page.handleJavaScriptDialog` for automation. Ordinary pointer and
keyboard input can also operate the displayed dialog.

File inputs also use a browser-owned chooser: click folders or enter a folder
path, select files, then Open (or Cancel/Escape). Multiple selection and
asynchronous `FileReader` are supported. Only selected file contents and names
reach the page, not their host paths. The current chooser accepts at most
32 MiB per selection; it does not yet filter the listing by `accept`.

### Clipboard and text editing

Pages can copy or read text with `navigator.clipboard.writeText()` and
`navigator.clipboard.readText()` after a user click or key press on HTTPS
(or localhost). Each operation consumes that activation. The controller accesses the clipboard,
preferring `xclip -selection clipboard`, with platform clipboard commands as
fallbacks. Clipboard command access stays outside the page sandbox; failed
writes reject the promise instead of reporting host success. Reads always try the
host first, then retain the last local text on denied or empty reads, as in Land
(Android may return empty text while backgrounded). Without cached text, read
errors still reject. Explicitly writing empty text clears the cache; an external
clear cannot be distinguished from a denied empty read. Reads happen only on
request, with no clipboard polling. HTML inputs and textareas share selection,
caret blinking, Shift+arrows, and Ctrl+C/X/V editing with QML controls. Paste
replaces the selection, or inserts at the cursor. Up/Down currently follow
explicit textarea line breaks, not soft-wrapped visual lines.

PowerShell clipboard quoting and newline handling are reused from jsmdcui
under its [MIT license](LICENSES/jsmdcui.txt).

### Downloads

Clicked `a download` links (including `data:` and `blob:` URLs up to 64 MB) and responses with `Content-Disposition: attachment`
save to the user's Downloads folder by default (including a relocated Windows
Downloads folder); the directory is created when needed. A CDP
client can set the directory with `Browser.setDownloadBehavior` and receive
`Browser.downloadWillBegin` and `Browser.downloadProgress` events. Standalone
text and structured-document previews have a Download button at the top right
that saves the original response bytes. As in Chromium, `allowAndName` saves
the file under its download GUID; `allow` keeps the suggested filename.

### Sound

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

### Updating

When npx resolves an unversioned package through its download cache, it checks
for a newer version. A matching local or global installation can be reused,
so this is not a guarantee that every invocation updates both packages.
Casty prints its version on the last line when it exits.

To reinstall from scratch, remove
the cached copies:

```sh
# npm 11 or later.
# List what npx installed: a key,
# then the package it holds
npm cache npx ls
#   03ebb78f79e8ceae: buninu-browser
#   0a9f496dd562f3e1: @drxiaozhi/casty

# Remove the keys printed by your own listing. These hashes are examples:
# the complete package specification (including a version) affects the key.
npm cache npx rm BROWSER_KEY CASTY_KEY

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

### Screenshots and viewport size

```sh
# The engine alone, as a CDP
# endpoint for any client
npx buninu-browser --headless \
  --remote-debugging-port=9222 --window-size=1280,800 https://example.com

# Attach from a Kitty graphics terminal; keep the remote viewport unchanged
bunx @drxiaozhi/casty --attach 9222

# capture a page and exit
npx buninu-browser --headless --screenshot=page.png \
  --window-size=1280,800 https://example.com
```

| Option | Behavior |
| --- | --- |
| `--window-size=WIDTH,HEIGHT` | Initial viewport in CSS pixels; default `800,600`. |
| `--screenshot[=FILE]` | Capture a page and exit; default `screenshot.png`. Extension selects PNG, JPEG or WebP. |
| `--screenshot-wait=MILLISECONDS` | Additional real-time wait after page load before capture. |

A supplied URL or local file loads automatically into one discoverable page
target. Casty `--attach` uses that existing target; it does not reload the page
or take ownership of the browser process. Without a URL, headless mode waits
for a CDP client to create and navigate a target. QML headless uses the same
mechanism for its selected `shell.qml`.

`--window-size=WIDTH,HEIGHT` sets the initial viewport for both headless CDP
and screenshot modes (default 800×600 CSS pixels, DPR 1). CDP clients can
subsequently change it with `Emulation.setDeviceMetricsOverride`.

Screenshot mode waits for the page's `load` event before capture. For content
that appears later, add `--screenshot-wait=1000` (real milliseconds). The output
format follows the filename extension: PNG, JPEG, or WebP. Chromium's
`--virtual-time-budget` is not implemented; a real-time delay does not advance
page timers the same way.

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
screenshots and screencast, viewport, and input. Early development used Casty; current tests also exercise headless and
Wayland rendering. casty launches the
browser named by `CASTY_BROWSER` before looking for Chromium. The package
launcher sets this automatically and obtains casty through the package runner:

```sh
npx buninu-browser buninu.org
```

## Design

The existing Win32 and Wayland frontends, and future GTK, Android or other
windowed frontends, follow the same thin platform-adapter design. They provide a native window and drawing surface, forward
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

Ordinary web pages use the following isolation mechanisms:

1. **SES and bindings.** The renderer calls `lockdown()`, and each document
   gets its own compartment. That compartment sees only project-owned DOM
   and Web API bindings, never Bun, `process`, or Happy DOM objects.
2. **Process isolation.** The controller spawns one renderer per origin with
   a restricted environment and talks to it over IPC. Startup and navigation
   have no deadline; a method watchdog is only enabled when an API caller
   explicitly configures `rendererTimeout`. Cookies, CORS, redirects, and
   history stay in the controller. A cross-origin navigation moves to a fresh, pre-warmed
   process. Isolation is per origin rather than per site because no Public
   Suffix List is bundled.
3. **seccomp (Linux/Android).** On supported systems, the renderer installs
   a syscall allowlist modelled on Chromium's baseline policy. This layer is
   not installed on Windows or macOS; startup logs report whether installation
   succeeded.

`--no-sandbox` is accepted for Chromium compatibility but ignored.
`--dangerously-allow-host-js` turns the sandbox off for every page.
Local QML uses a dedicated host-capable renderer with SES and seccomp disabled;
it is trusted application code, not sandboxed website content. Clipboard host
commands remain controller-owned for ordinary pages; see [clipboard access](#clipboard-and-text-editing).

### Raster image compatibility

Bun.Image metadata is a header probe, not a required format whitelist. If it
cannot recognize a valid image, the shared image loader still tries the bundled
CanvasKit decoder. Decoded dimensions come from that decoder; allocation limits
remain enforced. This applies to HTML images, CSS backgrounds, canvas images and
QML Image, with a matching fallback in the DOM image-size adapter.

Native regression fixtures cover ICO (PNG and DIB payloads), CUR, WBMP and BMP
variants rejected by Bun's probe: 1/4/8-bit palettes, 16-bit RGB, RLE4/RLE8 and
OS/2 core headers. PNG, JPEG, WebP, GIF and ordinary 24-bit BMP remain covered.
This fallback does not add codecs absent from the bundled Skia build.
Unsupported/corrupt images follow the normal error/alt and rejected `decode()`
path and can recover when `src` is replaced. Run `bun test test/raster-codecs.test.js`
for the generated format fixtures and page-level loading tests.

Animated GIFs play in ordinary images, CSS backgrounds, and standalone image
documents using the bundled CPU CanvasKit decoder. Frame delays, transparency,
disposal, and finite/infinite loops are supported; no video backend is required.
Animation updates repaint without relayout and release their decoders on source
replacement or document disposal. Animated WebP/APNG are not enabled by this path.

### SVG rendering

Inline SVG and SVG image resources share a CPU painter using the bundled
CanvasKit. The normal image loader accepts SVG for `<img>`, `Image.decode()`,
CSS backgrounds, canvas `drawImage()` and QML Image. Image resources retain a
raster snapshot for canvas/background consumers; ordinary image elements draw
vector geometry at their displayed size rather than stretching that snapshot.

Supported static features include basic paths/shapes, transforms, nested SVG
viewports, `preserveAspectRatio`, local `<use>` references, linear/radial
gradients, clip paths, group opacity and stroke caps/joins/dashes. This is not
complete SVG support: SVG text, patterns, masks, filters, animation and external
SVG resources are not implemented. Referenced `<use>` instances currently inherit
presentation attributes but do not fully implement shadow-tree CSS styling;
object-bounding-box clips on groups and mixed clip rules are approximate.
SVG images are parsed inertly: scripts and foreign objects are not executed,
and source size, element count, traversal depth and raster allocation are bounded.

[Bun's Press Kit](https://bun.com/press-kit) exercises actual SVG image sources
(`/logo.svg` and `/icon.svg`), not raster thumbnails. Additional regression tests
cover gradients, references/cycles, clipping, opacity, image ownership and the
HTML/QML loading paths:

```sh
bun test test/svg.test.js test/svg-image.test.js test/svg-integration.test.js
```

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

Casty also sends a private `clip` on `Page.startScreencast`. It takes precedence over fallback max limits and crops at native pixel density, without resizing. Width/height are CSS units; output pixels still follow device scale. This extension is not standard CDP. A clip with both width and height equal to zero requests update notifications only: the server sends a fixed 1×1 PNG placeholder without rendering or encoding a preview. Ordinary captureScreenshot still rejects zero-sized clips.

Read-only captures interrupted by an origin renderer swap retry once against
its replacement, after the new renderer has loaded its document. Scroll
commands are never replayed, avoiding duplicate input.

DOM-triggered rendering coalesces updates with a 16 ms minimum wait, increased
to twice the last style/layout rebuild time for expensive documents. This is
separate from Casty's screenshot interval and is not a 60 FPS guarantee:
raster work and frame delivery still take time. More frequent updates can
increase CPU usage on continuously animated pages.

The compositor now connects to an authenticated, length-prefixed loopback
socket before the sandbox is installed, instead of reading numeric fd 3.
It connects directly to the controller, so a busy page main thread cannot
block screenshot or scroll requests. The same transport is used on Windows instead of disabling the compositor
there. No additional native library is used.

`bun tools/bench-raw-capture.js` measures changing-viewport capture delivery
(including controller file writes for raw), not terminal FPS.

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

### Experimental CPU WebGL

`canvas.getContext('webgl')` has a software-only triangle rendering subset for
basic Three.js scenes. It uses the bundled CanvasKit shader compiler, with a
bounded numeric JavaScript shader path for supported expressions. Unsupported
numeric syntax keeps the CanvasKit path. It does not require a GPU or a new
native dependency. Depth testing, perspective varyings and basic 2D image/canvas
textures are supported; this is not a conformant or complete WebGL implementation
(framebuffers, cube maps, mipmaps and general blending remain incomplete).

The renderer defers unobserved draws, caches exact geometry/shading results while
reapplying current depth, and skips polygon clipping for meshes wholly inside
the view. CSS rotation, canvas-local pointer coordinates, HTML drag events and
detached image loading use the ordinary browser paths rather than Three.js
special cases.

The interactive reference is the [Three.js stereo scene](https://drjohnjstest.blogspot.com/2023/11/3dsbsthreejsdemo.html).
Run `bun test/manual-threejs-scene.js` for its buttons, prompt, orientation and
drag checks. Pass a folder containing `floor.jpg` and `wall.jpg` to also exercise
the file chooser and room textures; optional `小凱L.png` / `小凱R.png` exercise
stereo-image import. A second argument sets the output directory. This network
check is separate from `bun test`; Copy was also checked through the existing
browser clipboard callback without replacing the user's clipboard.

For completed-frame timings, run
`bun test/manual-webgl-benchmark.js buninu /path/to/assets`; replace `buninu`
with `chromium` for a reference (select a software Vulkan ICD when comparing CPU
rendering). It records both canvas sizes, frame times and a screenshot. These
timings exclude CDP screenshot encoding and terminal presentation.

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

`<video>` can decode and display MP4 video frames with basic playback and
seeking. Video bytes are fetched through the controller; the renderer uses
vendored wasmpeg JavaScript and WebAssembly without native media bindings.
Audio plays through a PulseAudio server on 127.0.0.1:4713, such as jspulse.
No npm install is needed for the decoder.

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

Sound uses the [audio server configured in Usage](#sound).

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

### Web Audio synthesis and sample playback

The initial [Web Audio](https://www.w3.org/TR/webaudio-1.1/) subset provides
`AudioContext` (`webkitAudioContext` is an alias), `OscillatorNode`, `GainNode`
and `AudioParam` scheduling. Sine, square, sawtooth and triangle oscillators
are synthesized in JavaScript in 128-sample blocks. Connected voices share
one stereo PCM stream per context through the existing audio output above;
no GPU or additional native library is needed. Suspend, close and navigation
release the context's output. `AudioBuffer`, `createBuffer()`,
`decodeAudioData()` and `AudioBufferSourceNode` support decoded sample playback,
offsets, duration, looping, rate/detune and ended events. Compressed audio uses
the existing WASM decoder and is resampled to the context rate; the current
software graph downmixes buffer channels before stereo output.
`BiquadFilterNode` provides software filtering through `createBiquadFilter()`.
Offline contexts and AudioWorklets are not implemented yet.

[Clumsy Bird](https://ellisonleao.github.io/clumsy-bird/) is an interactive
reference for sample playback, Canvas image patterns, detached image dimensions
and page-local primitive prototype extensions. Start with a click or Space;
Space also makes the bird fly. The page remains under SES and the renderer's
seccomp policy; shared host prototypes are not unfrozen. Prototype extension
methods belong to the page and are discarded on navigation. The live check
`bun test/manual-clumsy-bird.js buninu /tmp/clumsy-bird` records menu and gameplay
screenshots and verifies pointer/Space input with the ordinary headless backend.

The interactive reference is the [text-to-numbered musical notation page](https://drjohnjstest.blogspot.com/2023/10/text-to-numbered-musical-notation.html).
Its Play button and two-part playback use changing oscillator frequencies.
To run the live reference test, including a screenshot:

```sh
bun test/manual-numbered-music.js buninu /tmp/numbered-music
# Optional comparison; requires /usr/local/bin/chromium-headless-shell.
bun test/manual-numbered-music.js chromium /tmp/numbered-music-chromium
```

### Render scheduling

Set `BUNINU_RENDER_MIN_INTERVAL` to adjust the minimum delay before coalesced
DOM/Canvas redraws. The default is 16 ms; try 8 ms for more frequent updates:

```sh
env BUNINU_RENDER_MIN_INTERVAL=8 bun index.js --wayland URL
env BUNINU_RENDER_MIN_INTERVAL=8 bun index.js URL
```

Accepts integer milliseconds from 0 to 60000. Invalid values warn and fall back
to 16 ms. Zero removes the minimum delay, but retains asynchronous coalescing
and the adaptive delay based on the previous layout cost. This is not an FPS
guarantee or Casty's capture interval; shorter waits can increase CPU usage.
Restart the browser after changing it. The setting also applies to iframe
renderers, and only its validated numeric value is forwarded to the renderer
process; the ordinary renderer does not inherit the host environment.

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
- renderer crashes and explicitly enabled watchdog kills.

Renderer and video-worker startup have no deadline. Document navigation also
waits until completion, failure, or explicit close. The browser does not enable
the renderer method watchdog by default: slow initialization or page work must
not kill the renderer. Internal callers can opt into a method watchdog through
`rendererTimeout`; this does not impose a startup or navigation deadline.

Renderers cannot open files under seccomp, so the controller collects their
output and writes the log.

```sh
BUNINU_LOG=1 npx buninu-browser github.com
```

## Experimental Wayland frontend

`bun index.js --wayland URL` opens a standard Wayland SHM window using
`WAYLAND_DISPLAY` and `XDG_RUNTIME_DIR`. Casty remains the default.
See [frontend details and limitations](frontends/wayland/README.md).
See the [experimental QML runtime and Flea/Omastorm container recipes](lib/qml/README.md)
for local QML applications. This does not yet provide full Quickshell/Flea/Omastorm
compatibility. For input checks, open `test/manual-pointer-scroll.html` through
either frontend.

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
