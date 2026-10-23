# Experimental Wayland frontend / 實驗性 Wayland 前端

```sh
XDG_RUNTIME_DIR=/tmp WAYLAND_DISPLAY=wayland-buninu \
  bun index.js --wayland file:///absolute/path/to/hello.qml
# HTML works through the same frontend:
bun index.js --wayland https://example.com --window-size=800,600
```

Uses the existing browser controller and renderer. No Qt, libwayland, native addon,
new dependency, PNG encoding, or base64. Only libc is loaded, because Bun sockets
cannot send/receive SCM_RIGHTS ancillary file descriptors. Linux/Android 64-bit only.
The default launcher remains Casty. External integration blocks in index.js are
marked `wayland handle`; the frontend lives entirely in this directory.

沿用現有 Browser controller 與 renderer，不新增依賴；僅為傳送 fd 使用 libc。
預設仍是 Casty，只有指定 `--wayland` 才啟用。入口整合標記為 `wayland handle`。

## Address bar / 網址列

Ordinary pages have a 32-pixel address bar. Click the URL or press Alt+L to edit;
click `@` or press Ctrl+E for `cmd>`. Tab switches URL/command mode. Casty's editor
provides horizontal scrolling, Shift-arrow and mouse-drag selection, double-click
history/submit gestures, and Ctrl+C / Alt+C copying plus Ctrl+V insertion (replacing
selected text). Escape cancels editing; `q` quits. `help` lists applicable commands;
CDP and terminal transport commands are omitted. QML applications have no bar.

一般網頁頂部有 32 像素高的網址列。點網址或按 Alt+L 編輯，點 `@` 或按 Ctrl+E
進入 `cmd>`；Tab 切換模式。沿用 Casty 的水平捲動、Shift 方向鍵與滑鼠拖曳選取、
雙擊歷史／送出操作，以及 Ctrl+C／Alt+C 複製、Ctrl+V 插入（有選取時取代選取）。
Escape 取消編輯，`q` 退出；`help` 列出適用命令，不包含 CDP 與終端傳輸命令。
QML 應用不顯示網址列。

Editing the address bar never pauses page frame updates. Only chrome-only changes
reuse the latest page frame. The cached bar is rasterized separately; raw BGRA
page bytes go straight to SHM beside the bar, without PNG or full-page canvas
composition. The bar's small RGBA raster is converted to BGRA; page channels are
not converted. Presentation still writes a complete SHM buffer.

編輯網址列不會暫停頁面更新。只有網址列本身改變時才沿用上一張頁面；網址列獨立
繪製並快取，頁面的 raw BGRA 直接與它分段寫入 SHM，不經 PNG 或整頁 Canvas
合成。只有網址列的小圖需要 RGBA 轉 BGRA；提交仍需寫入完整 SHM buffer。

`casty/` vendors Casty's MIT-licensed editor and helpers (license included).
The editor changes replace terminal cursor output with a no-op and terminal column
lookup with an injectable width; its rendering is overridden by `urlbar.js`.
Page find/console helpers are extracted from Casty's input module. Navigation,
clipboard and drawing are adapted here to the existing browser controller.

`casty/` 保留 Casty 的 MIT 授權編輯器與輔助程式；移除終端游標輸出，欄寬改為
可指定，繪製由 `urlbar.js` 覆寫。搜尋／console 輔助函式取自 Casty input 模組。
導航、剪貼板與繪製則由此處的薄接層呼叫現有 browser controller。

## Pixels and lifetime / 像素與生命週期

`xdg_wm_base` → `xdg_surface` → `xdg_toplevel`; acknowledge configure before commit.
`wl_shm` XRGB8888 buffers contain BGRX bytes on supported little-endian platforms.
The browser currently supplies BGRA; XRGB deliberately ignores alpha (opaque window).
At most two buffers are outstanding. A buffer is reused only after `wl_buffer.release`;
frame callbacks pace commits and dirty events coalesce. Resize uses fresh buffers.
SHM files are mode 0600 and unlinked immediately after opening.

Current copies: renderer → browser raw temporary file → JS read → shared buffer →
compositor. This first frontend does not promise zero-copy or GPU acceleration.
The producer's raw file is removed after consumption, including error paths.

使用標準共享記憶體、configure/ack、frame callback 與 buffer release。最多兩個
尚未釋放的 buffer；不會覆寫 compositor 正在使用的 buffer。視窗目前不透明。
目前仍有 raw 暫存檔讀取與共享 buffer 寫入，尚非零拷貝或 GPU 路徑。

## Input and scope / 輸入與範圍

Pointer motion, left click, scrolling, basic XKB keymap symbols and modifiers.
Keyboard input uses the controller's existing paired keydown/keyup operation.
Not full XKB: no compose, IME, layout groups, repeat, or independently held keys.
No client cursor, drag/drop, popup, layer-shell or fractional scaling yet.
Text controls, navigator.clipboard and the address bar share the Wayland data-device
clipboard. Host tools are a fallback when no Wayland selection is offered; successful
nonempty host reads are published to Wayland so Land can retain its text cache.
Clipboard API security/user-activation checks remain in effect.
文字框、navigator.clipboard 與網址列共用 Wayland 剪貼簿；沒有 Wayland 選取來源時
才讀主機工具，成功取得的非空文字也送回 Wayland，讓 Land 可以快取。
網頁 API 原本的安全來源與使用者操作檢查仍保留。
Connection and window are separate objects, but the launcher currently opens one
browser document/window. QML `ShellRoot` and multiple windows are not implemented.

支援基本滑鼠、左鍵、捲動與鍵盤；尚非完整 XKB/IME。按鍵沿用 controller 的成對
按下／放開，不支援獨立長按。啟動器目前只有單一文件／視窗。

## Compatibility targets / 相容性目標

Neither Flea nor Omastorm runs unmodified on the current QML subset.
Flea 和 Omastorm 目前都還不能直接以現有 QML 子集執行。

* Flea: ShellRoot, custom components/imports, models, controls/layouts, Quickshell.Io
  process/IPC and multiple windows. Tab tearoff also uses PanelWindow/WlrLayershell.
* Omastorm (`../omastorm`, MIT reference checkout): its manifest exposes bar-widget
  and panel entry points. Requires custom components, Controls/Layouts, FileView,
  Process, Socket/SplitParser, IPC, timers, Image/Canvas and ShaderEffect.
  `docs/protocol.md` defines newline-delimited JSON v2 over
  `$XDG_RUNTIME_DIR/omastorm/engine.sock`, served by the separate Rust engine.
  GPU texture files and shaders require rendering compatibility beyond DOM parsing.

Flea 需要多視窗、元件、模型與程序／IPC；分離分頁另需 layer-shell。
Omastorm 還需要 Unix socket JSON 橋接及雷達 shader／貼圖支援；只有 parser
與標準 Wayland 視窗不足以適配。不會為一般網頁開放主機檔案或程序權限。

References: https://github.com/thisisgm/flea and https://github.com/wesleygrimes/omastorm

## Verification / 測試

```sh
bun test test/wayland-frontend.test.js
# Optional integration with the existing sibling buninu-land checkout:
BUNINU_TEST_WAYLAND=1 bun test test/wayland-frontend.test.js
```

The integration test creates its own compositor/socket; it does not interrupt the
user's compositor. Checks SHM presentation, pointer click, keyboard and resize.
整合測試使用獨立 socket，不影響使用者正在執行的 Land。

Protocol XML retains upstream license notices. Transport/protocol code adapted
from Buninu Land (MIT), see LICENSE-land. XML is interpreted at runtime with Bun.XML.
