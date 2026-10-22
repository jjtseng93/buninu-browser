# Real Flea Theme fixture

Unmodified dependency sources, selected by the QML import graph:

- `ui/`: https://github.com/thisisgm/flea at `f21789e56cc4b0877caa3156fff7bce52a8dd9c2`, MIT (`LICENSE-Flea`).
- `imports/qs/Commons/`: https://github.com/basecamp/omarchy at `3c7027db2a4fa9fa6a49d7af7f87c27ac48e677d`, MIT (`LICENSE-Omarchy`).
- `demo.qml`: our test window. Both original qmldir files are preserved; entries outside the tested dependency graph are not bundled.

Unlike `../flea/`, this fixture uses the actual Theme.qml, ThemeColors.qml,
Glass.qml, ViewState.qml and Omarchy Color/Style/Util singletons. Nothing injects
fake Theme/Style values. Test HOME contains sample colors.toml and shell.toml;
these are input data, not substitute QML implementations.

`bun test/manual-flea-theme.js` opens it on the existing Wayland socket and creates
an isolated temporary HOME. Closing the window removes that temporary directory.
`bun test test/qml-host.test.js` verifies real palette parsing, measured column
widths, font size changes through the theme.name watch, process output and cleanup,
and return from local QML host mode to ordinary sandboxed HTML.

No running Hyprland or Flea Rust backend is required for this Theme test. Missing
hyprctl takes the upstream fallback paths; live Hyprland-dependent GlassTagger
creation and full Flea settings writes are not claimed as tested or supported.
The current test covers the Theme path on Land, not the entire Flea application.

本目錄保留真正上游 QML／JS；Theme 及 Commons 不是 stub。手動示範使用獨立的
臨時 HOME，讀入範例 TOML，關窗後移除。測試涵蓋主題讀取、文字尺寸、主題更新、
程序輸出與清理，以及切回普通網頁的隔離。未宣稱完整 Flea 或 Hyprland 相容。

## SettingsRuler

`ui/SettingsRuler.qml` is another unchanged file from the same Flea revision.
`settings.qml` is our interactive test wrapper: selecting a size changes the real
ViewState in memory; Theme updates both the original ruler and a text preview.
The wrapper does not call the persistent settings writer.

`test/qml-quickshell-settings.test.js` optionally runs the same wrapper and upstream
sources with a locally available Quickshell binary on an isolated Land instance.
Qt eagerly checks qmldir entries absent from this subset, so only its temporary
fixture copy filters those missing entries. No QML/JS source is replaced or stubbed.
The repository's original qmldir files remain unchanged.

SettingsRuler 來自同一上游版本，原檔未修改。互動範例只調整記憶體內的 ViewState，
不寫個人設定；Quickshell 對照的暫存副本只刪除未打包檔案的 qmldir 索引。
