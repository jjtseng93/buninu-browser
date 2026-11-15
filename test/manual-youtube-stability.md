# Natural YouTube playback verification

Run this harness in native Termux, with one playback trial running at a time.
It launches the actual Casty checkout and Buninu browser, uses a synthetic
1280×800 Kitty PNG peer, and observes https://youtu.be/jf-pn0a-Twk. It does not
measure the final Android WebView presentation cost.

```sh
bun test/manual-youtube-stability.js --help
bun test/manual-youtube-stability.js --out "$TMPDIR/youtube-round01" --network-label mobile
```

The output directory must be empty and outside the browser and Casty trees.
Each invocation starts a fresh browser process. The harness does not pause,
seek, change video quality, inject startup scripts, or modify player tokens.
Its 180-second observation limit applies only to the manual trial.

Pass requires main-video `currentTime > 65`, at least 65 seconds of observed
normal progression, normal playback rate, recent decoded-frame advancement,
changing Kitty content frames, visible video bounds, and no observed player
rejection or media error. Progress is accumulated across qualifying sampled
intervals; this does not establish that every intervening frame was smooth.
Inspect `success-kitty.png` and the progression samples to confirm the intended
video is visible; full-page image changes alone cannot prove video-region motion.

`result.json` contains the final boolean `pass`. A threshold event is provisional
until cleanup and end-of-run input verification succeed. Read `samples.jsonl`,
`last-kitty.png`, and `terminal-tail.txt` for a failed trial. The harness invokes
player inspection methods, so these are observed playback trials rather than
completely passive capture.

The manifest hashes browser/Casty runtime files and assets, installed
dependencies, the harness helpers, the Kitty peer, configuration files, and
the inherited environment. Environment and configuration contents are not
printed. Keep the invoking shell's environment unchanged for a cohort; even
an unrelated environment change conservatively changes its digest. Runtime
binaries are hashed before launch and after cleanup. The small browser wrapper
reports the actual executable and Bun version, and verification fails if its
resolved path differs from the executable chosen by Casty's runtime resolver.

For ten consecutive passes, use the same complete `manifest.json` for every
round, inspect every successful capture, and reset the streak on any failed
round. Source/configuration/runtime changes require a new cohort. Do not count
profiling or other instrumented diagnostics as acceptance trials.

`--network-label mobile` or `--network-label wifi` adds a user-reported label to
the compared manifest. Its default is `unspecified`. This option does not
inspect, switch, or otherwise change the network, and does not prove its actual
type or stability. Use a short nonsensitive label. A deliberate network switch
starts a separate cohort even when source and runtime are identical.

For a separately prepared control checkout, keep the Casty checkout fixed:

```sh
bun test/manual-youtube-stability.js \
  --browser-root /absolute/path/to/control-browser \
  --casty-root /absolute/path/to/casty \
  --out "$TMPDIR/youtube-control01" --network-label mobile
```

`--file` enables Kitty file-transport support; omit it for the default inline
PNG peer. Transport changes also require a new cohort. No hardlinks are used.

The small helper regression suite does not launch media:

```sh
bun test test/manual-youtube-stability.test.js
```
