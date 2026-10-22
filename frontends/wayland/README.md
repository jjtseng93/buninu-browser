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
No clipboard, client cursor, drag/drop, popup, layer-shell or fractional scaling yet.
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
