# Experimental QML DOM frontend

QML is compiled directly into this browser's existing DOM, CSS and page JavaScript.
It does not generate HTML or retain a second QML component tree. Temporary syntax
and import graphs are discarded after generating DOM factories and bindings.
Flat property state, DOM references, delegate factories and reactive dependencies
remain. No new npm dependency or native Qt library is required.

This is an experimental subset, not a QtQuick/Quickshell replacement. Unknown
imports, types and properties produce diagnostics. Recognized APIs also have
limits documented below; successful compilation is not complete compatibility.

## Try it

Run these commands from the buninu-browser repository:

```sh
bun index.js file://"$PWD"/test/fixtures/qml/multiply.qml
bun index.js --wayland file://"$PWD"/test/fixtures/qml/multiply.qml
bun test test/qml*.test.js
```

The same three-field calculator has been checked with the real Quickshell binary.
QML is recognized by `text/x-qml`, `application/x-qml`, or a `.qml` path with a
text/generic MIME type. Explicit HTML retains HTML behavior. With scripting off,
the source is displayed inertly. Downloads retain the original bytes.

The standard Wayland frontend uses `WAYLAND_DISPLAY` and `XDG_RUNTIME_DIR` and
presents ordinary `wl_shm` buffers. One browser frontend currently owns one native
window; multiple QML `FloatingWindow` objects do not create multiple OS windows.
The root fills the supplied viewport and follows its resize events.

## Opt-in `qs` wrapper and official Flea binary

`lib/qml/qs` is an executable Bun launcher, accepting `-p/--path` (file or
configuration directory) and `-c/--config`. Put its directory first in PATH
**for this application only**; it does not replace an installed Quickshell.
Unknown arguments, including native `qs ipc`, fail explicitly. This is still
our experimental DOM runtime, not the native Quickshell engine.

For an already extracted Omarchy package and the existing Omarchy QML reference:

```sh
FLEA_BIN=/path/to/package-root/usr/bin/flea \
BUNINU_FLEA_ROOT=/path/to/package-root/usr/share/flea \
BUNINU_OMARCHY_ROOT=../omarchy-qml-reference \
  bun test/manual-flea-binary.js
```

This creates a temporary HOME/XDG state and sample files, then runs the **actual
Flea binary** with `--gui`. A temporary PATH directory contains a `qs` symlink
to `lib/qml/qswayland`. Flea calls `qs -p .../boot/shell.qml` and
supplies `FLEA_BIN`/`FLEA_PATH`; the wrapper preserves that environment and opens
the ordinary Wayland frontend. Closing the window removes the temporary state.
The script sets the upstream Qt renderer hint to `opengl` only to avoid Flea's
native Vulkan probe; our renderer remains the browser's existing renderer.

To use your own settings, the equivalent direct invocation is:

```sh
env PATH="$PWD/lib/qml:$PATH" \
  FLEA_UI=/path/to/package-root/usr/share/flea/ui \
  QML_IMPORT_PATH=/path/to/imports \
  QSG_RHI_BACKEND=opengl \
  /path/to/package-root/usr/bin/flea --gui /path/to/directory
```

The import root must contain `qs/Commons` and `qs/Ui` pointing to the Omarchy
QML modules; the manual runner creates these links itself. Keep the backend and
Flea QML from the same package. `WAYLAND_DISPLAY`/`XDG_RUNTIME_DIR` select Land.
A real launch uses your settings and file access, like other local QML programs.

Omarchy stable **0.3.12-1 aarch64** was tested on Debian proot: the original
binary launches our wrapper, a real `--backend` child lists files, directory
watch notifications update rows, Ctrl-L/Enter navigates to a directory, and
Land's Super-W closes the wrapper. The settings controls also pass against
this binary. `DelegateModel.items.create()` now supplies persisted membership
before completion; views adopt those parked items without constructing duplicates.

Wrapper validation: 60 general QML tests passed (17 opt-in cases skipped),
the two real-backend/official-launcher tests passed with the above environment,
and the official-backend settings test passed separately. The removable-integration
check still passed all 9 ordinary-browser tests. No integration outside `lib/qml`
or `test` was added for this wrapper.

Use **List view** (Ctrl-1). Saved Columns view still encounters unsupported
`ShaderEffectSource` and can leave the content area empty. This test does not
claim complete Flea support, file operation safety coverage, or native QS IPC.

```sh
# Same environment as above, with BUNINU_QML_WAYLAND_TEST=1 for the socket test:
bun test test/qml-flea-backend.test.js test/qml-flea-launcher.test.js
```

## Termux udocker Debian experiment

Verified on 2026-10-23: the official **Flea 0.3.12-1 aarch64** package runs
through `qswayland` in a separate Debian 13 (trixie) container and displays on
an **already running Land outside the container**. The container was started
from a native Termux shell via `jsgotty --client`, not inside the development
Debian proot.

The retained container is named **`flea-qswayland`**, under
`~/.udocker/containers/flea-qswayland/ROOT` in Termux. Its ID is
`82ef2c52-a491-4723-9604-855f22bd92d5`. It was created using
`udocker run -b "$TMPDIR:/tmp" debian`, then named with `udocker rename`.

#### Files copied into the container

| Container location | Contents |
| --- | --- |
| `/usr/bin/flea`, `/usr/share/flea`, and other package paths | Extracted official Flea package, preserving symlinks |
| `/opt/buninu-browser` | Browser working tree, excluding `.git` and `node_modules` |
| `/usr/local/bin/bun` | Existing Linux aarch64 glibc Bun 1.4.4 executable |
| `/usr/share/omarchy/shell/Commons` and `/usr/share/omarchy/shell/Ui` | Existing Omarchy QML reference modules |

Copying only Flea and the browser is insufficient: Debian needs the Bun runtime,
and Flea's QML package links `Commons`/`Ui` to `/usr/share/omarchy/shell/`.
No additional apt/npm packages or native Qt/Quickshell runtime were installed.
The Linux Bun executable is used inside Debian, not the Android Bun executable.

For named QML imports, `/usr/share/omarchy/qs` links to `shell`.
The executable `/usr/local/bin/qs` is this wrapper:

```sh
#!/bin/sh
export QML_IMPORT_PATH="/usr/share/omarchy${QML_IMPORT_PATH:+:$QML_IMPORT_PATH}"
exec /usr/local/bin/bun /opt/buninu-browser/lib/qml/qswayland "$@"
```

To reopen the prepared container, run **from Termux**:

```sh
udocker run -b "$TMPDIR:/tmp" flea-qswayland
```

Then run **inside the container**:

```sh
env XDG_RUNTIME_DIR=/tmp \
  WAYLAND_DISPLAY=wayland-buninu \
  QSG_RHI_BACKEND=opengl \
  flea --gui /root
```

The bind exposes Termux's Wayland socket as `/tmp/wayland-buninu`; Land itself
stays on the host. `QSG_RHI_BACKEND=opengl` bypasses Flea's native Vulkan probe
and does not enable GPU rendering in our frontend. Flea finds `qs` on the
container's default PATH and starts its real `--backend` child.

Observed result: the host Land screenshot shows the container's `/root/Documents`
and `/root/hello.txt`. This verifies launch and basic file listing, not optional
Trash, mounts, previews, or all external-tool integrations. Notes are retained in
`/root/FLEA-TEST.txt`; the test log is `/tmp/flea-udocker.log` on the shared tmp.
The copied browser is a snapshot; later repository changes require copying again.

During image extraction, Android rejected the hardlink for
`/usr/bin/perl5.40.1`; this missing alias was repaired by copying `/usr/bin/perl`
to that path. No other extraction error was reported in this run.

## Flea: current verified scope

The unchanged `ui/boot/shell.qml` from Flea revision
`f21789e56cc4b0877caa3156fff7bce52a8dd9c2` runs with real Flea Theme and Omarchy
Commons/Ui imports from revision `3c7027db2a4fa9fa6a49d7af7f87c27ac48e677d`.
Tests use isolated HOME/XDG directories. They do not inject fake backend replies.

Verified against those sources:

- Main window startup, settings opened by the real toolbar, Display/Keys tabs,
  and Escape closing the panel.
- Ctrl-L path editing, replacement of selected text, and Escape cancellation.
- The real keyboard help sheet and Add network share dialog, including typing a
  host and switching SMB to SFTP. Connecting/mounting is **not** tested.
- Original Row/GridTile components render metadata and react to changed input;
  GridTile retains its two-line filename caption. These use test input data, not
  a backend replacement.
- Real text and CSV files through `PreviewText`; Markdown through the original
  `MarkdownWorker.js` and its `Qt.include` dependencies on a real worker thread.
- SVG/PNG preview, zoom and fit through the original `PreviewImage.qml`.
- SettingsRuler, DialogButton and DialogField behavior compared with an existing
  Quickshell binary, without reading its implementation source.
- Flea StableModel resize/warm behavior and virtualized delegates; a separate
  range-model test represents 100 million rows without creating that many DOM nodes.
- A separate real Wayland socket test opens Settings, closes it with Escape, and
  closes the native window with Land's Super-W. It owns a separate compositor.

The source inventory parses 239 QML files and compiles 227 of 235 top-level UI
components. The eight remaining compile blockers are ShaderEffectSource
(ColumnsArea, HtmlClip, PreviewSwap, QuickLookSwap), QtQuick.Pdf (PdfViewer,
PreviewPdf), AnimatedImage (PreviewAnimation), and QtMultimedia (PreviewMedia).
Dynamic loaders defer some of these until the associated feature is opened.

**Full Flea file management is not yet supported or validated.** The original
73-test run used no backend; the later official-binary tests above cover real
listing/navigation and directory updates. Without `FLEA_BIN`, the main app still
displays its own unavailable state. Copying/moving/deleting, mounts, clipboard
integration, PDF/media and preview texture transitions remain outside this result.
A compile inventory is not an end-to-end application test.

```sh
# Existing, unchanged sibling checkouts; no download or installation is performed.
bun test/manual-flea-application.js

# Optional: supply an already installed real backend.
FLEA_BIN=/absolute/path/to/flea bun test/manual-flea-application.js

# Headless application, preview, worker and compile inventory tests.
BUNINU_FLEA_ROOT=../flea BUNINU_OMARCHY_ROOT=../omarchy-qml-reference \
  bun test test/qml-flea-app.test.js test/qml-flea-previews.test.js \
  test/qml-flea-compile.test.js test/qml-flea-rows.test.js test/qml-worker.test.js

# Own isolated compositor; does not affect an existing Land session.
BUNINU_FLEA_ROOT=../flea BUNINU_OMARCHY_ROOT=../omarchy-qml-reference \
  BUNINU_QML_WAYLAND_TEST=1 bun test test/qml-flea-wayland.test.js

# Optional genuine Debian arm64 Quickshell binary already extracted elsewhere.
BUNINU_QS_ROOT=/path/to/sid/root bun test test/qml-quickshell-controls.test.js \
  test/qml-quickshell-settings.test.js
```

Validation on 2026-10-23 (Bun 1.4.4 canary, Debian proot): all 73 QML tests
passed with the Flea, Omarchy, real Quickshell and isolated Wayland options enabled
(211 assertions). The removal check separately passed 9 ordinary browser tests
(71 assertions) after deleting all 14 integration blocks and `lib/qml`.

The manual app runner uses the current Wayland socket and creates temporary
HOME/config/state/data/cache directories. It never writes personal Flea settings.
Close the window to remove those directories. See its `--help` for paths/options.

## Imports and language

- Relative directories, implicit sibling components, named module directories,
  and qualified imports. Local modules additionally search `QML_IMPORT_PATH`.
- `qmldir` component entries, singleton/internal entries and version selection:
  same major, highest available minor not above the requested version.
- Per-instance IDs, inheritance, properties, required/readonly properties,
  writable aliases, default/named content slots, methods and signal declarations.
- Typed QML functions, inline components, grouped properties, `Behavior on`,
  statement handlers and checked QML `as` casts. Types do not implement all Qt
  conversion/coercion rules.
- JS imports, nested `.import`, and `.pragma library`. Library dependencies share
  document scope; ordinary scripts belong to the component instance. Generated
  names avoid application variables. QML `String.arg()` is translated without
  changing JavaScript's frozen/shared prototypes.
- Singleton allocation precedes binding evaluation, including mutually referring
  Theme/Glass and Color/Style objects. Reload creates fresh singleton state.
- `Component`, `Loader`, local `Qt.createComponent`, `Qt.binding`, and `Binding`.
  Factories make ordinary DOM and dispose instance effects, listeners and timers.
  Imperative assignments detach bindings; aliases forward writes and can rebind.

Limits: 256 KiB per imported source, 4 MiB combined source, import depth 48,
1,024 local or 128 remote resource requests, 2,000 statically expanded objects.
Live runtime limits are 30,000 local or 2,000 remote objects. Local Flea settings
prebuilds require the higher local limit. Import cycles, native Qt plugins and
unsupported declarations are explicit diagnostics. Module version syntax is not
an assertion that every API from that Qt version exists.

No version-suffixed module directories, qmldir dependency/prefer directives,
`.mjs` imports, remote dynamic components or Qt native plugin loading.

## Rendering and interaction

Items map to DOM/CSS: Rectangle, Text/Label, TextInput/TextEdit/TextField, Button,
MouseArea, pointer handlers, Image, Row/Column/Grid/Flow, RowLayout/ColumnLayout,
Flickable, ListView/GridView and basic Shape paths.

- Anchors include sides, centers, margins and baselines. Positioners respect
  visible children and padding. Basic layouts support preferred/min/max/fill
  sizes and alignment; full Qt layout negotiation is not implemented.
- Text measurement uses the existing canvas text API and a bounded cache.
  PlainText is literal. Styled/Rich/Auto text builds inert restricted DOM;
  local Markdown uses Bun's Markdown renderer. Line counts and wrapped filename captions are supported. Mixed-format metrics
  and multiline ellipsis are approximate, and rich-text embedded images are unsupported.
- SVG-shaped icons reuse the browser's inline SVG painter. ShapePath linear
  gradients use an ordinary page canvas on the existing CanvasKit instance:
  no image encode/decode or raster readback is introduced for that path.
- Raster Image uses the normal browser decoder. Basic file/data/HTTP SVG images
  use inert inline SVG DOM instead of a PNG conversion. SVG text, gradients,
  filters, masks and external resources are not implemented by that path.
  `sourceSize`, EXIF autoTransform, tiled fill and precise Qt decode/cache policy
  are not complete; raster size remains governed by the existing browser decoder.
- Text selection/editing, accepted signals, focus, Keys.forwardTo and key
  acceptance work with actual DOM events. Editing keys do not trigger ancestor
  shortcuts; Escape can propagate. Hidden prebuilt controls cannot steal focus. FocusScope ancestors track active
  focus and can restore their last active child. Menu/AltGr keys and mouse
  back/forward buttons retain distinct codes.
- TapHandler supports click/release and basic double taps; HoverHandler observes
  pointer movement without intercepting underlying controls. Point/Drag handlers
  and DropArea are partial DOM-event adapters, not Qt gesture arbitration or
  complete native drag-and-drop.
- ListModel, DelegateModel/Group and virtualized views instantiate a bounded
  visible/cache range, with pooling/reuse and synchronous forceLayout. Variable
  row height, sections, full highlight behavior and model role semantics remain
  limited. At most 500 visible delegates are created per view layout.
- XmlListModel supports simple element paths and attribute/element roles such as
  XBEL bookmarks; it is not an XPath implementation.
- Timer, basic numeric/property/sequence/parallel animations, Behavior and
  FrameAnimation use the page event/animation loop. Window frame signals are
  page-loop signals, not a guarantee of native Wayland presentation timing.

ShaderEffectSource and arbitrary shader/texture composition are not replaced by
empty stubs. The underlying DOM-to-canvas snapshot path is now available, but
ShaderEffectSource lifecycle and ShapePath texture fills are not wired up yet.

### Local QML DOM images

In local `file:` QML's dedicated host renderer, `ctx.drawImage(element, ...)`
also accepts a connected DOM element with a laid-out block box. All three
ordinary drawImage argument forms reuse canvas positioning, source cropping,
scaling, transforms and alpha. This is an internal QML extension, not a web API:
ordinary HTML (including local HTML/host mode) and remote QML do not enable it.
The capability is tracked outside page-writable globals.

The existing painter draws only the selected render subtree into a temporary
CanvasKit surface; siblings and ancestor opacity/clips are excluded. The source's
own styles, internal stacking, text and nested canvases use normal browser
painting. The snapshot uses the source border-box dimensions at one pixel per
CSS pixel and stays frozen until another draw. It does not modify the source DOM.
Images stay native to the same WASM CanvasKit instance: no PNG/base64 or pixel
readback is needed, and the temporary image/surface are released after use.

This initial path does not capture detached, display:none or inline-only sources,
iframes, or a subtree containing the destination canvas. Source visibility is
still governed by CSS; ShaderEffectSource hideSource semantics remain future
work. Captures are limited to 8192 pixels per side and 16,777,216 total pixels.
Cross-origin image/tainted-canvas resources propagate canvas readback restrictions;
unknown image origins are treated conservatively.

Run `bun test test/qml-canvas-dom.test.js` for pixel, isolation and resource-lifetime
checks. The removal check also strips the canvas adapter.

## Local host services and isolation

Local `file:` QML automatically uses a dedicated host renderer with application
HOME, PATH and XDG environment. This is executable local application code with Bun
access, not sandboxed web content. Reload starts a fresh renderer. Navigating back
to ordinary HTML swaps to the normal renderer, even in the same directory.
HTTP(S) QML stays isolated and cannot import local files or access these services.
Explicit `--dangerously-allow-host-js` retains its existing all-pages meaning.

`host.js` supplies real Process execution/stdin/streaming stdout/stderr,
FileView reads/watches/writes, local component loading and WorkerScript.
FileView atomic writes use a temporary sibling plus rename, and `saved` follows
completion; this is not an fsync durability guarantee. `waitForJob` flushes a
pending write. WorkerScript runs separately with bounded local `Qt.include`
loading; no backend replies are substituted. Resources stop on disposal.

LoggingCategory filters the available levels, not the complete Qt logging-rule
language. IpcHandler currently registers an in-page dispatch table; it does not
implement Quickshell's Unix IPC protocol. Live Hyprland services and GlassTagger
are not supported. `Qt.openUrlExternally` invokes the existing local `xdg-open`.

## Implementation map

- `format.js`: MIME/path recognition only, safe in the controller.
- `parser.js`: QML grammar with the already vendored MIT Acorn for JavaScript.
- `loader.js`: bounded shared async/sync import resolver.
- `document.js`: DOM factories, scope/alias resolution and hygienic JS generation.
- `reactive.js`: dependency tracking, lazy dirty reads and batched updates.
- `runtime.js`: properties, lifecycle, bindings, layout, input and services.
- `models.js`: list/range/XML models and virtualized views.
- `text.js`: inert rich-text DOM and plain-text measurement input.
- `shapes.js`, `images.js`: existing SVG/canvas/raster rendering adapters.
- `host.js`, `worker-thread.js`: local-only capabilities and worker execution.

## Removal / integration boundaries

All integration outside this directory has removable blocks, separated from
surrounding code by blank lines:

```js
// qml handle begin: purpose
// integration block
// qml handle end
```

```sh
rg -n 'qml handle' lib
bun test/manual-qml-removal.js
```

Existing integrations are in `lib/document-types.js`,
`lib/renderer/page-renderer.js`, `lib/headless-shell.js`, `lib/renderer/host.js`
`lib/renderer/main.js`, `lib/renderer/canvas-2d.js`, and `frontends/wayland/index.js`. Delete the 17 marked blocks and `lib/qml`, plus its
tests/fixtures, to remove QML. Ordinary `let isHtml`, `let parsed`, `parsed ??=`,
renderer acquisition callbacks and default environments remain valid without
replacement statements. The removal test does this in a temporary copy and runs
ordinary renderer/navigation/headless tests. This Flea compatibility round adds one removable Wayland title-poll guard: it
waits until navigation has finished replacing a local QML renderer. All other
changes stay in `lib/qml` and `test`.

## References and provenance

Adjacent optional references, none a runtime dependency:

- [qmlweb-parser](https://github.com/qmlweb/qmlweb-parser), BSD-2-Clause.
- [qmlweb](https://github.com/qmlweb/qmlweb), MIT.
- [tree-sitter-qmljs](https://github.com/yuja/tree-sitter-qmljs), MIT.
- [qmlcore](https://github.com/pureqml/qmlcore), MIT.

Earlier import resolution consulted qmlweb's per-file contexts and directory
lookup; no qmlweb runtime was copied. This round uses Flea/Omarchy's MIT QML as
application inputs, public Qt API descriptions, and genuine Quickshell binary
behavior. No Quickshell implementation source was read or copied.
API behavior was checked against the public Qt documentation for
[Text](https://doc.qt.io/qt-6/qml-qtquick-text.html),
[focus scopes](https://doc.qt.io/qt-6/qtquick-input-focus.html),
[String.arg](https://doc.qt.io/qt-6/qml-string.html) and
[key/button enums](https://doc.qt.io/qt-6/qt.html).

Fixture provenance and bundled licenses are in
`test/fixtures/qml/flea-theme/README.md`.

## 中文說明

這是直接把 QML 編譯成既有 DOM、CSS、JS 的實驗，不產生 HTML，不保留另一棵
QML 元件樹，也不新增 Qt 或原生依賴。本輪程式集中在 `lib/qml`，測試在 `test`；
Wayland 前端另加一小段等待導航完成才輪詢標題的保護。外部接入總共是 17 個 `qml handle begin/end` 區塊，可以整段刪除，不必補回程式。

本地 `file:` QML 的專用 host renderer 現在允許 `ctx.drawImage(DOM元素, …)`，
沿用三種 drawImage 呼叫形式、縮放、裁切及 canvas 透明度／變換。
能力由內部記錄控制，普通 HTML（包含本地 HTML／host 模式）與遠端 QML 不啟用。
指定子樹由既有 painter 畫到離屏 CanvasKit surface，不包含兄弟元素與祖先裁切／透明度；
文字、內部堆疊與子 canvas 沿用原有繪製，不修改 DOM，也不經 PNG、base64 或像素回讀。
快照以來源 border box、每 CSS pixel 一個像素繪製，下一次 draw 才更新，暫存影像隨用隨釋放。
目前不接受未連接、display:none、只有 inline box 的來源、iframe 或包含目標 canvas 的子樹；
來源本身的 CSS visibility 仍有效。尺寸上限為單邊 8192、總計 16,777,216 像素，
跨來源圖片與受污染 canvas 的讀取限制會傳遞。這只是底層快照能力，
尚未接上 ShaderEffectSource 的 hideSource／更新生命週期與 ShapePath 材質填充。
測試：`bun test test/qml-canvas-dom.test.js`。

目前原版 Flea 已能啟動真正的主視窗、Theme／Commons／Ui、設定頁、鍵盤說明、
路徑輸入、網路分享表單，以及文字、CSV、Markdown、SVG／PNG 預覽。
Markdown 用原版 worker，圖片可測縮放與還原；Wayland 實測可用 Super-W 關窗。
所有應用程式測試都使用獨立 HOME／XDG，不寫個人設定，也沒有偽造後端回覆。

已解析 239 個 QML 檔案，235 個頂層 UI 元件中 227 個能編譯；這不是完整功能覆蓋。
剩餘編譯阻礙包含 ShaderEffectSource、PDF、AnimatedImage 和 QtMultimedia。
最初 73 項測試沒有 Flea 後端；後續已用 Omarchy 官方 0.3.12-1 aarch64 套件，
驗證官方 binary 直接呼叫我們的 `lib/qml/qs` wrapper，經標準 Wayland 顯示。
真實列檔、目錄新增通知、Ctrl-L／Enter 切換目錄及 Super-W 關閉已測過。
`DelegateModel.items.create()` 會在完成回呼前提供持久項目狀態，列表接手時
沿用既有項目，不重新建立。複製／搬移／刪除、掛載與預覽切換仍未完整驗證。

上方 `test/manual-flea-binary.js` 會呼叫官方 `flea --gui`，只對該程序把
暫時目錄放在 PATH 最前面，其中 `qs` 連結至 `lib/qml/qswayland`，
保留系統原本的 Quickshell；使用隔離 HOME／XDG
與範例檔案，關窗後清除。後端與 QML 請使用同一份套件。wrapper 支援
`-p/--path`、`-c/--config`，不支援的參數會明確失敗，不冒充原生 QS IPC。
請先使用列表檢視（Ctrl-1）；保存的欄式檢視仍會遇到未支援的
`ShaderEffectSource` 而出現空白內容區。無後端時仍是上游的 unavailable 狀態。

本機 QML 是有 Bun 權限的應用程式，使用專屬 renderer；HTTP QML 保持隔離。
匯入、singleton、alias、動態 Loader、模型／虛擬列表、鍵盤輸入、程序／檔案／worker
已接通所測路徑，但不是完整 Qt 相容層。多視窗、原生拖放、Quickshell IPC、媒體與
精確渲染同步等仍有限制，詳見上方各節。

### Termux udocker Debian 實驗

2026-10-23 已確認：官方 **Flea 0.3.12-1 aarch64** 可經 `qswayland` 在獨立
Debian 13（trixie）容器執行，畫面送到**容器外原本開著的 Land**。這次是透過
`jsgotty --client` 連入 Termux 原生 shell 後啟動，不是從開發用 Debian proot 再套一層。

容器名稱為 **`flea-qswayland`**，Termux 上的根目錄為
`~/.udocker/containers/flea-qswayland/ROOT`，ID 為
`82ef2c52-a491-4723-9604-855f22bd92d5`。先用
`udocker run -b "$TMPDIR:/tmp" debian` 建立，再以 `udocker rename` 命名。

除了 Flea 整包與 `/opt/buninu-browser`（不含 `.git`、`node_modules`），還複製了
Linux aarch64 glibc Bun 1.4.4 到 `/usr/local/bin/bun`，以及 Omarchy 的
`Commons`／`Ui` 到 `/usr/share/omarchy/shell/`。因此不是只複製兩份專案就足夠，
但沒有額外 apt/npm 安裝，也沒有安裝 Qt 或原生 Quickshell。

Flea 套件原本就有指向 Omarchy 模組的符號連結；另建立
`/usr/share/omarchy/qs → shell`，讓具名匯入能找到 `qs.Commons`／`qs.Ui`。
預設 PATH 中的 `/usr/local/bin/qs` 使用上方同一份 wrapper，先設定
`QML_IMPORT_PATH`，再直接執行 `qswayland`。

在 **Termux 原生端**重新進入：

```sh
udocker run -b "$TMPDIR:/tmp" flea-qswayland
```

在**容器內**啟動：

```sh
env XDG_RUNTIME_DIR=/tmp \
  WAYLAND_DISPLAY=wayland-buninu \
  QSG_RHI_BACKEND=opengl \
  flea --gui /root
```

綁定 tmp 是為了共用 `/tmp/wayland-buninu` socket，Land 不搬入容器。
`QSG_RHI_BACKEND=opengl` 只是跳過 Flea 的原生 Vulkan 探測，不代表我們的前端
改用 GPU。官方 Flea 會從 PATH 找到 `qs`，再啟動真正的 `--backend`。

已從 Land 截圖確認容器內的 `/root/Documents`、`/root/hello.txt` 正常列出；
這只驗證啟動與基本列檔，不代表 Trash、掛載、預覽及所有外部工具整合都已可用。
容器內 `/root/FLEA-TEST.txt` 留有操作紀錄，共用 tmp 的
`/tmp/flea-udocker.log` 是測試 log。瀏覽器是複製的快照，更新專案後需重新同步。

本次解壓時 Android 拒絕建立 `/usr/bin/perl5.40.1` 硬連結，已把
`/usr/bin/perl` 複製成該檔案補齊；當次沒有回報其他解壓錯誤。

## Explicit backend entry points

The package launcher accepts Quickshell arguments independently of the backend:

```sh
bun index.js --quickshell-wayland -p /path/to/shell.qml
bun index.js --quickshell-headless -p /path/to/shell.qml -- --remote-debugging-port=9222
bun index.js --quickshell-casty -p /path/to/shell.qml
```

Each entry accepts `-p`/`--path`, `-c`/`--config`, and `-h`/`--help`.
Use `--` to pass subsequent arguments to the backend. For Casty, an additional
`--` forwards engine arguments, for example `-- -- --mobile`.
Standalone `lib/qml/qs` still launches Wayland directly without going through
`index.js`. These entries do not imply full native Quickshell compatibility.

套件入口可明確選擇 Wayland、headless 或 Casty，並使用相同的 QS 設定解析。
三個入口都接受 `-p`／`--path`、`-c`／`--config`、`-h`／`--help`。
用 `--` 分隔後端參數；Casty 再用一個 `--` 分隔瀏覽器引擎參數，
例如 `-- -- --mobile`。獨立的 `lib/qml/qs` 仍直接啟動 Wayland，
不經過 `index.js`。這些入口不代表已完整相容原生 Quickshell。

The same entries can run independently; `index.js` only routes arguments to them:

```sh
bun lib/qml/qswayland -p /path/to/shell.qml
bun lib/qml/qsheadless -p /path/to/shell.qml
bun lib/qml/qscasty -p /path/to/shell.qml
```

這三個檔案也能獨立執行；`index.js` 僅負責路由並原樣傳遞參數。
共同的 QS 解析與後端啟動邏輯位於 `lib/qml/launcher.js`。
原有 `lib/qml/qs` 保留原本的直接 Wayland 啟動方式。
