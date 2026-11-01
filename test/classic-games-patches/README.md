# Classic-Games and Hextris compatibility checks

Run these commands from the Buninu Browser repository. No npm packages or
native additions are needed. Games stay in a separate checkout, outside the
browser package:

```sh
git clone --no-hardlinks https://github.com/KoRifCan/Classic-Games.git ../Classic-Games
```

The tested upstream revision is
`83f36f3687814c1f8e7b79f581f6fc69da72ba5e`.

## Upstream game fixes

`0001-fix-game-initialization.patch` fixes five bugs in the game sources,
separately from browser compatibility. Apply it once:

```sh
git -C ../Classic-Games apply ../buninu-browser/test/classic-games-patches/0001-fix-game-initialization.patch
```

- Space Shooter registers a `mousemove` listener before assigning `canvas`.
  Move registration after canvas initialization. The original also throws
  in Chromium.
- 15-Puzzle's `findTile()` returns `{r,c}`, but callers use `row/col`.
  Return the names those callers expect; the original shuffle cannot finish.
- Minesweeper advertises right-click flagging, but its `contextmenu` handler
  only prevents the menu. Connect that handler to its existing `toggleFlag()`;
  Ctrl/Meta-click and touch flagging retain their existing paths.
- Snake uses direction objects as ordinary object keys, so all four entries
  collide as `"[object Object]"` and left turns are always rejected. Use a
  `Map` and compare against the last committed direction; rapid inputs must
  not queue a reversal into the body before the next movement tick.

- Typing Test handles P/M shortcuts on `document` even while editing its
  text field, cancelling ordinary typing. Ignore letter shortcuts in editable
  controls while preserving Escape pause/resume and shortcuts outside them.

These patches never replace browser behavior with a game-specific exception.
The hosted upstream originals will still contain their own bugs until their
maintainer fixes them.

## Run all sixteen desktop scenarios

```sh
bun test/manual-classic-games.js ../Classic-Games buninu /tmp/classic-games
# Optional reference run, if Chromium headless shell is installed:
bun test/manual-classic-games.js ../Classic-Games chromium /tmp/classic-games-chromium
```

To browse the local patched games interactively through the default Casty frontend:

```sh
bun index.js file://"$PWD/../Classic-Games/index.html"
```

The runner serves the checkout on an automatically assigned loopback port,
launches the browser, and closes its server and browser when finished. It
writes `report.json` and initial/played PNG screenshots per game. A failed
scenario, page error, or CDP exception causes a nonzero exit status. Restrict
a diagnostic run with `CLASSIC_GAMES=memory,simon` if needed.

The browser remains in its default SES/seccomp configuration. No host-JS
bypass, game physics changes, score assignment, or game-state function calls
are used. Flappy Bird's Canvas text, Snake's rendered head-eye positions, and Simon's light sequence are observed
through bounded text logging / a MutationObserver; these record output and
do not change game decisions.

| Game | Interaction verified |
|---|---|
| Tetris | Move/rotate, hard-drop score, pause/resume input |
| Snake | All four directions turn correctly; direct reversal is rejected |
| 2048 | Move/spawn tiles and undo restores the board |
| Flappy Bird | Space starts, draws the score, and a second flap remains alive |
| Space Shooter | Start/fire and movement change the canvas |
| Tic Tac Toe | Human move, AI response, new game clears marks |
| Memory | Flip a card, match a pair; hidden backs render correctly |
| Minesweeper | Set/remove a right-click flag and reveal cells |
| Pong | Start and paddle/ball updates |
| Breakout | Start, move paddle, launch ball |
| Dino Runner | Start and jump/runner animation |
| Sudoku | Start, toggle pencil notes, fill a hint |
| Connect 4 | Seven drops produce a four-disc win and update the round score |
| Typing Test | Type/advance words; P/M remain input; Escape pauses and resumes |
| Simon Says | Observe the first light, enter it, advance to round two |
| 15-Puzzle | Render fifteen tiles and slide an adjacent tile |

This is a functional compatibility check, not a completed campaign for each
game or an end-to-end Casty/Kitty FPS benchmark. Sudoku's synchronous puzzle
generation can take noticeably longer in the instrumented JS environment;
the manual runner gives observations enough time to finish.

## Hextris

```sh
env NODE_TLS_REJECT_UNAUTHORIZED=0 bun test/manual-hextris.js buninu /tmp/hextris
# Reference; the helper also forwards the opt-out to Chromium's TLS flag:
env NODE_TLS_REJECT_UNAUTHORIZED=0 bun test/manual-hextris.js chromium /tmp/hextris-chromium
```

The TLS environment variable is only needed if this site's certificate fails
validation on your system. The test checks a mouse-start, both arrow rotations,
pause/resume, and generated blocks, then saves `playing.png` and `report.json`.
Production fixes are HTML namespace-aware SVG/RCDATA parsing and preservation
of automatic semicolon insertion before member-access rewriting. No Hextris
source patch is required.

## Generic browser changes exercised

- Canvas `roundRect()` and a page-local `CanvasRenderingContext2D` prototype,
  so native feature detection and prototype extensions work.
- CPU Web Audio biquad filters and fractional AudioBuffer length conversion;
  filter tests verify both frequency response and actual filtered PCM.
- Orthographic `rotateX`/`rotateY` projection and backface hiding across
  `preserve-3d` card faces. This is not full perspective/3D CSS support.
- Fractional Grid row tracks use a definite height, including aspect-ratio
  sizing, so empty Simon quadrants get a usable painted and clickable area.
- SVG elements do not enter HTML RCDATA parsing; ASI boundaries survive
  member-access rewriting before subsequent parsing.
- Unsupported scroll-driven animation properties remain absent from feature
  detection even though ordinary CSS animation aliases now work.

## Recorded result

All sixteen desktop scenarios passed in one default-sandbox run on this
checkout, with no recorded page errors or CDP exceptions. The associated
browser regression run passed 272 tests across fourteen files; eight additional
piano mapping/input tests also passed. Screenshots and
per-game evidence from this session are in `/tmp/classic-games-final-regression/`;
that temporary directory is not a packaged artifact. Re-running the command
above recreates equivalent reports in your chosen output directory.
