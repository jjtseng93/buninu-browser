# Flea leaf-component import test

`EscapeHint.qml` is an unchanged copy of `ui/EscapeHint.qml` from
https://github.com/thisisgm/flea at f21789e56cc4b0877caa3156fff7bce52a8dd9c2.
MIT, Copyright (c) 2026 GM; see LICENSE.

`demo.qml` now imports this component normally through `import "." as Flea`
and `qmldir`. Two instances share `Theme.qml`, a **local test theme** declared
as a real QML singleton. The button changes its property and both labels react.
There is no source-body inlining or injected global JavaScript Theme object.

This Theme.qml is our test implementation, not Flea's upstream Theme. The real
Flea Theme also needs Omarchy modules, Quickshell services and more QML syntax.
Those dependencies remain explicit compatibility gaps, not silent stubs.

```sh
XDG_RUNTIME_DIR=/tmp WAYLAND_DISPLAY=wayland-buninu bun test/manual-flea-qml.js
bun test test/qml-flea.test.js
```

EscapeHint 保留上游原碼與授權。範例透過真正的相對 import、qmldir 與 QML
singleton 載入兩個實例；按鈕會修改共用主題，兩個 esc 一起變色。
不再拼接元件內容，也不注入 JS 全域 Theme。

Theme.qml 是明確標示的測試主題，並非 Flea 上游的 Omarchy 主題實作。
