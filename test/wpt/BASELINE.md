# Recorded WPT baseline and targeted retests

The saved official-server run is **interrupted**, not complete. This record
replaces the earlier static sample; the old sample is not combined with it.

- Last saved progress (UTC): `2026-11-04T09:23:50.559Z`.
- WPT revision: `f6789b0b5c0034ab9a7c87c9f651bf135719015d`.
- Frozen browser revision: `d11f21bfb2a58b0fedd4207d6de1f652dd9d5791`.
- Native Termux / Android arm64, Bun 1.4.4 canary `da867c60bf0bcbf9d6d36994f8ca0efa42075115`.
- Official wptserve with our browser adapter; four workers, no directory sampling.
- Normal case budget: 20 seconds; long cases: 75 seconds, plus runner watchdog.

## Actual coverage

| Outcome | Cases |
| --- | ---: |
| Fully passing | 1,648 |
| Assertion failures | 9,329 |
| Harness errors | 4,074 |
| Incomplete / deadline / process failure | 851 |
| Unsupported infrastructure | 435 |
| Total saved cases | 16,337 |
| Remaining testharness cases | 23,540 |

- **Tested-case pass rate: 1,648 / 15,902 = 10.36%.** The denominator excludes
  unsupported infrastructure but includes failures, harness errors and incomplete cases.
- **Whole-manifest verified lower bound: 1,648 / 131,953 = 1.24893%.** All official
  test types remain in the denominator. Untested means unknown, not failed.
  Only 16,337 of 39,877 testharness cases have saved results.
- Reported subtests: **58,270 passed / 850,680 reported**, including reports from
  incomplete/unsupported cases. Unreported assertions are unknown. This is not
  a complete subtest pass rate or a website usability score.

Counts were recomputed from results.jsonl: all 16,337 records parse, case keys
are unique, and totals match progress.json. The partial directory-ordered run
is not a representative random sample. Harness errors/timeouts are not
necessarily engine bugs; infrastructure and resource limits also matter.

## Approximate result after patches 001–016

**Estimated tested-case pass rate: 1,669 / 15,902 = 10.50%**
(before: 10.36%, approximately +0.13 percentage points).

**Estimated whole-manifest passing share: 1,669 / 131,953 = 1.26484%**
(before: 1.24893%). This is not a prediction for untested cases.

Method: match the 27 saved targeted retests by full manifest URL, including query
variants, and replace those outcomes in the 16,337-case baseline. All 27 are
already in the baseline, so the denominator does not grow. Twenty-one formerly
nonpassing files become fully passing (20 assertion failures and one harness
error); no matched file changes from pass to nonpass. Files with additional
passing subtests but remaining failures still count as nonpassing files.

This is a **mixed-results estimate**, not a uniform rerun of the patched browser.
It assumes all other cases remain unchanged, combines retests from different
patch stages/runtimes, and cannot rule out regressions elsewhere. Fixes may also
improve other cases, but those gains are not extrapolated. The original baseline
counts below remain unchanged; machine-readable estimate details are in
`BASELINE.json` under `patchedEstimate`.

## Tested groups

Only groups with saved results are listed. Nonpass includes assertions, harness
errors and incomplete runs; unsupported infrastructure is separate.

| Group | Saved | Pass | Nonpass | Unsupported |
| --- | ---: | ---: | ---: | ---: |
| FileAPI | 113 | 15 | 98 | 0 |
| accelerometer | 12 | 1 | 11 | 0 |
| accessibility | 1 | 0 | 1 | 0 |
| accname | 21 | 0 | 21 | 0 |
| acid | 1 | 0 | 1 | 0 |
| ai | 188 | 0 | 188 | 0 |
| ambient-light | 10 | 1 | 9 | 0 |
| animation-worklet | 24 | 0 | 24 | 0 |
| apng | 1 | 0 | 1 | 0 |
| audio-output | 10 | 0 | 9 | 1 |
| audio-session | 3 | 0 | 3 | 0 |
| autoplay-policy-detection | 3 | 0 | 3 | 0 |
| background-fetch | 16 | 0 | 4 | 12 |
| background-sync | 2 | 0 | 2 | 0 |
| badging | 8 | 0 | 8 | 0 |
| battery-status | 17 | 0 | 17 | 0 |
| beacon | 17 | 6 | 11 | 0 |
| bluetooth | 155 | 1 | 154 | 0 |
| captured-mouse-events | 4 | 0 | 4 | 0 |
| clear-site-data | 15 | 1 | 14 | 0 |
| client-hints | 132 | 11 | 121 | 0 |
| clipboard-apis | 61 | 2 | 13 | 46 |
| close-watcher | 68 | 0 | 68 | 0 |
| compat | 14 | 3 | 11 | 0 |
| compression | 78 | 10 | 68 | 0 |
| compute-pressure | 45 | 0 | 45 | 0 |
| connection-allowlist | 88 | 14 | 74 | 0 |
| console | 19 | 5 | 9 | 5 |
| contacts | 1 | 0 | 1 | 0 |
| container-timing | 29 | 0 | 29 | 0 |
| content-dpr | 1 | 0 | 1 | 0 |
| content-index | 5 | 0 | 5 | 0 |
| content-security-policy | 942 | 119 | 819 | 4 |
| contenteditable | 2 | 0 | 2 | 0 |
| cookies | 89 | 15 | 55 | 19 |
| cookiestore | 76 | 0 | 76 | 0 |
| core-aam | 1 | 0 | 0 | 1 |
| cors | 27 | 4 | 23 | 0 |
| cpu-performance | 1 | 0 | 1 | 0 |
| credential-management | 16 | 1 | 15 | 0 |
| css | 8145 | 963 | 7074 | 108 |
| custom-elements | 196 | 14 | 181 | 1 |
| delegated-ink | 5 | 0 | 5 | 0 |
| density-size-correction | 2 | 0 | 2 | 0 |
| deprecation-reporting | 2 | 1 | 1 | 0 |
| device-bound-session-credentials | 32 | 1 | 31 | 0 |
| device-memory | 4 | 1 | 3 | 0 |
| device-posture | 5 | 0 | 1 | 4 |
| digital-credentials | 28 | 2 | 22 | 4 |
| direct-sockets | 4 | 0 | 4 | 0 |
| document-picture-in-picture | 22 | 1 | 21 | 0 |
| document-policy | 10 | 0 | 10 | 0 |
| dom | 803 | 186 | 599 | 18 |
| domparsing | 91 | 11 | 80 | 0 |
| domxpath | 34 | 0 | 34 | 0 |
| dpub-aam | 1 | 0 | 0 | 1 |
| ecmascript | 2 | 2 | 0 | 0 |
| editing | 709 | 50 | 592 | 67 |
| element-timing | 52 | 0 | 52 | 0 |
| encoding | 1339 | 26 | 1313 | 0 |
| encoding-detection | 75 | 0 | 75 | 0 |
| encrypted-media | 100 | 0 | 100 | 0 |
| entries-api | 4 | 0 | 4 | 0 |
| event-timing | 76 | 1 | 72 | 3 |
| eventsource | 109 | 0 | 109 | 0 |
| eyedropper | 2 | 0 | 1 | 1 |
| fedcm | 82 | 0 | 0 | 82 |
| fenced-frame | 9 | 4 | 5 | 0 |
| fetch | 944 | 74 | 864 | 6 |
| file-system-access | 10 | 0 | 10 | 0 |
| focus | 39 | 2 | 37 | 0 |
| font-access | 12 | 0 | 3 | 9 |
| forced-colors-mode | 15 | 3 | 12 | 0 |
| fs | 102 | 0 | 102 | 0 |
| fullscreen | 90 | 1 | 85 | 4 |
| gamepad | 6 | 0 | 6 | 0 |
| generic-sensor | 3 | 0 | 2 | 1 |
| geolocation | 23 | 1 | 5 | 17 |
| geolocation-sensor | 1 | 1 | 0 | 0 |
| gpc | 7 | 0 | 4 | 3 |
| graphics-aria | 1 | 0 | 0 | 1 |
| gyroscope | 10 | 1 | 9 | 0 |
| hr-time | 18 | 5 | 13 | 0 |
| hsts | 1 | 0 | 1 | 0 |
| html | 758 | 88 | 669 | 1 |
| html-aam | 36 | 0 | 20 | 16 |
| html-media-capture | 2 | 0 | 2 | 0 |

## Independent fixes: targeted results only

Patches 001–016 live in `../wpt-run/patches`, developed in
`../buninu-browser-wpt-fixes`. They have **not** been applied to production or
its frozen baseline. All sixteen sequential patches were verified against the
base commit. Retests use proot Linux arm64 Bun and the official server: these
are functional comparisons, not cross-platform performance measurements.

Below are all saved `*-after.json` artifacts, including failures. Each is the
latest saved result at that case's patch stage, **not** a full rerun under patch
016. Before counts use paired retests where present, otherwise saved native
baseline results. Setup failure with zero reports is not a set of failed
assertions. Do not add these gains to the frozen baseline percentages above.

| Artifact | Before pass/reported | After pass/reported | After outcome |
| --- | ---: | ---: | --- |
| `CSSGroupingRule-insertRule-computed-after.json` | 0/1 (fail) | 1/1 | pass |
| `CSSStyleSheet-constructable-cssRules-after.json` | 0/1 (fail) | 1/1 | pass |
| `CSSStyleSheet-constructable-invalidation-after.json` | 0/3 (fail) | 1/3 | fail |
| `CSSStyleSheet-constructable-replace-cssRules-after.json` | 0/2 (incomplete) | 2/2 | pass |
| `CSSStyleSheet-constructable-replace-on-regular-sheet-after.json` | 0/3 (fail) | 0/3 | fail |
| `CSSStyleSheet-insertRule-computed-after.json` | 0/1 (fail) | 1/1 | pass |
| `CharacterData-remove-after.json` | 0/0 (harness-error) | 12/12 | pass |
| `ChildNode-after-after.json` | 13/45 (fail) | 45/45 | pass |
| `ChildNode-before-after.json` | 17/45 (fail) | 45/45 | pass |
| `DocumentType-remove-after.json` | 0/4 (fail) | 4/4 | pass |
| `StyleSheetList-constructable-after.json` | 0/1 (fail) | 1/1 | pass |
| `adoptedstylesheets-observablearray-removal-after.json` | 0/12 (fail) | 6/12 | fail |
| `character-append-after.json` | 0/14 (fail) | 14/14 | pass |
| `character-delete-after.json` | 0/18 (fail) | 18/18 | pass |
| `character-insert-after.json` | 0/18 (fail) | 18/18 | pass |
| `character-replace-after.json` | 0/34 (fail) | 34/34 | pass |
| `character-substring-after.json` | 0/28 (fail) | 28/28 | pass |
| `check-visibility-after.json` | 9/21 (fail) | 12/21 | fail |
| `color-after.json` | 2/16 (fail) | 16/16 | pass |
| `decoration-after.json` | 0/3 (fail) | 3/3 | pass |
| `direction-after.json` | 0/2 (fail) | 2/2 | pass |
| `insertRule-no-index-after.json` | 0/2 (fail) | 2/2 | pass |
| `justify-self-after.json` | 0/22 (fail) | 6/22 | fail |
| `supports-l3-after.json` | 6/17 (fail) | 17/17 | pass |
| `text-split-after.json` | 0/6 (fail) | 6/6 | pass |
| `text-whole-after.json` | 0/1 (fail) | 1/1 | pass |
| `webkit-matches-after.json` | 5/669 (fail) | 621/669 | fail |

Remaining areas include Shadow DOM style scope, imported stylesheets, selector
parsing/matching, editing and Range boundary maintenance, and unsupported
testdriver operations. Multi-tab and window.open work is intentionally excluded.
Selected passing tests do not establish complete API conformance.

## Evidence and reproduction

[BASELINE.json](BASELINE.json) stores counts, runtime/runner signatures, result
SHA-256, groups, infrastructure limitations and targeted-result references.
Large original artifacts stay outside the package:

- `../wpt-run/native-all/results.jsonl`: per-case assertions and outcomes.
- `../wpt-run/native-all/manifest.json`: inventory and run signature.
- `../wpt-run/native-all/progress.json`: saved progress; its ETA is stale.
- `../wpt-run/MANIFEST.json`: official generated manifest.
- `../wpt-run/*-before.json`, `*-saved-baseline.json`, `*-after.json`: retests.
- `../wpt-run/patches/README.md`: fixes, validation and limitations.

See [README.md](README.md) for commands. Resume only with the frozen browser
checkout and matching signature; measure patched code in a new output directory.
Do not overwrite baseline results with independent fixes.
