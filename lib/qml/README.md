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
BUNINU_OMARCHY_ROOT=/opt/omarchy-source \
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

List view and the ShaderEffectSource-dependent preview components now compile.
Headless tests exercise real text/PNG Quick Look navigation with the official
backend, plus unchanged PreviewSwap/HtmlClip pixel behavior. This does not claim
complete Columns-view coverage, file operation safety coverage, or native QS IPC.

```sh
# Same environment as above, with BUNINU_QML_WAYLAND_TEST=1 for the socket test:
bun test test/qml-flea-backend.test.js test/qml-flea-launcher.test.js
```

## Flea依賴的外部環境和工具

- **Android 第一步：在原生 Termux 開 jsgotty**：先確認 Termux 原生的 Bun 可用，不要在 Debian proot 裡執行這一步。保持這個 Termux 工作階段開著。

  ```sh
  bun --version
  bunx jsgotty -w -r --session bash
  ```

  `-w` 允許鍵盤輸入，`-r` 產生隨機網址路徑，`--session` 保留可重新連接的 shell。用手機瀏覽器／WebView 打開 jsgotty 印出的完整網址；同一手機可用 `127.0.0.1:8080`，但要保留印出的隨機路徑，不能只開首頁。這裡的 `-r` 是 server 的 random URL，不是 `--client -r PID`。

- **Android 第二步：在瀏覽器裡的終端開 Land**：進入上述 jsgotty 畫面後執行以下命令，保持它運行。使用的是宿主 Termux 的 Bun；首次執行可能下載 Land／Casty。

  ```sh
  env XDG_RUNTIME_DIR="$TMPDIR" bunx buninu-land
  ```

  Land 的顯示留在這個瀏覽器視窗。預設 socket 是 `$TMPDIR/wayland-buninu`；若已有其他 Land，名稱可能是 `wayland-buninu1` 等，請以 Land 顯示的地址為準。

- **需要聲音時：在宿主另外啟動 jspulse**：Android／Termux 使用 OpenSL ES；在另一個原生 Termux shell 執行並保持運行，不是在容器裡啟動。若已有 jspulse 服務就沿用，不必重複開。

  ```sh
  bunx @drxiaozhi/jspulse --sles
  ```

  一般 Linux 有 ALSA 裝置時，改用以下命令；這是兩種環境的替代選項，不是一起執行。

  ```sh
  bunx @drxiaozhi/jspulse --alsa
  ```

  播放前先確認音量，必要時先 **unmute**；ALSA 音效卡的播放開關、音量，以及 Flea 自己的靜音按鈕都可能影響出聲。Android 也要確認系統媒體音量。選卡、音量與解除靜音的操作詳見 jspulse 手冊：

  ```sh
  bunx @drxiaozhi/jspulse --readme
  ```

  播放器沿用 `127.0.0.1:4713`。Termux 的 js-udocker／proot 共用宿主網路，可直接連到該服務；一般 Docker 若另有網路隔離，需另安排 host 音訊服務的連線，不能假設容器的 localhost 就是宿主。沒有音訊服務仍可操作 Flea，但不能據此宣稱已驗證出聲。

- **Android 第三步：另開一個原生 Termux shell，安裝 js-udocker**：不是在 Land 網址列輸入，也不是進入 Debian 後才裝。安裝腳本名稱是專案內附的 `termux_install.sh`；它會把 `udocker` 指向該 checkout，因此之後不要搬走或刪掉 checkout。wrapper 使用 Node.js 和 proot；已有這些套件可以略過 pkg 指令。

  ```sh
  pkg install git nodejs proot curl tar
  cd "$HOME"
  git clone https://github.com/jjtseng93/js-udocker.git
  cd js-udocker
  sh termux_install.sh
  hash -r
  command -v udocker
  ```

- **Android 第四步：取得本專案作為 build context**：繼續在第二個 Termux shell 執行。已有 buninu-browser checkout 時直接進入該目錄，並確保它包含這份 Dockerfile；不要在主專案執行 bun i，jsmdcui 會由 Dockerfile 安裝到容器的獨立 helper 目錄。

  ```sh
  cd "$HOME"
  git clone https://github.com/jjtseng93/buninu-browser.git
  cd buninu-browser
  test -f test/fixtures/flea-helpers/Dockerfile
  test -S "$TMPDIR/wayland-buninu"
  ```

  接著才執行下方的 `udocker build`／`udocker run`。容器透過 `-b "$TMPDIR:/tmp"` 使用剛剛的 Land；若實際 socket 是 `wayland-buninu1`，run 時再加 `-e WAYLAND_DISPLAY=wayland-buninu1`。回到瀏覽器即可看到 Flea，不必在容器裡再啟動 Land。

- **直接建置：Dockerfile**：[test/fixtures/flea-helpers/Dockerfile](../../test/fixtures/flea-helpers/Dockerfile) 從固定的 `oven/bun:1.4.4` 開始，取得 Omarchy 官方 Flea 0.3.12-1、固定 revision 的 Omarchy QML，安裝 MIME 資料、基本 shell 工具及獨立的 `jsmdcui@0.19.2`，並複製本專案瀏覽器與所有 wrapper。**在原生 Termux 執行**，不要在既有 Debian proot 內再建置。先將完整 buninu-browser 專案設為目前目錄；`udocker` 是已安裝的 js-udocker 命令。建置會下載套件、建立新容器，不會把 node_modules 放到主專案。

  ```sh
  udocker build -t flea-qml -y -f test/fixtures/flea-helpers/Dockerfile .
  udocker run -b "$TMPDIR:/tmp" flea-qml
  ```

  Land 須已在原生端啟動，socket 為 `$TMPDIR/wayland-buninu`。映像預設開 `/root/flea-demo`，包含文字、MP3、MP4。改目錄可用 `udocker run -b "$TMPDIR:/tmp" flea-qml /usr/bin/flea --gui /root`。Dockerfile 僅使用單階段 FROM、簡單 COPY、shell RUN、每行一組 `ENV KEY=value`、WORKDIR、JSON ENTRYPOINT／CMD；不用 BuildKit、heredoc、COPY --chmod 或一行多組 ENV。這份映像明確啟用無隔離的 bwrap 實驗替代與佔位縮圖，不包含原生 Qt／Quickshell。官方套件若從鏡像移除，建置會下載失敗，不會自動改用未知版本。

  建置中的 [check.mjs](../../test/fixtures/flea-helpers/check.mjs) 檢查 Bun 版本、MIME、Omarchy 模組、jsmdcui 真實 ANSI 上色、官方 Flea 後端的 45 種格式／90 組上色請求、縮圖回覆與 QML DOM 截圖。也可手動重跑 `udocker run flea-qml bun /usr/local/lib/flea-helpers/check.mjs`；Termux 若在 base image 解壓時顯示 Perl 硬連結被拒，Dockerfile 會在第一個 RUN 補成普通檔案；其他解壓錯誤不能一概忽略。不能只以 js-udocker 最外層退出碼判定成功，應確認 `PASS:` 訊息，因目前 builder 可能繼續執行失敗 RUN 後的指令。2026-10-24 已從原生 Termux 實測 `build -t flea-qml`，上述檢查全過，並用 `udocker run -b "$TMPDIR:/tmp" flea-qml` 連到 Land，截圖確認三個範例檔案出現在視窗中。

**接下來是詳細說明**：若已依上面的 Dockerfile 建置並成功啟動 Flea，就可以直接使用，不必再執行以下安裝步驟。以下逐項解釋依賴、wrapper 與替代方案，供手動建立環境、調整功能或排查問題時參考。

- **範圍與順序**：以下以已驗證的 Flea **0.3.12-1**、Debian 13、Bun、已啟動的 Land 為基準；若選擇手動配置，依序做完「必要」與「實驗替代」項目，就能啟動檔案列表、文字上色及影音預覽。不是完整 Omarchy，也不保證垃圾桶、掛載、PDF、桌面服務都可用。所有本文使用的 wrapper 都收錄在本專案 [test/fixtures/flea-helpers](../../test/fixtures/flea-helpers/) 或 [test/fixtures/flea-thumbnail-stub](../../test/fixtures/flea-thumbnail-stub/)，不需要隔壁專案或作者的既有容器。每個 shell wrapper／stub 都不超過 10 行；`bat.mjs` 是保留實際上色功能的完整適配器，不是假成功 stub。

- **必要：Linux 執行環境與 Flea 官方 binary／QML**：使用同架構的 Debian/glibc 環境及 Linux Bun，不能把 Android Bun 當作 Debian Bun。Flea binary 所需的 ELF loader、libc、libgcc 不能用退出成功的 stub 取代。從 Omarchy 套件來源取得 `flea-0.3.12-1` 對應架構的完整套件，保留其 `usr/bin/flea`、`usr/share/flea`、`usr/lib/flea` 和符號連結，解開到容器對應路徑；不要只複製 binary。套件管理器的完整桌面依賴不是本實驗的全部必要條件。此節從上述官方套件已解開、完整 buninu-browser 專案已放在 `/opt/buninu-browser` 開始；不以缺少官方檔案時自動產生假的 QML 補洞。

- **必要：Omarchy 的 Commons／Ui QML 模組**：不能以空目錄 stub，Theme 和控制項真的會用到。若尚未有模組，可直接取得已驗證的官方版本，不引用本機隔壁 checkout。只需要其 `shell/Commons`、`shell/Ui` 及套件既有連結，不必啟動 Omarchy／Hyprland。

  ```sh
  git clone https://github.com/basecamp/omarchy.git /opt/omarchy-source
  git -C /opt/omarchy-source checkout 3c7027db2a4fa9fa6a49d7af7f87c27ac48e677d
  mkdir -p /usr/share/omarchy/shell
  cp -a /opt/omarchy-source/shell/Commons /opt/omarchy-source/shell/Ui /usr/share/omarchy/shell/
  ln -sfn shell /usr/share/omarchy/qs
  ```

- **必要：`qs` 啟動入口，替代原生 Quickshell／Qt**：先準備獨立 helper 目錄並複製本專案的檔案。下列 `qs` 是 3 行 wrapper，轉交 `/opt/buninu-browser/lib/qml/qswayland`，不用安裝原生 Quickshell、QtQuick 或 QtMultimedia。若專案放在別處，修改 wrapper 最後一行即可。僅啟用 `qs`；不要一次把所有實驗 stub 都放進 PATH。

  ```sh
  mkdir -p /usr/local/lib/flea-helpers /usr/local/bin
  cp -a /opt/buninu-browser/test/fixtures/flea-helpers/. /usr/local/lib/flea-helpers/
  chmod +x /usr/local/lib/flea-helpers/bin/*
  ln -sfn /usr/local/lib/flea-helpers/bin/qs /usr/local/bin/qs
  export PATH="/usr/local/bin:$PATH"
  ```

- **必要：Wayland socket 與可寫入的 HOME／XDG 目錄**：這是實際 IPC，不能用空檔案 stub。Termux 啟動容器時以 `-b "$TMPDIR:/tmp"` 分享宿主 tmp；容器中使用 `XDG_RUNTIME_DIR=/tmp`、`WAYLAND_DISPLAY=wayland-buninu`。原生 Linux 則填 Land 實際使用的目錄與 socket 名稱。HOME 要能寫入設定和快取；不要把宿主所有 XDG 路徑直接帶進不可見的容器。

  ```sh
  export XDG_RUNTIME_DIR=/tmp WAYLAND_DISPLAY=wayland-buninu
  export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share"
  export XDG_STATE_HOME="$HOME/.local/state" XDG_CACHE_HOME="$HOME/.cache"
  mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"
  test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"
  ```

- **必要：`shared-mime-info` 資料庫**：Flea 依 `/usr/share/mime` 的 `globs2`、aliases 和描述分類檔案；沒有它時 PNG、文字可能變成 Data，根本不啟動預覽。不能用成功退出的命令 stub。Debian 可用 `apt-get install --no-install-recommends shared-mime-info`，或把該套件的完整 `/usr/share/mime` 解到容器；不要只造一個空檔。加入後重啟 Flea。
  常見的新副檔名（例如 `.jsonl`）可能仍沒有 MIME 定義，會被 Flea 判成 Data，而不呼叫上色工具。可補本專案的 MIME 定義（包含 `Dockerfile` 檔名及 `.cjs`、`.ini`、`.tsx`），再重啟 Flea；Dockerfile 已包含這兩步。一般規則為低優先序；`.tsx` 特別以優先序 60 覆蓋 Debian 的 Tiled tileset 分類，讓 TypeScript JSX 可上色，因此同副檔名的 Tiled 檔案也會先走文字預覽：

  ```sh
  install -Dm644 test/fixtures/flea-helpers/source-mime.xml /usr/share/mime/packages/buninu-source.xml
  update-mime-database /usr/share/mime
  ```

  HTML 是另一條路徑：Flea 預設要求網頁渲染預覽，並非原始碼上色。在 Space 開啟的預覽按 `r` 切換 source 才會使用 bat/jsmdcui。原始碼上色不需要 HTML 截圖工具；rendered 模式仍需要 Flea 呼叫 `/usr/bin/qml6` 與內附的 Qt WebEngine HTML 預覽程式，這個實驗容器尚未提供。

- **實驗替代：`bat` 語法上色，透過 `bun i jsmdcui`**：Flea 要求 bat 的 realpath 位於 `/usr`，因此在獨立的 `/usr/local/lib/flea-helpers` 安裝，主專案不會新增 `node_modules`。`bat` wrapper 呼叫本專案附帶的 `bat.mjs`，它處理 Flea 的參數、stdin、行範圍與基本 ANSI 色碼，再使用 jsmdcui 真正上色。不能把 `bat` 直接連到 jsmdcui CLI，兩者參數不同。已驗證的 jsmdcui 原始版本為 0.19.2；新版本若變更內部模組，請改用 `bun i jsmdcui@0.19.2`。

  ```sh
  cd /usr/local/lib/flea-helpers
  bun i --backend=copyfile jsmdcui
  ln -sfn /usr/local/lib/flea-helpers/bin/bat /usr/local/bin/bat
  ln -sfn /usr/local/lib/flea-helpers/bin/glow /usr/local/bin/glow
  printf 'const answer = 42;\n' | bat --color=always --style=plain --paging=never --file-name=sample.js -
  ```

  `glow` 是另附的 jsmdcui `--cat` 入口，方便手動讀文件；Flea 程式碼上色呼叫的是 `bat`。`--backend=copyfile` 避免 Android／proot 的硬連結限制；一般原生 Linux 可直接 `bun i jsmdcui`。安裝位置是獨立 helper 目錄，Dockerfile 也採用同樣方式。適配器只覆蓋 Flea 使用的 bat 參數，不是完整 bat 實作。 自動載入 jsmdcui 的全部語法定義，另補常見語言別名及 JSX、MTS／CTS、JSONC／JSON5／JSONL 等副檔名。`syntax-compat.mjs` 在 adapter 內轉換語法規則的 Go regex flags／字邊界，修正 Dockerfile、batch 等規則在 JavaScript 無法編譯的問題，不修改 npm 安裝內容。

  [check-highlighting.mjs](../../test/fixtures/flea-helpers/check-highlighting.mjs) 會真正透過官方 Flea 後端，檢查每種格式以檔案路徑與 Markdown 語言名稱送入時都有非零顏色 role，並確認文字未被改寫。樣本列在 [highlight-cases.json](../../test/fixtures/flea-helpers/highlight-cases.json)：JS／MJS／CJS／JSX、TS／TSX／MTS、Python、sh／zsh／fish、JSON／JSONC／JSON5／JSONL、YAML、TOML、INI／dotenv、HTML／XML、CSS／SCSS、SQL、C／C++／C#、Go、Rust、Java、Kotlin、Ruby、PHP、Lua、Perl、PowerShell、batch、Dockerfile、Makefile、CMake、Markdown、diff、Terraform、Vue、Svelte。這是沿用 jsmdcui 的語法規則，不是各語言的完整 parser；未知語言明確退回原文。

  ```sh
  udocker run flea-qml bun /usr/local/lib/flea-helpers/check-highlighting.mjs
  ```

  [check-preview.mjs](../../test/fixtures/flea-helpers/check-preview.mjs) 另用隔離設定開啟官方 Flea 的 JS、JSONL 與 HTML source 預覽（HTML 會按 `r` 切換），確認 UI 實際上色 並截圖到容器 `/tmp/flea-js-preview.png`；已目視確認關鍵字／運算子與數字顏色。可執行 `udocker run flea-qml bun /usr/local/lib/flea-helpers/check-preview.mjs` 重現，不影響目前 Land 視窗。

- **實驗替代：`bubblewrap`／`bwrap` 與 `prlimit`**：上色、縮圖等 helper 會經過沙箱；缺少 `bwrap` 或 `prlimit` 時，有些路徑連工具都不會呼叫。一般 Linux 優先保留真正的 bubblewrap。bunproot 實驗可選用本專案的 10 行 `bwrap`，吃掉已知參數、關閉 status fd，再直接執行 helper；不捏造 PID。這會取消 namespace／檔案系統隔離，但仍保留外層 `prlimit`；不能視為安全沙箱。Debian 的 `prlimit` 由 `util-linux` 提供，不用成功 stub 偷偷取消資源限制。

  ```sh
  ln -sfn /usr/local/lib/flea-helpers/bin/bwrap /usr/local/bin/bwrap
  command -v bwrap prlimit
  ```

  [bwrap-real-filter](../../test/fixtures/flea-helpers/bin/bwrap-real-filter) 也已保存於本專案，只供重現先前「過濾參數後仍呼叫 `/usr/bin/bwrap-real`」的診斷；該路徑在 bunproot 的 fd readlink 仍失敗，**不要用它作為成功啟動步驟**。shell wrapper 本身仍需要 Debian 的 `/bin/sh`、Bash、`realpath`、`dirname`、`env` 等基本工具。

- **實驗替代：影片縮圖 `ffmpegthumbnailer`／`libffmpegthumbnailer.so.4`**：可以完全不安裝，改用本專案的 3 行 stub 和 4 行 `.thumbnailer`。它給每個註冊的影片 MIME 寫同一張不透明 1×1 PNG；沒有讀取影片，也不冒充解碼成功。官方 Flea 後端已實測回傳非空 `thumbed.file`，QML 因而不再顯示缺縮圖提示。播放仍由真正的 WASM 解碼器負責。複製後須重開 Flea；停用時刪除註冊檔，已生成的佔位縮圖仍可能留在快取。

  ```sh
  install -Dm755 /opt/buninu-browser/test/fixtures/flea-thumbnail-stub/flea-thumbnail-stub /usr/local/bin/flea-thumbnail-stub
  install -Dm644 /opt/buninu-browser/test/fixtures/flea-thumbnail-stub/flea-placeholder.thumbnailer /usr/share/thumbnailers/flea-placeholder.thumbnailer
  ```

- **可省略：FFmpeg／`ffprobe` 媒體資訊**：Flea 用 `ffprobe` 讀編碼、採樣率等；瀏覽器的 MP3／MP4 播放不呼叫它。沒有就保留未知資訊，不要編造時長、大小或編碼。最小方案是不安裝、不提供 stub；若之後需要完整資訊，再裝 `ffmpeg`。影片縮圖則是上一項的另一條路徑，單裝 ffmpeg 不等於註冊了縮圖工具。

- **播放與聲音：QtMultimedia、音訊服務、IdleInhibitor**：QtMultimedia 已由本專案 QML MediaPlayer／AudioOutput／VideoOutput 適配到原有瀏覽器播放器，不需要外部 Qt `.so`。出聲要有播放器可連到的 jspulse／PulseAudio `127.0.0.1:4713`；宿主執行 `bunx @drxiaozhi/jspulse --sles`（Android）或 `bunx @drxiaozhi/jspulse --alsa`（Linux ALSA）。假成功 stub 不會產生聲音，不要求出聲則可靜音。IdleInhibitor 只提示未實做，不阻止播放，不需要額外 stub。宿主音訊服務在容器網路下也必須可達。

- **剪貼板：Wayland、`wl-copy` 與 host 工具**：文字框的複製貼上由本專案與 Land 的 Wayland 剪貼板處理；Land 優先 xclip，再走既有平台 fallback，不需要為此安裝 Qt。Flea 的選單「Copy Path」／分享連結另外直接呼叫 `wl-copy`，不是同一接口；要用它就安裝 `wl-clipboard` 或提供真的能寫入同一剪貼板的 adapter。本專案沒有把空寫入包裝成成功的 wl-copy stub；不安裝時省略這些選單功能，不宣稱已複製。

- **可省略：`jq` JSON 美化**：它不是文字列表或播放器的啟動依賴。不裝時不要假裝回傳有效 JSON；需要完整 JSON 預覽時安裝 jq。本文的 jsmdcui 適配器負責上色，不是 jq 查詢語言替代品。

- **可省略：圖片外掛、PDF、Office 與 Markdown 圖表**：一般 PNG／JPEG 等走瀏覽器現有解碼，不需要 Qt 的 kimageformats／libheif；HEIC 等未支援格式不能靠 stub 得到真實圖片。QtQuick.Pdf／qt6-webengine 仍不能由安裝套件直接接到我們的 DOM runtime，缺少 QML 相容功能時保留未支援。LibreOffice 用於 Office 預覽，QuickJS-NG（`qjs`）用於數學／圖表 helper；不需要這些功能就不裝。不能只把 qjs 連到 bun，旗標與執行環境尚未適配。

- **可省略：垃圾桶、裝置、網路與桌面服務**：GLib/GIO、GVfs（含 AFC／MTP／gphoto2／NFS／SMB／DNSSD）、udisks2、usbmuxd、D-Bus，以及 Python／PyGObject、expect 等是相應桌面 helper 的依賴，不是本地檔案列表的前置服務。`gio trash`、掛載、卸載、解鎖不能用 `exit 0` 騙成功，否則會把未完成的操作呈現成完成；最小方案保留不可用，真的需要時安裝服務。原生 Flea 的 portal、FileManager1 與 MPRIS helper 不等於我們已提供完整 D-Bus 桌面。

- **可省略：外部開檔／終端機**：`gio open`／xdg-utils、desktop MIME 關聯、`xdg-terminal-exec` 與 Omarchy launcher 不影響 Flea 內建預覽。要讓按鈕真的開出程式，需要實際 launcher；`xdg-terminal-exec` 接收 `--dir=...`，不能直接連到不接受該旗標的命令。沒有時保留不可用；不要把「已啟動」假回覆給使用者。hicolor-icon-theme 是桌面安裝圖示的配套，不是我們的 DOM 播放依賴。

- **可省略：壓縮、轉檔與分享**：libarchive／`bsdtar`、7zip／`7z`、ImageMagick／`magick`、tailscale、dropbox-cli、zoxide 分別提供壓縮操作、圖片轉換、分享與常用目錄排序。沒有就不啟用這些功能，不用假成功 stub；涉及寫入的操作尤其不能只回傳 0。若測試環境需要一個明確失敗的命令，可複製 [unsupported](../../test/fixtures/flea-helpers/bin/unsupported) 並取所需名稱；它只有 3 行，印出未支援並回傳 1，不是完整協定替代品。

- **最後啟動與驗收**：前述必要檔案、MIME、qs、bat／jsmdcui，以及需要時的 bwrap／縮圖替代都準備好後，從同一容器 shell 啟動。`QSG_RHI_BACKEND=opengl` 僅跳過 Flea 的原生 Vulkan 探測，不代表瀏覽器開啟 GPU。這些指令沒有啟動第二個 Land。

  ```sh
  command -v bun flea qs bat prlimit
  test -r /usr/share/mime/globs2
  test -d /usr/share/omarchy/qs/Commons
  env PATH="/usr/local/bin:$PATH" QSG_RHI_BACKEND=opengl flea --gui "$HOME"
  ```

  驗收：先看一般檔案列表，用滑鼠開啟資料夾，或用上下方向鍵選取資料夾後按右方向鍵進入，找到 JS／TXT／MP4 範例檔案；程式碼應有色、影片先顯示固定色縮圖，按播放後顯示真實影片。若失敗，先區分缺少分類資料、helper 未找到、沙箱失敗、播放錯誤；不能把已知的佔位縮圖結果當成所有外部功能都支援。

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

The container now also contains a copy of the development Debian's complete
`/usr/share/mime` database (including `globs2`, aliases and type descriptions).
Flea uses it to classify filenames; without it, even `.txt` and `.png` can appear
as generic Data and never reach their preview components. Restart Flea after
copying. Media helpers and QML multimedia/PDF support remain separate requirements.

容器另已複製目前 Debian 完整的 `/usr/share/mime` 資料庫，包含 `globs2`、別名
與類型描述。缺少它時，文字與圖片也可能被歸類為 Data，無法進入對應預覽；
複製後需重開 Flea。影音工具與 QML 影音／PDF 相容仍是另外的需求。

### glow / bat compatibility experiment (2026-10-24)

The retained `flea-qswayland` container contains an unchanged copy of
`buninu/bin/glow.sh` and the entire bundled `apps/jsmdcui` at
`/usr/local/lib/buninu-glow`. `/usr/local/bin/glow` points to `bin/glow.sh`;
`bat` points to `bin/bat.sh`, which runs `bat.mjs`. The adapter accepts Flea's
bat flags, highlights stdin with jsmdcui, selects the requested line range,
and emits basic ANSI colors understood by Flea's role parser.

At the user's request, container `bin/bwrap.sh` temporarily **bypasses bwrap**:
it consumes the known sandbox options and executes the helper directly. It
closes the JSON status fd without inventing a sandbox PID. The outer Flea
`prlimit` still applies, but bwrap filesystem/namespace isolation does not.
The real-bwrap filter is retained as `bin/bwrap-real-filter.sh`; that path
currently fails on fd readlink after pivot_root under bunproot.
No new native dependency was installed.

Verified through native Termux → bunproot → Debian → official Flea 0.3.12
backend: `/root/flea-color-probe.mjs` returned `state: "styled"` with keyword,
number and comment roles 3, 1 and 4, using the actual helper subprocess.
This verifies backend highlighting, not a new visual inspection of Flea's UI.
`/root/glow-flea-probe.sh` tests the adapter directly and with Flea's flags;
`/root/flea-bwrap-probe.sh` retains the real-bwrap reproduction.

同一容器完整保留原始 glow 與 jsmdcui；`glow` 指向原始腳本，`bat` 改指向
`bin/bat.sh`，透過 `bat.mjs` 適配 Flea 的參數、stdin、行範圍和基本 ANSI 顏色。
依使用者要求，實驗用 `bin/bwrap.sh` 暫時直接執行 helper，關閉狀態 fd 而不
捏造 PID；保留外層 prlimit，但沒有 bwrap 的檔案系統與 namespace 隔離。
原本呼叫真正 bwrap 的版本保留為 `bin/bwrap-real-filter.sh`，仍卡在 bunproot
切換根目錄後的 fd readlink。未安裝新的原生依賴。

原生 Termux → bunproot → Debian → 官方 Flea 0.3.12 backend 實測回傳
`state: "styled"`，關鍵字、數字與註解角色分別為 3、1、4。這是實際執行
helper 的後端驗證，尚非本輪 Flea 畫面的視覺驗證；容器 `/root` 保留上述腳本。

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

The source inventory parses 239 QML files and compiles 231 of 235 top-level UI
components. The four remaining compile blockers are QtQuick.Pdf (PdfViewer,
PreviewPdf) and AnimatedImage (PreviewAnimation).
Dynamic loaders defer some of these until the associated feature is opened.

**Full Flea file management is not yet supported or validated.** The original
73-test run used no backend; the later official-binary tests above cover real
listing/navigation and directory updates. Without `FLEA_BIN`, the main app still
displays its own unavailable state. Copying/moving/deleting, mounts, clipboard
integration and PDF/media remain outside this result.
A compile inventory is not an end-to-end application test.

```sh
# Existing, unchanged sibling checkouts; no download or installation is performed.
bun test/manual-flea-application.js

# Optional: supply an already installed real backend.
FLEA_BIN=/absolute/path/to/flea bun test/manual-flea-application.js

# Headless application, preview, worker and compile inventory tests.
BUNINU_FLEA_ROOT=../flea BUNINU_OMARCHY_ROOT=/opt/omarchy-source \
  bun test test/qml-flea-app.test.js test/qml-flea-previews.test.js \
  test/qml-flea-compile.test.js test/qml-flea-rows.test.js test/qml-worker.test.js

# Own isolated compositor; does not affect an existing Land session.
BUNINU_FLEA_ROOT=../flea BUNINU_OMARCHY_ROOT=/opt/omarchy-source \
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
  back/forward buttons retain distinct codes. Text controls paint a blinking
  caret (500 ms per phase); Left/Right collapse a selection to its corresponding
  edge, and Shift extends it. Home/End and Ctrl+A use the same selection state.
  Selection painting, caret blinking and keyboard editing now use the common
  HTML input/textarea implementation. QML only maps its properties, methods and
  signals. Ctrl+C/X/V and copy()/cut()/paste() transfer text on demand; Wayland
  uses wl_data_device and never polls the external clipboard. Shift+Up/Down
  extends textarea selection across explicit lines; wrapped visual-line movement
  is not yet implemented.
- Rejected MouseArea presses fall through to the next painted item; the same
  recipient receives the release/click, so overlays can decline a row press.
  Replacing a ListView/GridView model resets its scroll to the origin, while
  updating the same model preserves the current position.
- TapHandler supports click/release and basic double taps; HoverHandler observes
  pointer movement without intercepting underlying controls. Point/Drag handlers
  and DropArea are partial DOM-event adapters, not Qt gesture arbitration or
  complete native drag-and-drop.
- ListModel, DelegateModel/Group and virtualized views instantiate a bounded
  visible/cache range, with pooling/reuse and synchronous forceLayout. ListView
  positions measured delegates by their individual heights (widths horizontally),
  and updates following rows when a delegate grows. Unseen rows use estimated
  extents; only visited measurements are stored. Sections, full highlight behavior
  and model role semantics remain limited. At most 500 visible delegates are
  created per view layout.
- XmlListModel supports simple element paths and attribute/element roles such as
  XBEL bookmarks; it is not an XPath implementation.
- Timer, basic numeric/property/sequence/parallel animations, Behavior and
  FrameAnimation use the page event/animation loop. Window frame signals are
  page-loop signals, not a guarantee of native Wayland presentation timing.

Local QML supports the ShaderEffectSource subset used by Flea: sourceItem,
sourceRect, textureSize, hideSource, live, scheduleUpdate and
scheduledUpdateCompleted. Its canvas holds a frozen image when live is false;
explicit updates and initial capture notify only after pixels are drawn.
Live updates coalesce DOM mutations into a single animation-frame capture;
there is no perpetual capture/poll loop when the source is unchanged. Arbitrary
canvas/video bitmap changes without DOM mutations are not yet live invalidations.
Multiple texture consumers reference-count a source; hideSource suppresses its
main-scene painting while preserving layout/input, and teardown restores it.
A referenced invisible QML source retains layout for capture. Its own opacity and
placement transform do not affect the texture root. A display:none ancestor is
still a limitation of retained-layout capture.

ShapePath.fillItem accepts ShaderEffectSource and clips its canvas to PathSvg or
PathRectangle, including per-corner radii. General Item fillItem, custom shaders,
recursive feedback, mipmaps and multisampling are not implemented. Window's
page-loop afterSynchronizing runs after pending texture captures; it is not a
native Wayland presentation timestamp.

Validation (no Land required):

```sh
bun test test/qml-textures.test.js test/qml-canvas-dom.test.js
# With BUNINU_FLEA_ROOT, BUNINU_OMARCHY_ROOT and FLEA_BIN configured above:
bun test test/qml-flea-textures.test.js test/qml-flea-preview-backend.test.js
```

These tests close their browser/backend in finally blocks. They check frozen
pixels, explicit/live updates, idle capture counts, source restoration, original
Flea hold/release and rounded masking, and actual text-to-text-to-PNG Quick Look
navigation. Preview screenshots are written to `/tmp/flea-real-preview-*.png`.

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
still governed by CSS for ordinary DOM snapshots; referenced QML texture
sources use the dedicated capture semantics described above. Captures are limited to 8192 pixels per side and 16,777,216 total pixels.
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
`lib/renderer/main.js`, `lib/renderer/canvas-2d.js`, `lib/render-tree/index.js`, and `frontends/wayland/index.js`. Delete the marked blocks and `lib/qml`, plus its
tests/fixtures, to remove QML. Ordinary `let isHtml`, `let parsed`, `parsed ??=`,
renderer acquisition callbacks and default environments remain valid without
replacement statements. The removal test does this in a temporary copy and runs
ordinary renderer/navigation/headless tests. Wayland clipboard transport lives in `frontends/wayland/clipboard.js` and is
shared by ordinary pages. The optional QML HTTP clipboard bridge starts only
when navigating to local QML. Navigation guards discard stale renderer results
for all pages; neither common feature depends on QML.

Additional isolated checks:

```sh
bun test/manual-without-qml.js
bun test/manual-casty-without-qml.js /path/printed/by/the/first/test/buninu-browser
```

The first checks ordinary editing/clipboard/Wayland tests after removing QML,
and compares the original and stripped headless screenshots byte for byte.
The second drives actual Casty through a PTY, with an isolated xclip/OSC 52
clipboard and a minimal Kitty file-transfer peer. It checks selection,
copy/cut/paste, caret movement/blinking, navigator.clipboard readText/writeText,
denied reads without user activation, and raw BGRA frame delivery. It does not
modify the system clipboard or represent a test of every navigator API.

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
QML 外部接入使用 `qml handle begin/end` 區塊，可以整段刪除，不必補回程式。
一般 Wayland 剪貼簿位於 `frontends/wayland/clipboard.js`，普通網頁也共用；
QML 專用 HTTP 橋接只在導航至本地 QML 時啟動。導航期間忽略過期 renderer 結果
的保護屬於通用功能，不依賴 QML。

執行 `bun test/manual-without-qml.js` 可建立移除 QML 的獨立副本，
測試普通網頁編輯、剪貼簿與 Wayland，並逐位元組比較原版和副本的截圖。
再將輸出的副本路徑傳給 `bun test/manual-casty-without-qml.js 路徑`，
可經真正 Casty PTY 驗證選取、複製／剪下／貼上、遊標移動與閃爍、
navigator.clipboard 讀寫、無使用者操作時拒絕讀取，以及 BGRA 檔案傳輸。
測試使用隔離的 xclip／OSC 52 剪貼簿，不影響系統內容；不表示全部 navigator API 都經過測試。

本地 `file:` QML 的專用 host renderer 現在允許 `ctx.drawImage(DOM元素, …)`，
沿用三種 drawImage 呼叫形式、縮放、裁切及 canvas 透明度／變換。
能力由內部記錄控制，普通 HTML（包含本地 HTML／host 模式）與遠端 QML 不啟用。
指定子樹由既有 painter 畫到離屏 CanvasKit surface，不包含兄弟元素與祖先裁切／透明度；
文字、內部堆疊與子 canvas 沿用原有繪製，不修改 DOM，也不經 PNG、base64 或像素回讀。
快照以來源 border box、每 CSS pixel 一個像素繪製，下一次 draw 才更新，暫存影像隨用隨釋放。
目前不接受未連接、display:none、只有 inline box 的來源、iframe 或包含目標 canvas 的子樹；
一般 DOM 快照仍遵守來源的 CSS visibility。尺寸上限為單邊 8192、總計 16,777,216 像素，
跨來源圖片與受污染 canvas 的讀取限制會傳遞。

本地 QML 已接上 Flea 使用的 ShaderEffectSource：sourceItem、sourceRect、textureSize、
hideSource、live、scheduleUpdate 與 scheduledUpdateCompleted。live:false 保留快照，
更新完成後才發出通知；live:true 將 DOM 變更合併到下一個 animation frame，來源靜止時不持續截圖。
沒有 DOM 變動的任意 canvas／video 像素更新尚未自動追蹤。
多個材質共用來源時會計數引用；hideSource 只排除主畫面繪製，保留佈局與輸入，釋放時恢復來源。
被引用的 invisible QML 來源會保留佈局供截圖，來源本身的 opacity／位置變換不套進材質根節點；
但祖先 display:none 仍有限制。ShapePath.fillItem 可使用 ShaderEffectSource，支援 PathSvg、
PathRectangle 與獨立圓角；一般 Item fillItem、自訂 shader、遞迴材質、mipmap 與多重採樣仍未實作。
afterSynchronizing 在待處理快照完成後發出，但屬頁面事件迴圈，不代表原生 Wayland 顯示時間。

不需 Land 即可測試：`bun test test/qml-textures.test.js test/qml-canvas-dom.test.js`。
設定上面的 Flea／Omarchy／官方 binary 環境變數後，可跑
`bun test test/qml-flea-textures.test.js test/qml-flea-preview-backend.test.js`。
測試涵蓋原版 PreviewSwap 舊圖保留／釋放、HtmlClip 圓角、真正文字檔與 PNG 的 Quick Look 切換，
截圖留在 `/tmp/flea-real-preview-*.png`，測完會關閉 browser／backend。
測試：`bun test test/qml-canvas-dom.test.js`。

目前原版 Flea 已能啟動真正的主視窗、Theme／Commons／Ui、設定頁、鍵盤說明、
路徑輸入、網路分享表單，以及文字、CSV、Markdown、SVG／PNG 預覽。
Markdown 用原版 worker，圖片可測縮放與還原；Wayland 實測可用 Super-W 關窗。
所有應用程式測試都使用獨立 HOME／XDG，不寫個人設定，也沒有偽造後端回覆。

已解析 239 個 QML 檔案，235 個頂層 UI 元件中 231 個能編譯；這不是完整功能覆蓋。
剩餘三個編譯阻礙為 PDF 與 AnimatedImage 相關元件。
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
列表與依賴 ShaderEffectSource 的預覽元件已能編譯，Quick Look 文字與 PNG 路徑已用官方後端驗證；
欄式檢視尚未宣稱完整覆蓋。無後端時仍是上游的 unavailable 狀態。

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

### Text input and pointer fixes / 文字輸入與指標修正

文字輸入支援每 500 ms 切換顯示的遊標；失焦、隱藏、選取文字或銷毀時停止計時。
左右鍵會把選取折疊到對應端點，Shift 延伸選取，Home/End 與 Ctrl+A 共用選取狀態。
MouseArea 拒絕按下事件時，會把該次按下、釋放及點擊傳給下層項目。
ListView/GridView 換 model 時回到起點；更新同一個 model 則保留捲動位置。
這些都是通用 QML 行為，沒有依照 Flea 名稱或檔案路徑分支。

Tests / 測試：`test/qml-input-selection.test.js`、`test/qml-dynamic.test.js`、
`test/qml-views.test.js`、`test/qml-flea-preview-backend.test.js`。

Dynamic `createObject(parent)` ownership follows the explicit parent rather than
the Loader/binding currently executing. Destroying an unrelated Loader cannot
remove a surviving row's language icon. The official-backend navigation test
repeatedly enters an empty `~` and goes back, checking every language icon.

動態 `createObject(parent)` 依明確指定的父項目管理生命週期，不歸當時執行中的
其他 Loader 或 binding 所有。清除其他 Loader 不會再連帶刪掉仍存活檔案列的圖示。
`test/qml-flea-navigation-backend.test.js` 使用官方後端反覆進入空的 `~` 再返回，
確認各個語言圖示仍有內容。示範測試的 `HOME` 是隔離目錄；「NOTHING HERE YET」
表示該目錄為空，不表示 `~` 展開失敗。

### Markdown preview layout / Markdown 預覽排版

ListView uses sparse measured sizes to place unequal-height blocks without
overlap, including later height changes, scrolling and viewport resizing.
Formatting whitespace between markup blocks does not add phantom text lines.
PlainText retains explicit trailing newlines. No Flea-specific renderer is used.

ListView 依各區塊實際高度排列，並追蹤後續高度變化；捲動與視窗改變大小時仍維持
有限範圍的虛擬列表。未見過的區塊使用估計高度，不會建立整份文件。標籤區塊間的
格式換行不再增加虛構文字行；PlainText 的明確換行則保留。這是通用 QML 修正。

Tests / 測試：`test/qml-views.test.js`、`test/qml-layout-text.test.js`、
`test/qml-flea-markdown-backend.test.js`。

Markdown pre-reading also uses `StdioCollector.data`: the collector exposes the
original bytes as an ArrayBuffer separately from decoded text, and signal
handlers run with their declaring QML object as `this`. Byte concatenation is
lazy and only occurs when `data` is read.

Markdown 預讀使用的 `StdioCollector.data` 已提供原始位元組 ArrayBuffer，與解碼後
的文字分開；讀取 `data` 時才合併位元組。訊號處理函式的 `this` 指向宣告它的
QML 物件，供 `this.text`／`this.data.byteLength` 等標準用法使用。

MarkdownText collapses paragraph soft breaks as HTML whitespace while preserving
explicit hard breaks and fenced code lines. Proportional text line height uses
the same measured font line box for CSS painting and QML geometry, including
fallback glyph metrics, so CJK code lines do not crowd into a taller item box.

MarkdownText 將段落的軟換行視為 HTML 空白，保留明確換行與程式碼區塊的逐行內容。
比例行高在 CSS 繪製與 QML 幾何計算使用相同字型行框，包含替補字型的度量，
避免中文程式碼擠在較高區塊的上方。


## Media playback / 媒體播放

Local QML supports a subset of QtMultimedia: MediaPlayer, AudioOutput and
VideoOutput reuse the browser's existing HTML media decoder, clock, seeking,
video presentation and PulseAudio output. No native Qt plugin or new decoder
is loaded. Source loading, autoPlay, play/pause/stop, millisecond position and
duration, playback/media status, looping, volume/mute, and fit/crop/stretch
video output are available. VideoOutput exposes sourceRect/contentRect.
Changing the source or destroying a player releases its output and decoders.
Audio still requires the browser's usual jspulse/PulseAudio server on
127.0.0.1:4713 for audible playback.

Quickshell.Wayland IdleInhibitor is accepted with supported=false. Enabling it
prints a warning; it neither prevents sleep nor blocks playback. Playback rate,
track selection, subtitles, camera capture, video rotation/mirroring and native
MPRIS integration are not implemented by this adapter. Flea's own external
MPRIS helper remains subject to its ordinary host prerequisites.

The only renderer integration is in removable qml handle blocks: a capability
adapter to existing media operations and optional gain on the already converted
PCM output chunk. Video is not re-encoded or captured into an additional canvas.
See Qt's [MediaPlayer](https://doc.qt.io/qt-6/qml-qtmultimedia-mediaplayer.html)
and [VideoOutput](https://doc.qt.io/qt-6/qml-qtmultimedia-videooutput.html) APIs.

本地 QML 的 MediaPlayer、AudioOutput、VideoOutput 沿用瀏覽器現有的
HTML 媒體解碼器、時鐘、跳轉、影片繪製與 PulseAudio 輸出，不新增 Qt plugin
或另一套解碼器。支援來源載入、自動播放、播放／暫停／停止、以毫秒表示的位置與長度、
播放狀態、循環、音量／靜音，以及影片等比例縮放、裁切與拉伸。
VideoOutput 提供 sourceRect／contentRect；換來源或銷毀播放器時會釋放輸出與解碼器。
實際發聲仍需瀏覽器原本使用的 127.0.0.1:4713 jspulse／PulseAudio 服務。

IdleInhibitor 可載入但 supported=false；啟用時只提示，不會阻止休眠，也不阻止播放。
播放速度、音軌選擇、字幕、攝影機、影片旋轉／鏡像及原生 MPRIS 整合尚未實作；
Flea 自己的外部 MPRIS helper 仍需其原本的主機條件。
Renderer 接入仍全部位於可移除的 qml handle 區塊；影片不重編碼、不另建 Canvas，
音量僅處理既有 PCM 輸出區塊。

Validation: bun test test/qml-media.test.js checks real MP4/MP3 metadata and
seeking, paused video pixels, real decoded MP3 PCM through an in-memory audio
device, mute and output closure. With BUNINU_FLEA_ROOT and BUNINU_OMARCHY_ROOT,
test/qml-flea-media.test.js also loads Flea's unchanged PreviewMedia.qml.
測試包含真實 MP4／MP3、跳轉、影片截圖與記憶體音訊端的 PCM、靜音、關閉；
設定 Flea／Omarchy 來源路徑後，也測試未修改的 PreviewMedia.qml。

### Optional placeholder video thumbnails

The isolated Flea experiment can use `test/fixtures/flea-thumbnail-stub/`:
copy `flea-thumbnail-stub` to `/usr/local/bin/` (executable) and
`flea-placeholder.thumbnailer` to `/usr/share/thumbnailers/`, then restart Flea.
The 3-line shell stub writes the same opaque 1×1 PNG for every registered video
format; it does not decode the video or provide metadata. The registration file
is 4 lines. Flea 0.3.12's actual backend accepted it and published a stamped cache
PNG (`thumbed.file` nonempty), using the existing experimental bwrap bypass.
This avoids the missing-thumbnail message without changing Flea's QML.
Remove the registration to disable it; already generated placeholder thumbnails
remain in Flea's thumbnail cache until invalidated or removed.

隔離 Flea 實驗可使用 `test/fixtures/flea-thumbnail-stub/`：將可執行的
`flea-thumbnail-stub` 放入 `/usr/local/bin/`，註冊檔放入
`/usr/share/thumbnailers/`，再重開 Flea。shell stub 只有 3 行，註冊檔
4 行；所有註冊的影片都使用同一張不透明 1×1 PNG，不解碼影片也不提供
媒體資訊。官方 0.3.12 後端已實測接受並寫入縮圖快取，沿用實驗容器的
bwrap 繞過路徑，無須修改 Flea QML。刪除註冊檔可停用，但既有佔位縮圖
仍保留在快取，直到失效或被移除。

## Omastorm compatibility experiments

The first compatibility stage provides local `Quickshell.Io.Socket` with Unix
socket connections, UTF-8 `SplitParser` messages, writes, disconnect/reconnect,
and document-owned cleanup. `connected` reads the actual connection state;
assigning it requests a connection/disconnection. Writes are queued immediately;
`flush()` is accepted without adding a second buffer. This does not expose host
sockets to ordinary HTML or remote QML.

QML `Canvas` reuses the browser's HTML canvas and 2D context. The adapter supplies
paint scheduling, dimensions, QML color conversion, reset, and cancellation when
disposed. It currently supports `requestPaint`, `markDirty` (full repaint),
`contextType: "2d"`, and animation callbacks. QML image-loading extensions,
canvas tiling, alternate render strategies, and custom `ShaderEffect` are not
implemented. `QtQuick.Window` imports resolve existing Window attached behavior;
this does not implement every type from that module.

To probe an existing official Omastorm engine using the unmodified `Engine.qml`:

```sh
env XDG_RUNTIME_DIR=/tmp bun test/manual-omastorm-engine.mjs /path/to/omastorm
```

The probe does not download or start the engine. This stage has received the
real engine's site list and polar-frame state, and rendered `RadarMark.qml`.
The complete shell now resolves past `Shortcut` and `Instantiator` and stops at
`ShaderEffect`; it is not yet a usable radar app.

### Omastorm 相容性實驗

第一階段加入本地 `Quickshell.Io.Socket`：Unix socket 連線、UTF-8
`SplitParser` 訊息、寫入、斷線重連，以及頁面關閉時清理。`connected` 讀取實際
連線狀態，賦值則要求連線／斷線；寫入立即排入傳輸，`flush()` 不另建緩衝。
一般 HTML 與遠端 QML 不會因此取得 host socket 能力。

QML `Canvas` 重用瀏覽器的 HTML canvas／2D context，只轉接重繪排程、尺寸、
QML 顏色、reset 與銷毀清理。目前支援 `requestPaint`、`markDirty`（整張重繪）、
`contextType: "2d"` 與動畫回呼；QML 圖片載入擴充、畫布分塊、其他渲染策略與
自訂 `ShaderEffect` 尚未支援。`QtQuick.Window` import 可使用既有 Window
附加行為，不代表該模組所有類型皆已實作。

上方命令可使用未修改的 `Engine.qml` 連到已啟動的官方後端，不會下載或啟動後端。
已實測收到站點清單與 polar frame 狀態，並渲染原版 `RadarMark.qml`；完整 shell
已越過 `Shortcut`、`Instantiator`，目前停在 `ShaderEffect`，還不能當作可用的雷達應用。

### Keyboard shortcuts and object delegates

`Shortcut` supports string `sequence`/`sequences`, portable key names,
Ctrl/Alt/Shift/Meta modifiers, up to four key strokes (one-second prefix timeout),
enabled/autoRepeat, and activated/activatedAmbiguously signals. It consumes
matching DOM keydown events before ordinary key handlers. Window scope uses the
existing QML window/focus state; ApplicationShortcut applies across the document's
windows. Native text currently uses portable text. Numeric StandardKey bindings,
platform-localized key names and Keys.shortcutOverride are not implemented.

`Instantiator` reuses Repeater's scoped factories for synchronous array/count
models. Objects are parented to the Instantiator; active, count, object/objectAt,
objectAdded/objectRemoved, model replacement and disposal are supported. Dynamic
delegate replacement and richer model adapters remain unsupported; asynchronous
creation is rejected explicitly. As with Repeater, a model replacement currently
recreates all delegates rather than preserving identities by row diff.

### 快捷鍵與物件委派

`Shortcut` 支援字串 sequence／sequences、可攜式鍵名、Ctrl／Alt／Shift／Meta、
最多四段按鍵（前綴等待一秒）、enabled／autoRepeat，以及 activated／
activatedAmbiguously。透過 DOM keydown 攔截匹配按鍵，視窗範圍沿用既有 QML 焦點
狀態。nativeText 暫用 portableText；數字 StandardKey、平台翻譯鍵名與
Keys.shortcutOverride 尚未支援。

`Instantiator` 重用 Repeater 的作用域工廠，同步建立陣列／數量模型的物件。
支援正確父物件、active、count、object／objectAt、增加／移除訊號、模型替換與
銷毀清理。動態 delegate 替換及其他模型轉接尚未支援，非同步建立會明確報錯。
目前模型替換會重建所有委派，尚未以逐列差異保留物件身分。

`PathMultiline` now emits independent SVG subpaths; the existing canvas ShapePath
fallback also accepts the same geometry. `GridLayout` supports sequential
row-major placement with columns/rows, spacing, preferred/minimum sizes,
fill/alignment and implicit dimensions. Explicit cell coordinates, spans,
right-to-left flow and uniform-cell options are not implemented. Nested layouts
retain intrinsic preferred dimensions instead of feeding allocated widths back
into the parent. The original Omastorm KeysSheet has been screenshot-checked with
both columns visible; this does not validate the shader-dependent radar window.

`PathMultiline` 已接到 SVG 子路徑，既有 canvas ShapePath 路徑也接受同一份幾何。
`GridLayout` 支援逐列排列、欄列數、間距、偏好／最小尺寸、填滿／對齊與自然尺寸；
指定格位、跨格、由右至左及等寬格選項尚未支援。巢狀 Layout 不再把父層分配的
寬度反灌成自然寬度。已截圖確認原版 KeysSheet 雙欄正常，但不代表雷達視窗已可用。
