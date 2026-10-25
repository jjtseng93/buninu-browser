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

Pointer motion, left/right/middle clicks, double clicks, scrolling on both axes,
basic XKB keymap symbols and modifiers. Right clicks dispatch `contextmenu`;
non-primary clicks dispatch `auxclick` without left-click navigation or form actions.
The same page event handling is available through CDP/Casty. QML MouseArea and
TapHandler receive accepted non-primary buttons. Middle click does not yet paste
PRIMARY selection, and selecting text does not publish a PRIMARY clipboard.
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
browser document/window. QML `ShellRoot` can group logical objects, but multiple independent native windows
are not implemented.

支援滑鼠移動、左／右／中鍵、雙擊及雙軸捲動。右鍵送出 contextmenu，非左鍵送出
auxclick，不執行左鍵導航或表單動作；CDP／Casty 也共用這些事件。QML MouseArea
與 TapHandler 可收到允許的非左鍵按鈕。選取文字尚不發布 PRIMARY，中鍵也不會
自動貼上 PRIMARY。尚非完整 XKB/IME；按鍵沿用 controller 的成對
按下／放開，不支援獨立長按。啟動器目前只有單一文件／視窗。

## Compatibility targets / 相容性目標

The official Flea binary can launch the experimental QML wrapper; directory
navigation, previews and selected file operations have been exercised. Omastorm
has a software ShaderEffect experiment and a reproducible container recipe.
See [QML setup and limitations](../../lib/qml/README.md) for required backends,
fonts, external tools and the explicit Omastorm software-path adaptation.
Neither result implies complete Qt/Quickshell compatibility: independent native
windows, tab tearoff/layer-shell and arbitrary shaders remain outside this scope.
Ordinary web pages do not acquire the local QML host's file/process permissions.

官方 Flea binary 已可啟動實驗性 QML wrapper，並測試目錄導航、預覽與部分檔案操作。
Omastorm 已有軟體 ShaderEffect 實驗及容器教學；所需後端、字型、外部工具與
Omastorm 的軟體路徑調整，見 [QML 說明](../../lib/qml/README.md)。這不代表完整
Qt／Quickshell 相容；獨立原生多視窗、分離分頁／layer-shell、任意 shader 仍有限制。
一般網頁不會因此取得本地 QML 的檔案或程序權限。

References: https://github.com/thisisgm/flea and https://github.com/wesleygrimes/omastorm

## Verification / 測試

```sh
bun test test/wayland-frontend.test.js test/double-click.test.js test/wayland-urlbar.test.js
# Optional integration with the existing sibling buninu-land checkout:
BUNINU_TEST_WAYLAND=1 bun test test/wayland-frontend.test.js test/wayland-scroll.test.js
```

The integration test creates its own compositor/socket; it does not interrupt the
user's compositor. Checks SHM presentation, pointer click, keyboard and resize.
整合測試使用獨立 socket，不影響使用者正在執行的 Land。

Protocol XML retains upstream license notices. Transport/protocol code adapted
from Buninu Land (MIT), see LICENSE-land. XML is interpreted at runtime with Bun.XML.

Manual mouse/scroll test / 手動滑鼠與捲動測試：

```sh
bun index.js --wayland file://"$PWD"/test/manual-pointer-scroll.html
# Omit --wayland to use the default Casty frontend.
```

The page includes vertical/horizontal/two-axis scroll boxes, button and double-click
counters, a drag canvas, text controls and bounded event logs. It reports received
modifiers without swapping wheel axes itself. 頁面不自行轉換滾輪方向，可從紀錄
確認外層是否真的送來水平軸與修飾鍵；預設 Casty 路徑可省略 `--wayland`。
