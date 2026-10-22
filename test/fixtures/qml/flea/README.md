# Flea leaf-component experiment

`EscapeHint.qml` is an unchanged copy of `ui/EscapeHint.qml` from
https://github.com/thisisgm/flea at f21789e56cc4b0877caa3156fff7bce52a8dd9c2.
MIT, Copyright (c) 2026 GM; see LICENSE.

This is an isolated component test, not the Flea application. `test/manual-flea-qml.js`
provides a **test Theme object** through the existing page init-script API.
It does not load Flea's actual Theme singleton (which depends on Omarchy services,
Quickshell.Io and several JS modules). The component source is unmodified.

```sh
XDG_RUNTIME_DIR=/tmp WAYLAND_DISPLAY=wayland-buninu bun test/manual-flea-qml.js
```

The surrounding heading and background are test scaffolding.
The actual upstream component is the small `esc` text. The injected Theme is static;
this test does not claim singleton loading or reactive external theme updates.

這是 Flea 原始 EscapeHint 元件的隔離測試，並非完整 Flea。
Theme 由測試程式提供，尚未載入真正的 Omarchy 主題與服務。
標題與底色是測試框架；`esc` 才是未修改的上游元件內容。
