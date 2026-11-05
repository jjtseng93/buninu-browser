# Recorded WPT baseline and targeted retests

The official-server **testharness run is complete**: all 39,877 cases were attempted.
This does not mean all WPT test types were run or that every case completed successfully.

- Finished (UTC): `2026-11-05T03:24:33.913Z` (2026-11-05 11:24:33 Asia/Taipei).
- WPT revision: `f6789b0b5c0034ab9a7c87c9f651bf135719015d`.
- Frozen browser revision: `d11f21bfb2a58b0fedd4207d6de1f652dd9d5791`.
- Native Termux / Android arm64, Bun 1.4.4 canary `da867c60bf0bcbf9d6d36994f8ca0efa42075115`.
- Official wptserve with our browser adapter; four workers, no directory sampling.
- Resumed saved results without repeating completed cases; frozen baseline unchanged.
- Normal case budget: 20 seconds; long cases: 75 seconds, plus runner watchdog.

## Actual coverage

| Outcome | Cases |
| --- | ---: |
| Fully passing | 3,970 |
| Assertion failures | 21,392 |
| Harness errors | 11,449 |
| Incomplete / deadline / process failure | 1,609 |
| Unsupported infrastructure | 1,457 |
| Total saved cases | 39,877 |
| Remaining testharness cases | 0 |

- **Tested-case pass rate: 3,970 / 38,420 = 10.33%.** Excludes unsupported infrastructure; includes failures, harness errors and incomplete cases.
- **Whole-manifest verified lower bound: 3,970 / 131,953 = 3.00865%.** Includes all test types in the denominator. Untested types remain unknown, not failed.
- Including unsupported infrastructure in the attempted-case denominator: **3,970 / 39,877 = 9.96%**.
- Reported subtests: **216,708 passed / 1,215,617 reported** (17.83%). Includes reports from incomplete/unsupported cases; unreported assertions remain unknown.

All 39,877 JSONL records parse, case keys are unique, and outcome totals match progress.json.
Harness errors/timeouts may reflect engine gaps, infrastructure or resource limits.
These numbers are not a website usability score.

## Approximate result after patches 001–025

**Estimated tested-case pass rate: 4,005 / 38,420 = 10.42%**
(baseline 10.33%; +0.09 percentage points).

**Estimated whole-manifest passing share: 4,005 / 131,953 = 3.03517%**
(baseline 3.00865%).

Method: deduplicate 47 targeted artifacts by full case URL (including query), keeping the latest saved result for each of 44 matched cases.
Use the original full-run result as the before outcome and replace only those matched outcomes.
This turns 35 nonpassing cases into fully passing cases; 0 matched cases regress from pass to nonpass.
Partially improved files remain nonpassing. No gains are extrapolated to untested or unretested cases.

This is a **mixed-results estimate**, not a full rerun of patch 025. Retests come from different cumulative patch stages and Linux ARM64 runtimes, while the baseline ran on Android.
It assumes all other cases remain unchanged and cannot rule out regressions elsewhere.
Patches 001–025 are now applied to the main checkout as 25 separate commits (`5987dd9` through `0bbeb30`). The frozen baseline and mixed-results estimate above remain unchanged; application is not a new full WPT measurement.

## Tested groups

Nonpass combines assertion failures, harness errors and incomplete cases.

| Group | Saved | Pass | Nonpass | Unsupported |
| --- | ---: | ---: | ---: | ---: |
| FileAPI | 113 | 15 | 98 | 0 |
| IndexedDB | 820 | 1 | 819 | 0 |
| WebCryptoAPI | 334 | 3 | 331 | 0 |
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
| html | 9017 | 1433 | 7255 | 329 |
| html-aam | 36 | 0 | 20 | 16 |
| html-media-capture | 2 | 0 | 2 | 0 |
| https-upgrades | 6 | 0 | 6 | 0 |
| idle-detection | 12 | 0 | 1 | 11 |
| imagebitmap-renderingcontext | 14 | 0 | 14 | 0 |
| import-maps | 59 | 14 | 45 | 0 |
| inert | 29 | 3 | 21 | 5 |
| infrastructure | 130 | 12 | 64 | 54 |
| input-device-capabilities | 1 | 0 | 1 | 0 |
| input-events | 34 | 0 | 8 | 26 |
| installedapp | 2 | 0 | 2 | 0 |
| intersection-observer | 153 | 33 | 120 | 0 |
| intervention-reporting | 2 | 1 | 1 | 0 |
| is-input-pending | 12 | 0 | 1 | 11 |
| jpegxl | 12 | 0 | 12 | 0 |
| js | 35 | 10 | 25 | 0 |
| js-self-profiling | 26 | 0 | 26 | 0 |
| keyboard-lock | 7 | 0 | 7 | 0 |
| keyboard-map | 8 | 0 | 8 | 0 |
| largest-contentful-paint | 74 | 0 | 74 | 0 |
| layout-instability | 83 | 0 | 83 | 0 |
| loading | 53 | 0 | 53 | 0 |
| long-animation-frame | 53 | 0 | 53 | 0 |
| longtask-timing | 21 | 0 | 21 | 0 |
| magnetometer | 10 | 1 | 9 | 0 |
| managed | 2 | 0 | 2 | 0 |
| mathml | 216 | 16 | 200 | 0 |
| measure-memory | 16 | 0 | 16 | 0 |
| media-capabilities | 12 | 0 | 12 | 0 |
| media-playback-quality | 1 | 0 | 1 | 0 |
| media-source | 88 | 3 | 85 | 0 |
| mediacapture-extensions | 13 | 0 | 6 | 7 |
| mediacapture-fromelement | 12 | 0 | 12 | 0 |
| mediacapture-handle | 1 | 0 | 1 | 0 |
| mediacapture-image | 23 | 0 | 22 | 1 |
| mediacapture-insertable-streams | 20 | 0 | 16 | 4 |
| mediacapture-record | 120 | 0 | 93 | 27 |
| mediacapture-region | 1 | 0 | 1 | 0 |
| mediacapture-streams | 59 | 2 | 19 | 38 |
| mediasession | 9 | 0 | 9 | 0 |
| merchant-validation | 4 | 1 | 3 | 0 |
| mimesniff | 7 | 2 | 5 | 0 |
| mixed-content | 388 | 6 | 382 | 0 |
| mst-content-hint | 4 | 0 | 4 | 0 |
| nav-tracking-mitigations | 2 | 0 | 0 | 2 |
| navigation-api | 511 | 0 | 511 | 0 |
| navigation-timing | 59 | 10 | 49 | 0 |
| netinfo | 3 | 0 | 3 | 0 |
| network-error-logging | 12 | 0 | 12 | 0 |
| notifications | 28 | 0 | 14 | 14 |
| old-tests | 15 | 6 | 9 | 0 |
| orientation-event | 27 | 0 | 5 | 22 |
| orientation-sensor | 16 | 1 | 15 | 0 |
| page-lifecycle | 5 | 0 | 5 | 0 |
| page-visibility | 11 | 3 | 7 | 1 |
| paint-timing | 59 | 2 | 57 | 0 |
| payment-method-basic-card | 4 | 0 | 4 | 0 |
| payment-method-id | 1 | 0 | 1 | 0 |
| payment-method-manifest | 11 | 0 | 11 | 0 |
| payment-request | 33 | 2 | 31 | 0 |
| performance-timeline | 74 | 17 | 57 | 0 |
| periodic-background-sync | 3 | 0 | 3 | 0 |
| permissions | 18 | 2 | 10 | 6 |
| permissions-policy | 123 | 1 | 118 | 4 |
| permissions-request | 2 | 0 | 2 | 0 |
| permissions-revoke | 2 | 0 | 2 | 0 |
| picture-in-picture | 18 | 0 | 18 | 0 |
| png | 4 | 1 | 3 | 0 |
| pointerevents | 262 | 2 | 59 | 201 |
| pointerlock | 20 | 0 | 8 | 12 |
| preload | 86 | 10 | 75 | 1 |
| presentation-api | 13 | 0 | 13 | 0 |
| private-click-measurement | 1 | 0 | 1 | 0 |
| proximity | 4 | 1 | 3 | 0 |
| push-api | 18 | 1 | 9 | 8 |
| quirks | 18 | 2 | 16 | 0 |
| referrer-policy | 1482 | 104 | 1375 | 3 |
| remote-playback | 9 | 0 | 9 | 0 |
| reporting | 26 | 0 | 22 | 4 |
| requestidlecallback | 21 | 12 | 9 | 0 |
| resize-observer | 35 | 15 | 20 | 0 |
| resource-timing | 170 | 7 | 163 | 0 |
| sanitizer-api | 50 | 0 | 50 | 0 |
| savedata | 2 | 0 | 2 | 0 |
| scheduler | 118 | 2 | 116 | 0 |
| screen-capture | 15 | 1 | 14 | 0 |
| screen-details | 3 | 1 | 0 | 2 |
| screen-orientation | 15 | 0 | 14 | 1 |
| screen-wake-lock | 18 | 1 | 5 | 12 |
| scroll-animations | 224 | 0 | 224 | 0 |
| scroll-performance-timing | 1 | 0 | 1 | 0 |
| scroll-to-text-fragment | 38 | 0 | 37 | 1 |
| secure-contexts | 10 | 1 | 9 | 0 |
| secure-payment-confirmation | 20 | 0 | 2 | 18 |
| selection | 134 | 12 | 100 | 22 |
| serial | 11 | 0 | 11 | 0 |
| server-timing | 10 | 1 | 9 | 0 |
| service-workers | 331 | 0 | 331 | 0 |
| shadow-dom | 314 | 57 | 244 | 13 |
| shape-detection | 28 | 0 | 28 | 0 |
| signed-exchange | 60 | 0 | 60 | 0 |
| soft-navigation-heuristics | 96 | 0 | 96 | 0 |
| speculation-rules | 544 | 0 | 544 | 0 |
| speech-api | 18 | 1 | 17 | 0 |
| storage | 56 | 1 | 52 | 3 |
| storage-access-api | 42 | 0 | 34 | 8 |
| streams | 306 | 33 | 273 | 0 |
| subapps | 8 | 0 | 8 | 0 |
| subresource-integrity | 36 | 3 | 33 | 0 |
| svg | 787 | 12 | 772 | 3 |
| svg-aam | 7 | 0 | 3 | 4 |
| timing-entrytypes-registry | 3 | 1 | 2 | 0 |
| touch-events | 14 | 0 | 7 | 7 |
| trust-tokens | 3 | 0 | 2 | 1 |
| trusted-types | 247 | 32 | 215 | 0 |
| ua-client-hints | 4 | 0 | 4 | 0 |
| uievents | 74 | 6 | 25 | 43 |
| upgrade-insecure-requests | 197 | 50 | 147 | 0 |
| url | 77 | 20 | 57 | 0 |
| urlpattern | 30 | 0 | 30 | 0 |
| user-timing | 61 | 17 | 44 | 0 |
| vibration | 4 | 0 | 4 | 0 |
| video-rvfc | 8 | 0 | 8 | 0 |
| viewport | 1 | 0 | 1 | 0 |
| viewport-segments | 3 | 0 | 0 | 3 |
| virtual-keyboard | 3 | 0 | 3 | 0 |
| visual-viewport | 19 | 12 | 4 | 3 |
| wai-aria | 35 | 0 | 5 | 30 |
| wasm | 616 | 17 | 599 | 0 |
| web-animations | 144 | 0 | 144 | 0 |
| web-based-payment-handler | 13 | 2 | 11 | 0 |
| web-bundle | 29 | 0 | 29 | 0 |
| web-extensions | 6 | 0 | 6 | 0 |
| web-install | 5 | 0 | 5 | 0 |
| web-locks | 86 | 1 | 85 | 0 |
| web-nfc | 11 | 1 | 9 | 1 |
| web-otp | 1 | 0 | 1 | 0 |
| web-share | 15 | 2 | 13 | 0 |
| webaudio | 348 | 5 | 343 | 0 |
| webauthn | 55 | 1 | 8 | 46 |
| webcodecs | 283 | 1 | 282 | 0 |
| webdriver | 1 | 0 | 1 | 0 |
| webgl | 22 | 1 | 21 | 0 |
| webhid | 6 | 1 | 5 | 0 |
| webidl | 63 | 10 | 53 | 0 |
| webmcp | 75 | 1 | 74 | 0 |
| webmessaging | 161 | 55 | 106 | 0 |
| webmidi | 1 | 0 | 0 | 1 |
| webnn | 607 | 1 | 606 | 0 |
| webrtc | 265 | 1 | 263 | 1 |
| webrtc-encoded-transform | 41 | 0 | 34 | 7 |
| webrtc-extensions | 11 | 0 | 11 | 0 |
| webrtc-ice | 1 | 0 | 1 | 0 |
| webrtc-identity | 4 | 0 | 4 | 0 |
| webrtc-priority | 2 | 0 | 2 | 0 |
| webrtc-stats | 10 | 1 | 9 | 0 |
| webrtc-svc | 5 | 0 | 5 | 0 |
| websockets | 799 | 119 | 678 | 2 |
| webstorage | 54 | 16 | 38 | 0 |
| webtransport | 138 | 0 | 138 | 0 |
| webusb | 49 | 1 | 48 | 0 |
| webvtt | 75 | 0 | 75 | 0 |
| webxr | 179 | 1 | 178 | 0 |
| window-management | 5 | 0 | 5 | 0 |
| workers | 336 | 68 | 268 | 0 |
| worklets | 22 | 0 | 22 | 0 |
| x-frame-options | 6 | 1 | 5 | 0 |
| xhr | 440 | 96 | 344 | 0 |
| xml | 14 | 3 | 11 | 0 |

## Independent fixes: targeted results only

Patches 001–025 live in `../wpt-run/patches`, developed in `../buninu-browser-wpt-fixes`.
The table shows the latest saved targeted result per case, not a uniform patch-025 rerun. Before counts always come from the final native baseline.

| Artifact | Baseline passed/reported | After passed/reported | After outcome |
| --- | ---: | ---: | --- |
| `justify-self-after.json` | 0/22 (fail) | 6/22 | fail |
| `color-after.json` | 2/16 (fail) | 16/16 | pass |
| `supports-l3-after.json` | 6/17 (fail) | 17/17 | pass |
| `z-index-invalid-024-after.json` | 0/4 (fail) | 4/4 | pass |
| `z-index-valid-024-after.json` | 4/4 (pass) | 4/4 | pass |
| `decoration-after.json` | 0/3 (fail) | 3/3 | pass |
| `direction-after.json` | 0/2 (fail) | 2/2 | pass |
| `check-visibility-after.json` | 9/21 (fail) | 12/21 | fail |
| `css-namespace-025-after.json` | 0/4 (fail) | 4/4 | pass |
| `CSSGroupingRule-insertRule-computed-after.json` | 0/1 (fail) | 1/1 | pass |
| `css-indexed-after.json` | 5/6 (fail) | 6/6 | pass |
| `css-iterator-after.json` | 0/1 (fail) | 1/1 | pass |
| `CSSStyleSheet-constructable-cssRules-after.json` | 0/1 (fail) | 1/1 | pass |
| `CSSStyleSheet-constructable-invalidation-after.json` | 0/3 (fail) | 1/3 | fail |
| `CSSStyleSheet-constructable-replace-cssRules-after.json` | 0/2 (fail) | 2/2 | pass |
| `CSSStyleSheet-constructable-replace-on-regular-sheet-after.json` | 0/3 (fail) | 0/3 | fail |
| `CSSStyleSheet-insertRule-computed-after.json` | 0/1 (fail) | 1/1 | pass |
| `StyleSheetList-constructable-after.json` | 0/1 (fail) | 1/1 | pass |
| `adoptedstylesheets-observablearray-removal-after.json` | 0/12 (fail) | 6/12 | fail |
| `computed-readonly-020-after.json` | 3/4 (fail) | 4/4 | pass |
| `computed-set-020-after.json` | 0/5 (fail) | 4/5 | fail |
| `style-decl-block-024-after.json` | 3/7 (fail) | 6/7 | fail |
| `style-attribute-023-after.json` | 0/1 (fail) | 1/1 | pass |
| `insertRule-no-index-after.json` | 0/2 (fail) | 2/2 | pass |
| `token-reactions-019-after.json` | 16/19 (fail) | 19/19 | pass |
| `token-iteration-019-after.json` | 5/6 (fail) | 6/6 | pass |
| `character-append-after.json` | 0/14 (fail) | 14/14 | pass |
| `character-delete-after.json` | 0/18 (fail) | 18/18 | pass |
| `character-insert-after.json` | 0/18 (fail) | 18/18 | pass |
| `CharacterData-remove-after.json` | 0/0 (harness-error) | 12/12 | pass |
| `character-replace-after.json` | 0/34 (fail) | 34/34 | pass |
| `character-substring-after.json` | 0/28 (fail) | 28/28 | pass |
| `ChildNode-after-after.json` | 13/45 (fail) | 45/45 | pass |
| `ChildNode-before-after.json` | 17/45 (fail) | 45/45 | pass |
| `comment-constructor-022-after.json` | 0/16 (fail) | 16/16 | pass |
| `fragment-constructor-022-after.json` | 0/2 (fail) | 2/2 | pass |
| `DocumentType-remove-after.json` | 0/4 (fail) | 4/4 | pass |
| `classlist-019-after.json` | 935/1420 (fail) | 1420/1420 | pass |
| `webkit-matches-after.json` | 5/669 (fail) | 621/669 | fail |
| `sibling-021-after.json` | 2/6 (fail) | 6/6 | pass |
| `text-constructor-022-after.json` | 0/16 (fail) | 16/16 | pass |
| `text-split-after.json` | 0/6 (fail) | 6/6 | pass |
| `text-whole-after.json` | 0/1 (fail) | 1/1 | pass |
| `unscopables-025-after.json` | 0/6 (fail) | 6/6 | pass |

Remaining areas include DOM collections/Attr, Range boundaries, CSS URL resolution, numeric parsing, layout, form validation, error-realm compatibility, networking and software audio.
Multi-tab and window.open remain excluded from patch work. Selected passing tests do not establish complete API conformance.

## Evidence and reproduction

[BASELINE.json](BASELINE.json) stores the final counts, signatures, result SHA-256, groups, limitations, targeted artifact hashes and estimate details. Large artifacts remain outside the package:

- `../wpt-run/native-all/results.jsonl`: frozen baseline results.
- `../wpt-run/native-all/manifest.json`: inventory and signature.
- `../wpt-run/native-all/progress.json`: final completion record.
- `../wpt-run/MANIFEST.json`: official manifest.
- `../wpt-run/*-after.json`: targeted patched retests.
- `../wpt-run/patches/README.md`: patch scope, validation and known limitations.

See [README.md](README.md) for commands. A patched full rerun must use a separate output directory; do not overwrite the baseline.

## Mainline targeted estimate through `093b1cf`

The frozen baseline and patches 001–025 estimate above remain unchanged. The combined ledger now covers **359 distinct frozen case URLs**, including query variants. Only the recorded outcomes are replaced; partially passing files do not count as complete passes.

- **Estimated tested-case pass rate: 4,228 / 38,420 = 11.00469%.**
- **Estimated whole-manifest passing share: 4,228 / 131,953 = 3.20417%.**
- Cumulative gain over the frozen baseline: **258 complete files**, or **+0.67153 percentage points** among eligible cases.
- Gain beyond patches 001–025: **223 files**. Matched pass-to-nonpass regressions against the frozen baseline: **0**.

### Uniform audit and subsequent fixes

A four-worker audit re-ran all 235 previously recorded URLs plus 14 new error-reporting and overflow cases on one clean revision, `3fbab84`. Source fingerprints before and after the run matched. The **249-case audit** finished with **213 passes, 29 failures, 5 harness errors and 2 incomplete cases**. Its controller allowed 120 seconds, but the official testharness deadlines were unchanged.

This exposed one functional regression and three pressure-test timeouts that the earlier mixed-stage ledger did not show:

- `color: currentcolor` no longer passed CSS feature queries after the stricter declaration validation. `fc825af` restores that behavior; this recovers a previously recorded pass and is not counted as a new additional pass.
- Three static NodeList length-tampering cases passed their assertions but exceeded the official 60-second deadline under four-worker load. `d8ae039` caches wrappers only for explicit static snapshots, preserving live collection and overridable length behavior. Final targeted checks finish those three cases in about 30–32 seconds. Their recovered passes are not counted twice.
- Three additional NodeList `indexOf` pressure cases now complete within the original deadline. These add three complete passes to the ledger. The cases were queued serially; brief overlap with unrelated tests means their timings are not isolated performance comparisons.

All four previously recorded regressions are covered by successful follow-up artifacts. This does not establish that all unrelated cases or every concurrency level are regression-free.

Since the previous ledger through `74c131d`, the net increase is **22 files**: nine for trusted global error reporting, four for CSS overflow, four for input/textarea length reflection, three additional NodeList pressure cases, and two previously fixed exact-URL encoding cases newly recorded during the uniform audit. The last two are additional evidence, not new implementation claims.

### Subsequent functional parts

- `9b8bc27`: table property grammar and computed values, **+6 complete files** (+0.01562 percentage points); the six formerly failing files now pass 20/20 assertions, with three existing passing files retained.
- `179e4c1`: inert XHR document responses and request reentry protection, **+8 complete files** (+0.02082 percentage points), 24/24 assertions. The separately checked upload-abort case still times out and remains a nonpass; synchronous XHR, upload events, HTML meta charset prescan and full DTD support are not claimed.
- `3d44a35`: CSS physical/logical size validation and computed/used-value range handling, **+10 complete files** (+0.02603 percentage points), 85/85 assertions versus 21/85 before. Native regressions also cover actual block/flex/grid/canvas geometry and preserve negative offsets/margins.

- `8968ad3`: track actual user edits for text length validity, **+2 complete files** (+0.00521 percentage points); `tooLong` and `tooShort` each improve from 49/63 to 63/63. `checkValidity` and `reportValidity` each improve from 88/130 to 100/130 at this stage; their remaining typed-input failures are resolved below. Native/renderer regressions cover paste, deletion, clones/resets, CRLF/UTF-16, all six text input types, canceled/reentrant `beforeinput`, and programmatic writes.
- `9e6171e`: validate physical border component counts, duplicate shorthand components and calculated width ranges, with canonical computed shorthands, **+7 complete files** (+0.01822 percentage points), 38/38 assertions versus 16/38 before. Actual geometry and paint commands pass; pending shorthand partial-overwrite/removal limitations are addressed by `b05bbf7` below.
- `112914d`: apply Web IDL argument conversion to `CSS.escape()` and document hit testing, **+2 complete files** (+0.00521 percentage points), 14/14 assertions versus 9/14 before. Regressions cover page-realm exceptions, conversion order, detached documents and author-thrown exceptions.
- `09312d0`: share strict typed-input parsing across value sanitation, range checks and decimal step validation, **+7 complete files** (+0.01822 percentage points), 422/422 assertions versus 319/422 before. This includes both `checkValidity` and `reportValidity`, now 130/130 each. Calendar/week arithmetic is UTC; tests cover midnight-wrapping time ranges and exact decimal step arithmetic. `5e744a3` separately preserves canonical numeric time serialization after the string-sanitizer fix: `input-valueasnumber.html` is 59/64 (frozen 58/64), still a nonpass at that stage; it contributes no complete-file gain until the public API work below.
- `b05bbf7`: preserve pending border shorthand sources through partial CSSOM changes and invalidate renderer caches even when serialized text stays identical, **+2 newly passing complete files** (+0.00521 percentage points), 66/67 assertions versus 61/67 before. The six checked files include two other frozen failures already fixed by earlier work but not previously in this ledger. Those add **two evidence-only passes**, so the ledger increase for this group is four; they are not attributed to this implementation. The remaining `transition-duration` assertion stays a nonpass. Read-only CSSOM, external style-attribute writes, rule mutations and actual page cache invalidation have regression coverage.

- `5fa1b73`: implement page/native `valueAsNumber` and `valueAsDate` accessors with shared UTC parsing and serialization, captured page intrinsics, cross-realm Date brand checks and correct conversion/error order, **+7 complete files** (+0.01822 percentage points), 110/110 assertions versus 65/110 before across nine files. Explicit form-control state changes now rebuild visible control content, fixing ordinary `.value` writes as well; captured pixels verify equality against typed writes. Independent realm/branding and large-timestamp probes pass. `stepUp`/`stepDown` are covered separately below.
- `7ea0506`: share easing validation/computed values with actual CSS keyframe sampling, **+9 complete files** (+0.02343 percentage points), 106/106 assertions versus 29/106 before. `steps()` jump positions and exact initial/intermediate/reverse/fill boundaries now work; four official files check real animated layout. Nested functions remain one animation list/shorthand component, and huge step counts retain valid integer serialization. Nineteen related regression tests / 383 assertions and independent review pass. Transitions, Web Animations API, `linear()` piecewise sampling and unimplemented contextual numeric resolvers are not claimed.

- `322be0d`: implement `stepUp`/`stepDown` using exact bounded decimal arithmetic, shared UTC calendar conversions and Web IDL argument handling, **+8 complete files** (+0.02082 percentage points), 79/79 assertions versus 0/74 registered before. Five additional assertions now register after earlier exceptions are removed. Snapping consumes a step, aligned bounds clamp movement, no-op calls preserve state, and successful steps use the ordinary value/repaint path without synthetic input/change events. Twenty-five regression tests / 440 assertions, independent conversion/realm probes and the nine earlier value-accessor files pass. Full range sanitation and picker UI remain separate.
- `9d92277`: expose a branded, per-page `IdleDeadline` interface and idle callback Web IDL bindings, **+3 complete files** (+0.00781 percentage points). Basic and IDL files improve from 18/35 to 35/35 assertions, and the frozen failing cross-realm file now passes 1/1. Borrowed methods retain the origin deadline clock; invalid receivers and conversion errors use the defining realm, while author exceptions retain identity. Sixteen regression tests / 125 assertions and independent review pass. The existing scheduler is unchanged; busy-task priority and frame suspension are not claimed fixed.
- `7ca05d7`: derive CSSOM client metrics from untransformed padding boxes, including inline replaced elements, active-document/root checks and BODY display/blockification cases, **+1 complete file** (+0.00260 percentage points). Eight official files improve from 3 to 4 complete passes and 11/38 to 24/38 assertions; seventeen regression tests / 106 assertions and independent review pass. Existing scroll and pointer geometry remain unchanged. Table/SVG partial improvements remain nonpasses; quirks mode and CSS zoom are not implemented by this part. A discrepant input-box assertion is not special-cased away from observed Chromium behavior.

- `019cf0d`: resolve label/control associations using exact attributes and tree order, expose label `control`/`form`, and reuse live NodeList bindings for each control's `labels`, **+5 complete files** (+0.01301 percentage points), 56/56 assertions versus 10/56 before. Explicit unmatched `for` values never fall back to descendants; duplicate IDs, hidden controls, detached trees, shadow boundaries and adoption preserve correct relationships and collection identity. Twenty-three regression tests / 217 assertions and 32 independent cross-realm/association checks pass. Native activation shares the corrected control association; native vendor `labels` snapshots, custom-element form association and activation event/focus rules remain outside this part.
- `093b1cf`: prevent early timeout wakes from reordering idle callbacks, **+1 newly fixed complete file** (+0.00260 percentage points); the multiple-callback file improves from 1/2 to 2/2 assertions and passes three consecutive runs. A removable deadline heap and one expiration timer preserve earliest-deadline/registration order, cancellation and one callback per host task, with at most two host timers. Eight official regression files pass 17/17 assertions; 22 local tests / 811 assertions and an independent 150-seed, 52,332-operation model check pass. `callback-exception.html` is also confirmed passing for the first time since its frozen harness error: this adds **one evidence-only pass**, not an implementation claim for this change. Busy-task idle priority and removed-frame lifetime remain separate.

These parts, the two earlier evidence-only additions and the newly confirmed idle exception result add **81 complete files** beyond the uniform-audit follow-up ledger through `d8ae039`. Since `9e6171e`, the ledger increases by **48 files**, comprising 45 newly fixed files and three evidence-only additions. Their exact-URL artifacts are recorded separately; this is not a new whole-suite run.

### Registration and scope limitations

Global script exceptions now reach `ErrorEvent` and `window.onerror`, allowing the ordinary testharness to report errors that could previously truncate registration silently. All passing artifacts in this ledger were checked against the frozen baseline's registered subtest names; none loses a previously registered assertion. This cannot prove completeness when both runs abort before the same subtests are registered.

The old apparent 67/67 pass in `form-validation-willValidate.html` remains excluded: execution had stopped before six tests were registered. The corrected 73/73 result is retained. XML/SVG constructor cases remain incomplete, and XHTML processing-instruction and worker cases still have harness timeouts; none is counted as a complete pass.

This remains a **mixed-results estimate**, combining the uniform 249-case audit and explicitly identified follow-ups with the Android baseline. It is not a full rerun; unretested cases are assumed unchanged, so regressions elsewhere remain possible. Retests use Linux ARM64 and a different Bun canary revision, which also affects timing. The whole-manifest percentage is an estimate, not a fresh verified full-manifest run.

`BASELINE.json` records exact URLs, artifacts, SHA-256 hashes, runtime/revision identifiers, before/after outcomes and the uniform audit's source fingerprint. Raw audit artifacts are in `/tmp/wpt-mainline-current-wicq3Q/`; follow-ups use the separate paths recorded in that ledger. Preserve those artifacts elsewhere if they must survive temporary-directory cleanup. Multi-tab and `window.open` remain outside this work.
