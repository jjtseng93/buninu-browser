# Experimental QML DOM frontend

This directory is an isolated experiment, not a QtQuick or Quickshell replacement.
It creates the browser's existing DOM nodes directly. It does not generate HTML,
feed generated markup through the HTML parser, or keep a QML component tree at
runtime. The temporary AST is discarded after DOM construction and JS generation.
Only flat DOM references, property state and reactive dependencies survive in the
normal page realm. Rendering, input, screenshots and navigation use the existing
browser pipeline. `FloatingWindow` means the document's root item, not an OS window.

## Try it

From the buninu-browser repository:

```sh
bun index.js file://"$PWD"/test/fixtures/qml/hello.qml
bun index.js --headless --window-size=800,480 --screenshot=/tmp/qml.png \
  file://"$PWD"/test/fixtures/qml/hello.qml
bun test test/qml.test.js
```

The fixture has a click counter, a parent-width binding, centered text and a
reactive background. Resizing the viewport updates the root and its descendants.
QML loads for `text/x-qml`, `application/x-qml`, or `.qml` paths with generic/text
MIME types. Explicit HTML MIME types retain HTML behavior. Large responses retain
the existing bounded text preview; downloads still contain the original bytes.
Unsupported syntax/imports/types/properties show a diagnostic and inert source.
Scripting disabled shows source rather than silently enabling execution.

## Layout

- `format.js`: MIME/path recognition only; safe to import in the controller.
- `parser.js`: deliberately limited QML grammar, using the already vendored MIT
  Acorn for embedded JS tokenization/AST. No additional npm dependencies.
- `loader.js`: bounded, per-document import graph through the existing resource bridge;
  relative/URI imports, qmldir entries, singletons and JS dependencies.
- `document.js`: DOM factory and JS identifier/binding translation. It never
  evaluates QML expressions during compilation. Generated JS runs in the selected renderer realm.
- `reactive.js`: small dependency tracker with microtask batching, dynamic
  dependency cleanup and an update-loop limit. Not a SolidJS dependency.
- `runtime.js`: DOM/CSS updates and viewport signals, serialized into the page
  realm. Imperative property assignment detaches that property's binding.

## Initial subset

Imports: `QtQuick`, `QtQuick.Controls` and `Quickshell`, optionally with a numeric version. Version
syntax is accepted but does not claim compatibility with that module's API.

Types: `Item`, `Rectangle`, `Text`, `MouseArea`, `FloatingWindow`, `Column`,
`Label`, `TextField`, `Button`, `QtObject`, `Singleton`.

The Controls subset maps directly to DOM inputs/buttons; it does not emulate Qt's
style engine. Column uses CSS flex column/gap and natural DOM height. TextField
synchronizes user input with `text`, supports `readOnly`, `placeholderText`,
`selectByMouse` (CSS selection policy) and `Accessible.name` (ARIA label).
Ctrl+A/Meta+A selects the field; Button supports Enter/Space activation.
Mouse selection/caret behavior otherwise follows the browser's existing input support.
A root FloatingWindow fills the supplied browser viewport; implicit dimensions do
not resize the native window yet.

`test/fixtures/qml/multiply.qml` is the same interactive three-field calculator
verified with real Quickshell. Open it with `bun index.js --wayland file:///…/multiply.qml`.

新增的 Column、Label、TextField、Button 直接映射成 DOM/CSS，不模擬 Qt 主題。
文字輸入會同步到 QML 的 text，支援唯讀、提示文字、無障礙名稱與 Ctrl+A 全選。
Column 使用 CSS flex 排列；滑鼠選字／游標仍受現有 Browser 輸入能力限制。
乘法範例與真正 Quickshell 測過的是同一份 QML，沒有針對範例檔名的特判。

Properties: `id`; initialized `property int/real/bool/string/var/color` (no Qt type
coercion yet); width/height/implicitWidth/implicitHeight, x/y, color, radius,
opacity, visible, enabled, clip, text, title; font pixelSize/family/bold; border
width/color; anchors fill/centerIn/margins; horizontalAlignment (left/center).
Text supports explicit `textFormat: Text.PlainText`; other formats still report a diagnostic.
Handlers: `onClicked`, `Component.onCompleted`. JS expressions/blocks are parsed
by Acorn, but QML scope translation is experimental, not full Qt name resolution.

Not implemented: required properties, typed QML functions, signal declarations, the remaining QtQuick Controls, ListView/delegates,
animations, image/media objects, Quickshell process/IO/services, Omarchy modules,
multiple OS windows. Flea cannot run on this initial subset. Unsupported features
should be added explicitly with tests, not silently treated as empty items.

## Removal / integration boundaries

All integration outside this directory uses the same markers, separated from
surrounding code by blank lines:

```js
// qml handle begin: purpose
// integration block
// qml handle end
```

Find them with:

```sh
rg -n 'qml handle' lib
```

Existing integration points are marked `qml handle`:

1. `lib/document-types.js`: format recognition, unchanged by host support.
2. `lib/renderer/page-renderer.js`: QML DOM factory, host attachment and disposal.
   The ordinary `let isHtml`, `let parsed`, and `parsed ??=` HTML fallback remain.
3. `lib/headless-shell.js`: QML-specific arguments and renderer selection.
   The ordinary origin key, spare acquisition and navigation remain outside blocks.
4. `lib/renderer/host.js`: QML-only environment inheritance. The default empty
   environment (plus Windows SystemRoot) remains outside the block.
5. `lib/renderer/main.js`: the internal QML-host flag overrides ordinary settings.
   The original `--dangerously-allow-host-js` test and reason remain outside.

Delete every marked begin/end block (including the markers) in these five files,
then remove `lib/qml` and the QML-specific tests/fixtures. No replacement statements
or restored function bodies are needed. General-purpose local variables and
acquisition callbacks remain valid without QML. No changes were made to the page
realm, CSS/layout engine, compositor, transport or package entry points.
QML types, host services and compatibility stay under `lib/qml`.

Verify removal without changing the working tree:

```sh
bun test/manual-qml-removal.js
```

This copies the browser to a temporary directory, deletes the 13 integration
blocks and `lib/qml`, then runs ordinary renderer, navigation and headless tests.
暫存副本會實際刪掉接入區塊及 QML 目錄再測試，不會改動工作目錄。


## Reference checkouts

Adjacent repositories, for reading only; none is a runtime dependency:

- `../qmlweb-parser`: https://github.com/qmlweb/qmlweb-parser — BSD-2-Clause.
- `../qmlweb`: https://github.com/qmlweb/qmlweb — MIT.
- `../tree-sitter-qmljs`: https://github.com/yuja/tree-sitter-qmljs — MIT.
- `../qmlcore`: https://github.com/pureqml/qmlcore — MIT.

These can inform future compatibility work. The initial QML subset is implemented
here using existing Acorn, rather than importing an old QML runtime or Python toolchain.

## 中文說明

這是可獨立移除的 QML 實驗入口。QML 解析後直接建立現有 DOM、設定 CSS，
並把綁定與事件產生為普通頁面 JavaScript；不產生 HTML，不保留另一棵 QML
元件樹，也不新增原生依賴。所有核心程式集中在本目錄。

外部接入集中在上述五個檔案的 `qml handle begin/end` 區塊。
刪除全部標記區塊及本目錄即可移除功能，不需要補回任何程式；QML 專用測試與
fixtures 可一併移除。一般文件建立、renderer 選擇及隔離環境的預設值都留在區塊外。
已提供互動元件與下述 import 路徑；不宣稱可跑完整 Flea。

## Imports and component scope / 匯入與元件作用域

- Relative directory imports (`import "." as UI`) and implicit sibling component lookup.
- Custom components with isolated internal IDs, per-instance properties, external
  overrides, inheritance, methods and property aliases. Readonly properties reject writes.
- Directory `qmldir`: component entries, `singleton`, `internal`, module name and
  version selection (same major, highest available minor not above the requested version).
- Named modules (`import Demo.Toolkit 1.0 as Tools`) resolve `Demo/Toolkit/qmldir`
  under the importing file's directory, then the entry document's directory.
- `pragma Singleton` + a singleton qmldir entry creates one shared object per page
  navigation. Reload creates a fresh graph and fresh singleton state.
- JS imports (`import "logic.js" as Logic`), nested `.import "other.js" as Other`,
  exported top-level functions/variables, and `.pragma library`. Ordinary JS state
  belongs to its component instance; library JS shares state within the document.
- Source code runs in the renderer, never in the controller. Local top-level QML
  uses a dedicated host renderer; HTTP(S) QML retains the isolated page realm.

The loader accepts file and HTTP(S) resource URLs using existing resource permissions.
Remote QML cannot import local files. A data URL can use built-ins but cannot resolve
relative imports. Limits: 128 resource requests, 256 KiB per imported source, 4 MiB
combined imported sources, import depth 48 and 2,000 expanded objects. Recursive
component construction, JS dependency cycles, missing imports and native
plugin directives produce a visible diagnostic and the original document source.

Built-in Qt module version numbers are accepted, not a claim of full Qt API coverage.
Local QML searches QML_IMPORT_PATH for URI modules. There are no version-suffixed module directories,
native Qt plugin loading, qmldir dependency/prefer directives, dynamic Loader,
or `.mjs`/ES-module export syntax yet. Rich text and the remaining QML/Qt types
remain separate features. Component completion and binding semantics are still
an experimental subset, not a full Qt compatibility claim.

相對路徑、同目錄元件、命名模組、qmldir、singleton 與 JS import 已接成同一條
載入路徑。每份元件有獨立 id／屬性；singleton 與 library JS 在同一文件共用，
重新導航時重建。支持屬性覆寫、readonly、alias 與普通 JS 語法的方法。

HTTP QML 仍走隔離的頁面 realm；本機 QML 使用獨立 host renderer，具備本機應用程式權限。
不支援的原生服務、模組或語法會明確報錯，不注入替代品。
命名模組查匯入檔案、入口文件及本機 QML_IMPORT_PATH；不載入原生 Qt plugin。

```sh
bun index.js --wayland file://"$PWD"/test/fixtures/qml/imports/main.qml
bun test/manual-flea-qml.js
bun test test/qml-imports.test.js test/qml-flea.test.js test/qml.test.js
```

The Flea demo loads unchanged upstream EscapeHint.qml via real imports. Its local
Theme.qml is explicitly a test theme, not the Omarchy-dependent upstream Theme.
The old injected JS Theme and source-inlining harness have been removed.
See `test/fixtures/qml/flea/README.md` for provenance and limits.

Flea 範例已改用真正 import，按鈕可同時更新兩個 esc 的共用主題；Theme.qml
仍是標示清楚的測試主題，不代表完整 Flea／Omarchy 已能執行。

Reference consulted: qmlweb's per-file import contexts and qualified directory
lookup (`../qmlweb/src/engine/QMLEngine.js`, MIT). No qmlweb runtime dependency or
source code was copied; our graph is compiled away into the existing DOM/page JS.


## Local QML applications / 本機 QML 應用程式

Local `file:` QML automatically uses host JavaScript in a dedicated renderer,
with the application's environment (HOME, PATH, XDG_RUNTIME_DIR, QML_IMPORT_PATH).
This is executable application code with Bun access, not sandboxed web content.
A reload starts a fresh renderer. Navigating to ordinary HTML, including a file in
that same directory, swaps back to the normal renderer; host objects are not reused.
Explicit `--dangerously-allow-host-js` keeps its existing all-pages meaning.

The QML-only `lib/qml/host.js` adapter supplies filesystem reads/watches and process
execution. FileView reads/reload/waitForJob are synchronous; Process stdout/stderr
collectors and exit handlers are asynchronous. Resources are disposed on document
replacement or renderer termination. Browser input, layout, raster, CDP and Wayland
frontends continue to use their existing paths. Integrations carry `qml handle`
markers. Remote QML does not receive this adapter or the host environment.

This stage adds object-valued properties, required properties, signals,
Connections, Timer, FileView, Process/StdioCollector, TextMetrics/FontMetrics,
Qt color values and the color helpers used by Theme. Mutually referring singleton
objects are allocated before their bindings run (e.g. Theme/Glass, Color/Style).
It does not implement every Qt/Quickshell method: Qt.createComponent/Qt.binding
and the live Hyprland GlassTagger path remain explicit unsupported operations.

本機 QML 自動使用專屬 host renderer，繼承主機環境，可讀檔、監看與執行程序。
重新載入會建立新 renderer；離開 QML 回到普通 HTML 時會換回原本隔離路徑，
並清理原本的監看與程序。HTTP QML 不會取得這些主機能力。
本階段已接通真正 Flea Theme 與 Omarchy Commons；不是完整 Flea 相容宣告。

```sh
bun test/manual-flea-theme.js
bun test test/qml-host.test.js
```

The real Theme fixture and its upstream licenses/provenance are in
`test/fixtures/qml/flea-theme/README.md`. The earlier `manual-flea-qml.js` remains
an intentionally small test-theme demonstration.

## Settings ruler / 設定刻度控制項

The unchanged upstream Flea `SettingsRuler.qml` now runs with the real Theme.
The demo changes shared ViewState in memory, updates the preview font, disables
and re-enables the ruler, and restores the Omarchy size. It does not save settings.

```sh
bun test/manual-flea-settings.js
bun test test/qml-repeater.test.js test/qml-host.test.js
# Optional: compare with an already extracted Debian arm64 Quickshell binary.
BUNINU_QS_ROOT=/path/to/sid/root bun test test/qml-quickshell-settings.test.js
```

Repeater delegates compile to ordinary JS DOM factories, with per-instance IDs,
index/modelData, array or numeric models, count/itemAt and nested repeaters.
Replacing the model rebuilds delegates and disposes their bindings/listeners.
Limits: 1,000 model entries and 2,000 live objects; no ListModel, incremental model
notifications or service objects inside delegates yet. This is not a virtual list.

TapHandler currently maps DOM clicks for ReleaseWithinBounds; it is not Qt's full
gesture arbitration/multitouch implementation. HoverHandler supplies pointer cursor
and enter/leave state. Text implicit dimensions use the existing canvas text
measurement, and horizontal-center anchors map to CSS positioning.

未修改的上游 SettingsRuler 已能互動，使用真正 Theme／ViewState；範例只修改記憶體，
不寫入個人設定。Repeater 編譯為建立 DOM 的 JS 函式，不保留 QML AST；每個委派有
自己的 id 與綁定，替換模型時會清理舊事件與效果。這不是完整設定面板或虛擬列表。
上述可選 Quickshell 對照只執行現有 binary，在獨立 Land 上測點擊，不讀其原始碼。
