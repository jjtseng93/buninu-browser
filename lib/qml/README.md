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

**Full Flea file management is not yet supported or validated.** No Flea backend
was installed during this work. Without `FLEA_BIN`, the main app displays its own
unavailable state. Real listing/navigation, copying/moving/deleting, mounts,
clipboard integration, PDF/media, and preview texture transitions remain outside
this result. A compile inventory is not an end-to-end application test.

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
empty stubs. Supporting snapshots of a subtree properly needs additional rendering
work; a screenshot of the whole viewport would include unrelated siblings/overlays.

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
`lib/renderer/main.js`, and `frontends/wayland/index.js`. Delete the 14 marked blocks and `lib/qml`, plus its
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
Wayland 前端另加一小段等待導航完成才輪詢標題的保護。外部接入總共是 14 個 `qml handle begin/end` 區塊，可以整段刪除，不必補回程式。

目前原版 Flea 已能啟動真正的主視窗、Theme／Commons／Ui、設定頁、鍵盤說明、
路徑輸入、網路分享表單，以及文字、CSV、Markdown、SVG／PNG 預覽。
Markdown 用原版 worker，圖片可測縮放與還原；Wayland 實測可用 Super-W 關窗。
所有應用程式測試都使用獨立 HOME／XDG，不寫個人設定，也沒有偽造後端回覆。

已解析 239 個 QML 檔案，235 個頂層 UI 元件中 227 個能編譯；這不是完整功能覆蓋。
剩餘編譯阻礙包含 ShaderEffectSource、PDF、AnimatedImage 和 QtMultimedia。
本輪沒有安裝 Flea 後端，因此不能宣稱完整列檔、檔案操作、掛載或預覽切換可用。
無後端時顯示的是上游本身的 unavailable 狀態。上方列出實際測試與手動啟動命令。

本機 QML 是有 Bun 權限的應用程式，使用專屬 renderer；HTTP QML 保持隔離。
匯入、singleton、alias、動態 Loader、模型／虛擬列表、鍵盤輸入、程序／檔案／worker
已接通所測路徑，但不是完整 Qt 相容層。多視窗、原生拖放、Quickshell IPC、媒體與
精確渲染同步等仍有限制，詳見上方各節。
