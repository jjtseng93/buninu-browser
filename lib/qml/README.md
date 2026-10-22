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
- `document.js`: DOM factory and JS identifier/binding translation. It never
  executes QML expressions in the host. Generated JS runs as an ordinary page script.
- `reactive.js`: small dependency tracker with microtask batching, dynamic
  dependency cleanup and an update-loop limit. Not a SolidJS dependency.
- `runtime.js`: DOM/CSS updates and viewport signals, serialized into the page
  realm. Imperative property assignment detaches that property's binding.

## Initial subset

Imports: `QtQuick`, `QtQuick.Controls` and `Quickshell`, optionally with a numeric version. Version
syntax is accepted but does not claim compatibility with that module's API.

Types: `Item`, `Rectangle`, `Text`, `MouseArea`, `FloatingWindow`, `Column`,
`Label`, `TextField`, `Button`.

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
Handlers: `onClicked`, `Component.onCompleted`. JS expressions/blocks are parsed
by Acorn, but QML scope translation is experimental, not full Qt name resolution.

Not implemented: custom QML components, import loading/qmldir, required/readonly/
alias properties, signal declarations, the remaining QtQuick Controls, ListView/delegates,
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

Only two existing files contain integration:

1. `lib/document-types.js`: remove both marked blocks (import and classification).
2. `lib/renderer/page-renderer.js`: remove both marked blocks (import and DOM
   factory). The ordinary `let isHtml`, `let parsed`, and `parsed ??=` fallback
   remain outside the blocks. No original lines need to be restored. The fallback
   calls the HTML parser only when no frontend has supplied a document, so QML
   does not construct and discard an unnecessary HTML document.

Then remove `lib/qml`, `test/qml.test.js`, and `test/fixtures/qml`. No changes to
package.json, the launcher, CSS/layout engine, page realm, compositor or transport
are needed. Tests are intentionally kept in one QML-specific test file.

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

外部僅有兩個檔案、四個 `qml handle begin/end` 區塊。移除方式如上，
四個接入區塊都能直接刪除，不需要補回原本程式。一般文件的建立流程留在區塊外。
目前只提供 Hello World、點擊計數、基本尺寸與屬性綁定；不宣稱可跑 Flea。
