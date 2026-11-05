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

## Mainline targeted estimate through `2d0a80a`

The frozen baseline and patches 001–025 estimate above remain unchanged. The combined ledger now covers **633 distinct frozen case URLs**, including query variants. Only the recorded outcomes are replaced; partially passing files do not count as complete passes.

- **Estimated tested-case pass rate: 4,456 / 38,420 = 11.59813%.**
- **Estimated whole-manifest passing share: 4,456 / 131,953 = 3.37696%.**
- Cumulative gain over the frozen baseline: **486 complete files**, or **+1.26497 percentage points** among eligible cases.
- Gain beyond patches 001–025: **451 files**. Matched pass-to-nonpass regressions against the frozen baseline: **1**, already present before the font-family part (see below).

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

- `a214392`: dispose iframe contexts synchronously when their DOM elements disconnect, **+1 complete file** (+0.00260 percentage points). The removed-frame idle callback case improves from 0/1 to 1/1; the detached-timer case retains its existing pass. Removal now stops descendant realms and their task sources before another paint, while identity guards reject stale load, paint, resize and lifecycle work after reinsertion. Thirteen DOM/renderer regressions cover queued and newly requested timers, animation frames, idle callbacks and messages, shadow/ancestor removal, adoption and nested contexts. Retaining the contents of closed native DOM documents remains a separate compatibility issue; this part preserves the existing native close behavior.
- `cc7ae40`: share input/textarea selection state between DOM APIs, keyboard input, clipboard and painting, **+10 newly fixed complete files** (+0.02603 percentage points), 792/792 assertions versus 438/751 before across eleven files. Two former harness errors now allow 41 additional assertions to register. Web IDL conversions and defining-realm exceptions, UTF-16 ranges, default/value/type changes, clone/reset, range replacement and queued trusted `select` events are covered, including the `onselect` handler. Nineteen local tests / 396 assertions and 150 independent binding/editing checks pass; 64 Chromium black-box cases inform boundary behavior. `selection-after-content-change.html` was already passing before this implementation and is newly recorded against its frozen failure, adding **one evidence-only pass**. HTML dirty-before-IndexSizeError and relevant-value clamping are retained where Chromium differs; `selectionchange` and nonselectable input editing remain outside this part.
- `d0cf40f`: use shared length-percentage parsing for elliptical radius CSSOM/cascade values and clamp computed negative math, **+3 complete files** (+0.00781 percentage points), 48/48 assertions versus 23/48 before. Radius shorthands reuse the existing per-longhand pending-substitution metadata, preserving partial writes/removals, priorities, `all`, custom properties and stylesheet changes. Thirty-eight related tests / 1,954 assertions verify geometry and actual CPU pixels; independent review compares 1,000 mixed CSSOM/stylesheet declarations. Existing logical corner mapping is retained without claiming new vertical-writing support.

- `d3415dd`: share HTML-aware option text collection with `text`, `label`, `value` and actual select labels, **+5 complete files** (+0.01301 percentage points), 86/86 assertions versus 18/86 before. Iterative traversal excludes script contents and collapses only ASCII whitespace; empty attributes remain distinct from missing ones. Page accessors preserve conversion, receiver branding and realm errors. Five focused tests / 112 assertions include CPU screenshots, option-label updates and an unselected select's empty display. Independent native and cross-realm checks pass. Selection/validity integration is covered by the next part; this does not add a popup UI.
- `67d7e92`: correct required-select placeholder validity and size reflection, **+2 complete files** (+0.00521 percentage points). The two newly passing files improve from 3/8 to 8/8 assertions; a third descendants file retains 3/4 because `moveBefore` remains absent. Selectedness walks current native child arrays, avoiding stale query caches during insertion and dead dependency accumulation. Targeted tests cover equivalent size assignments, namespaced attributes, reinserted selected options, warmed collections, real validity paint and 1,000 selection changes without metadata growth; 68 Chromium black-box probes agree. The multiple/size-one behavior follows Chromium; full listbox UI and complete option-list filtering are not claimed.
- `0a34482`: share background-size grammar through CSSOM, cascade, computed values and CPU URL-image tiling, **+3 complete files** (+0.00781 percentage points), 28/28 assertions versus 7/28 before. Typed lengths retain percentages and math until tile geometry is resolved, auto preserves image ratio, and dynamic size changes stay on the existing paint-only update path. Sixty-seven scoped tests / 632 assertions, two existing background tests and independent review pass, including actual pixels. Gradient sizing/tiling and broader existing background shorthand serialization gaps remain separate.

- `0243f1b`: correct input/textarea `value = null` conversion and textarea direct-child default/raw text, **+3 complete files** (+0.00781 percentage points), 57/57 assertions versus 52/57 on the fresh preceding revision. The frozen run was 50/57; two earlier newline fixes are not attributed again. Branded accessors convert before checking reentrant file-input state and retain existing dirty/selection/reset and file capability paths. Twenty-four regression tests / 344 assertions plus 106 independent native/realm checks pass, covering actual paint, emoji editing, CRLF paste, clipboard copy, file selection/clear and cross-realm errors. CDATA construction is covered below; input default-value namespace reflection remains separate.

- `8a1ae81`: canonicalize hexadecimal border colors with the existing CSSOM color serializer and expose resolved side/all-border shorthands, **+1 complete file** (+0.00260 percentage points), 6/6 assertions versus 0/6 before. Seventeen scoped tests / 1,229 assertions and independent review pass, including all 256 alpha-byte round trips and actual pixels. Chromium's BSD-licensed shorthand implementation and 15 black-box cases confirm that computed `border` requires equal sides but ignores reset-only `border-image`; specified shorthand serialization keeps its existing reset behavior.

- `9ee3919`: implement real CDATA nodes across DOM factories, page interfaces, XML parsing, HTML/XML serialization, text aggregation, clone/adopt, textarea defaults and actual paint, **+3 complete files** (+0.00781 percentage points). Five checked files improve from 0/18 to 10/18 assertions; two XHTML-navigation files remain failures rather than receiving a metadata-only workaround. Thirty related tests / 461 assertions, a final ownership correction rechecked with 10 tests / 123 assertions, and 37 independent probes pass. The two-line private XML serializer branch is recorded as reversible Happy DOM patch 0008. Full Range operations, general adoption lifecycle and real XHTML navigation remain separate.
- `c392a05`: preserve mixed per-side priority when serializing margin and padding, **+1 complete file** (+0.00260 percentage points), 7/7 assertions versus 4/7 before. Equal priorities reuse the existing value compression; unequal priorities retain individual declarations so CSSOM round trips cannot discard `!important`. Three regression tests / 415 assertions cover every priority combination, CSS-wide values, competing stylesheet rules and actual pixels; independent review passes.
- `c025f28`: share background shorthand/position grammar and existing pending-longhand provenance across CSSOM, cascade, computed values and CPU URL-image placement, **+3 complete files** (+0.00781 percentage points). Seven attributable files improve from 22/107 to 105/107 assertions; the separate margin pass is not credited again. Slash sizes, layer lists, axis offsets, priorities, `all`, partial overrides, escaped URLs and same-text pending-source mutations retain their meaning. Five focused tests / 138 assertions plus pending feature-query checks, actual PNG pixels, 34 independent probes and 500 cascade round trips pass. Broad checks pass 98/100, exposing the two older issues addressed below. Gradient canonicalization/tiling, conic painting, fixed/local attachment and full clip/origin/round/space painting are not claimed complete.
- `5cec3dc`: restore immutable border/inset array sharing after shorthand expansion without weakening identity or mutation-isolation tests. A 1,000-descendant probe reduces retained border-style and specified-width arrays from 1,000 of each to one of each. Four scoped tests / 40 assertions and independent review pass. This restores an existing optimization; it adds **no new WPT full pass** and makes no measured FPS claim.

- `80ae984` and follow-up `6fc59dd`: load `application/xhtml+xml` as a real active XMLDocument using the shared inert XML parser, **+6 newly fixed complete files** (+0.01562 percentage points). Eight official files pass 34/34 assertions versus 2/12 registered before; two former harness errors now register another 22 assertions. Namespace/prefix-aware classes, scripts, styles, inline handlers, qualified tag collections, ownership and live location reuse the existing renderer. Malformed input produces an inert visible error document. Independent review and the final 15 XHTML/XHR tests / 137 assertions pass. The ledger's exact-name check caught adjacent parser Text chunks truncating a generated test name; the follow-up fixes parsing without altering the harness or merging CDATA boundaries. `DocumentType-literal-xhtml.xhtml` already passed before this part but was absent from the ledger, adding **one evidence-only pass** beyond the six implementation gains. Ordinary XML previews, complete XML selectors and full DTD expansion remain separate.
- `48f3c04`: add page-local TreeWalker/NodeIterator factories and branded interfaces with Web IDL conversion/error handling, lazy filter calls, unsigned-short callback results and TreeWalker reentry protection, **+5 complete files** (+0.01301 percentage points). Four fresh failing files now pass 27/27 assertions; the NodeFilter constants file improves from frozen 1/2 to 2/2. Four existing traversal/removal files retain 19/19. Eight local tests and 40 independent binding probes pass, including author exception identity and recovery after recursive/throwing filters. Cross-realm callback error selection and foreign-node wrapper identity remain two explicit nonpasses; complete interface conformance is not claimed.
- `26b141b`: share signed percentage/math margin grammar and pending declaration provenance with actual CPU layout, **+5 complete files** (+0.01301 percentage points). Ten official files improve from 71/107 to 104/107 assertions and from four to nine complete passes. Vertical percentages use the containing inline size across collapsed blocks, flex, grid areas, positioned boxes, captions and inline content; used values and cache keys retain that basis. Five focused tests / 165 assertions include pixels and dynamic resize; 162 layout regressions / 963 assertions and 25 related tests / 1,938 assertions pass. Independent review covers 800 ordinary and 300 pending cascade round trips. Three remaining logical-computed assertions require the separate `will-change: transform` containing-block behavior, now covered by `74d8398` below. Vertical writing and complete partial-pending cssText round trips remain unclaimed.


- `477a819`: share current tree-order form ownership across native activation/submission/reset/validation, radio grouping, labels and page control accessors, **+6 complete files** (+0.01562 percentage points). Six official files improve from 0/6 and 4/15 assertions to 6/6 and 15/15. Live `HTMLFormControlsCollection` and `RadioNodeList` reuse the existing collection machinery, including SameObject identity, named results, cross-realm receiver handling and silent checked-state repaint. Forty regression tests / 335 assertions and four independent native tests / 71 assertions pass. Full form legacy named/indexed properties, form-associated custom elements and parser foster parenting remain separate.
- `9221b08`: preserve element namespace prefixes through native deep/shallow clone and import, retaining specialized form state and template clone steps. `Node-cloneNode.html` improves from 133/135 to 134/135; this commit alone adds **no complete-file gain**. Twenty-six regression tests / 295 assertions and 14 independent native probes pass. Its newly exposed prefixed HTML interface failure is resolved by the following part.
- `b161837`: reuse namespace/local-name-aware factories across page APIs and detached/XML documents, and align HTML `instanceof` checks with the same namespace/case-sensitive prototype lookup, **+1 complete file** (+0.00260 percentage points): `Node-cloneNode.html` now passes 135/135. `Document-createElement` improves 73/147 to 98/147 and `Document-createElementNS` 283/596 to 401/596, but their ordinary XML-iframe failures remain nonpasses. Unusual parser-name and SVG clone files retain 2/2 and 4/4; ordinary HTML parsing stays on its permissive parser path. Nineteen regression tests / 279 assertions and six independent native tests / 168 assertions pass.
- `74d8398`: apply shared `will-change` grammar to CPU containing-block and stacking behavior, **+5 complete files** (+0.01301 percentage points). Six official files improve from 1/6 and 29/185 assertions to 6/6 and 185/185. Fixed descendants select the correct capture ancestor, DOM stacking ownership is separate from geometry, and retained layout/painting rebuilds layer state when needed. Dynamic removal restores viewport behavior; opacity changes within an existing stacking context retain paint-only reuse. The 127-test / 2,192-assertion regression includes pixels, scroll, clipping and full-versus-retained rendering, with independent review. Ordinary inline fragmentation and full group-opacity compositing remain unclaimed.

The broader regression checks found an obsolete animation fixture expectation: a canceled global `ErrorEvent` should be delivered but not reported to the host. `edbc6a4` corrects that assertion and checks delivery separately; all four animation tests pass, with no production change or WPT gain. Two other pre-existing `computed-style.test.js` failures were reproduced with the pre-radius HEAD sources: array identity after `border:inherit`, and an obsolete expectation accepting `calc(50% -10px)` without required whitespace. `5cec3dc` restores the array-sharing optimization and passes the original identity test unchanged. `26b141b` then corrects the mixed numeric fixture: subtraction without required whitespace is invalid, infinity follows the existing finite clamp, and valid percentage margin math is retained and resolved by layout. The full computed-style test file now passes; the border identity assertion remains unchanged.

- `62dbce0`: preserve node/attribute ownership across explicit adoption, import and implicit insertion, **+4 newly fixed complete files** (+0.01041 percentage points). Six official files improve from 15/24 to 24/24 assertions; two additional files already passed the fresh before run and are recorded as earlier-fix evidence, not new gains from this commit. Native removal hooks, shadow-inclusive ownership, specialized clones and page-realm validation remain intact. Focused transfer/XHTML tests pass 12 tests / 220 assertions; independent review passes. Two unrelated broad-regression failures were reproduced on a clean pre-change archive. Template inert ownership and complete cross-realm wrapper identity remain separate work.
- `5974a4e`: share physical/logical padding grammar, pending CSSOM order and used percentage geometry, **+7 complete files** (+0.01822 percentage points). Seven official files improve from 35/88 assertions and zero complete passes to 88/88 and seven complete passes. Inline/image offsets use containing width; logical computed getters, scroll extents and caret reveal consume resolved padding. Pixel, resize, scroll and shared CSS/layout regressions pass 219 tests / 3,770 assertions with independent review. Automatic border-box form-control default sizes and vertical writing remain separate limitations.

- `513b9c9`: share physical/logical inset grammar, pending shorthand provenance and computed values with existing positioning, **+7 complete files** (+0.01822 percentage points). Eleven official files improve from 64/120 assertions and four complete passes to 120/120 and eleven complete passes. Shared CSS regressions, 600 cascade round trips, actual pixels and independent review pass. Complete positioned used-offset getters, overconstraint handling, anchor positioning and vertical writing remain separate.
- `a89f3ff`: load ordinary XML iframes as active XML documents using the existing parser, **+3 complete files** (+0.00781 percentage points), 794/794 assertions versus 530/794 before across three DOM factory files. Namespace-aware resources and bodyless input use the existing renderer; plain XML has a mutation-cached, bounded visible source presentation without adding fake author DOM. Malformed encodings/documents produce inert visible parser errors. Forty regressions / 690 assertions and independent review pass. Top-level pretty-print behavior is unchanged; XML stylesheet processing instructions, complete DTD support and source-preview selection remain separate.
- `8c0617d`: share inherited disabled state across selectors, validation, activation, focus, editing and painting, **+6 newly fixed complete files** (+0.01562 percentage points). Nine official files improve from 10/26 to 25/26 assertions and two to eight complete passes. The first direct legend exemption, nested fieldsets, option/select state, synthetic activation and post-listener disabled/type/form changes use shared helpers. Seventy-two regressions / 948 assertions and independent activation/reentry review pass. Two fieldset files already passed before this part but were not in the ledger, adding **two evidence-only passes**. The remaining official keyboard case requires unsupported `test_driver.send_keys`; it stays a nonpass while actual keyboard behavior is tested separately.
- `daf0b6e`: expose independent page/worker URLPattern interfaces backed by Bun's existing parser, **+3 complete files** (+0.00781 percentage points). Ten official URLs improve from 2/749 to 744/749 assertions and zero to three complete passes. Web IDL conversions preserve author exceptions; native errors and result objects use captured defining-realm intrinsics, with receiver branding and safe group properties. Fifteen regression tests / 163 assertions and 23 independent review checks pass. Bun's empty-regexp and nested named-capture bugs remain explicit failures; four official worker wrappers still time out and are not counted despite separate actual Worker integration coverage. No parser replacement or dependency is added.

- `a3dc299`: share CharacterData and nullable Node text reflection across native DOM and page bindings, **+3 complete files** (+0.00781 percentage points), 104/104 assertions versus 83/104 before. CharacterData `data` distinguishes null from undefined, while nullable `nodeValue`/`textContent` use empty strings for both; processing instructions are writable and Document/DocumentType return null. Captured defining-realm errors, once-only conversion and existing mutation/textarea/style hooks are preserved. Eight regression files pass 172 tests / 1,008 assertions, with 62 independent checks. The surrogate-pair file also passes 8/8 and is newly recorded as **one additional evidence-only pass**, not attributed to this implementation. MutationObserver replace-all batching remains 1/4 and contributes no full pass.
- `a90d1b7`: share namespace context and exact tree-order ID lookup across page APIs and native fragment navigation, **+2 complete files** (+0.00521 percentage points). Four official files improve from 96/109 to 107/109 assertions and one to three complete passes. Real XMLNS declarations and detached-node boundaries follow DOM rules; exact UTF-16 IDs avoid CSS selector conversion. The document index is retained, duplicate candidates use tree order, and fragments traverse ordinary descendants iteratively. Twenty-four tests / 482 assertions and 180 independent probes pass, including actual duplicate-ID hash navigation. The already-passing XHTML prefix file adds **one evidence-only pass** to this ledger. Missing `outerHTML` assignment and empty fragment-target geometry remain separate.
- `84ddc5b`: share successful form entries between page FormData and ordinary submissions, with native-backed FormData/File interfaces and trusted FormDataEvent dispatch, **+11 complete files** (+0.02863 percentage points). Seventeen official files improve from 51/81 to 80/81 assertions and five to sixteen complete passes, with identical registered names. Native body slots stay synchronized with stable File entries, preserving actual multipart bytes independently of author iterators. Event reentry guards and navigation-sequence checks prevent stale asynchronous submissions; Web IDL conversion preserves realm and author exceptions. Five new tests and 44 independent checks pass. Broader regressions have 49 passes and two existing XHR expectation failures, both reproduced on a clean pre-change archive. Bun's Blob MIME charset difference remains the one official failure; full `dir=auto`, nonzero image-submit coordinates, custom form elements and worker interface parity remain separate.

- `15305c5`: parse and replace `outerHTML` using the actual insertion context, **+6 complete files** (+0.01562 percentage points). Eight official files now pass completely versus two before, with 14 additional passing assertions. Conversion occurs before reading the current parent; detached nodes remain unchanged and document-root replacement throws. HTML/XML fragments preserve namespace context, malformed XML replacement is atomic, and scripts stay inert. Five focused tests / 91 assertions plus 161 related regressions / 884 assertions pass.
- `b2e008e`: share gap grammar and aliases across CSSOM, pending shorthands, computed values and flex/grid layout, **+20 complete files** (+0.05206 percentage points). Twenty official files improve from 33/134 to 134/134 assertions and zero to twenty complete passes. Percentage gaps use the proper definite content axis; intrinsic cyclic percentages contribute zero before resolving against the final layout size. CSS ASCII whitespace, min/max constraints, stylesheet mutation and pending-value behavior have coverage. Seven focused tests / 420 assertions, 138 final gap/layout regressions / 834 assertions and 1,600 independent cascade round trips pass. General vertical writing and complete grid layout are not claimed.
- `6e66fec`: expose native-backed page Blob/File interfaces with shared Web IDL conversions, native line endings, slicing, exact MIME slots and correct File metadata, **+7 newly fixed complete files** (+0.01822 percentage points). Nine official files improve from 305/374 to 372/374 assertions and one to eight complete passes. Native body/canvas/XHR/WebSocket results and existing clone/message boundaries retain the correct page prototypes without a second clone. Thirty-six regressions / 377 assertions and eight final native tests / 192 assertions pass, with independent review. The already-passing File endings `.any` file adds **one evidence-only pass**. Two Blob-constructor assertions still require mutable Symbol/BigInt prototypes; response MIME-record extraction and full worker parity remain separate.
- `6848f7e`: implement stable node/attribute document ordering and containment validation, **+1 newly fixed complete file** (+0.00260 percentage points). `Node-compareDocumentPosition.html` improves from 202/1444 to 1444/1444; `Node-contains.html` retains 1482/1482 and adds **one evidence-only pass**. Weak tree identities preserve disconnected antisymmetry without retaining documents; iterative ancestry and a single sibling scan avoid recursive/subtree work and quadratic sibling access. Thirty-four DOM regressions / 868 assertions and independent review pass. Existing native internal queries remain unchanged because they compare ordinary connected nodes; normalize/live Range repair and mutation hierarchy checks remain separate.

- `70aab18`: share six alignment longhand grammars and `place-*` shorthand semantics with CSSOM, computed values and existing flex/grid positioning, **+29 complete files** (+0.07548 percentage points). Twenty-nine official files improve from 190/607 to 607/607 assertions; the previously passing `justify-content-valid` file retains 18/18. Multiword values, baseline omission, priority, pending substitution and `justify-items:legacy` retain their meaning through serialization and dynamic updates. Used positions distinguish logical, flow and physical edges, reverse/RTL layout, safe/unsafe overflow, explicit normal versus auto, and auto margins. The final eight-file local suite passes 146 tests / 2,240 assertions. Independent review caught and verified pending-longhand serialization, unrelated descendant restyling and unwanted auto-margin stretching fixes. Of 180 Chromium geometry probes, 176 match and four reversed safe-overflow positions intentionally follow the newer specification's flow-start fallback; 92 additional grid/margin/RTL probes match exactly. Two hundred cascade/round-trip comparisons have only documented reference-version differences: computed flow-* aliases and last-baseline content syntax. Full baseline-sharing groups, vertical writing, flex cross-line content distribution, wrap-reverse and distributed-grid spanning-area sizing remain separate work.

`3ebeee0` also corrects two obsolete XHR lifecycle test expectations: default/text network-error responses are empty strings, while non-text `responseText` throws `InvalidStateError`. The asynchronous test now rejects assertion failures instead of hanging. Sixteen related tests / 59 assertions pass. This is test maintenance, with **no production change or WPT gain**.

These parts and thirteen evidence-only additions add **263 complete files** beyond the uniform-audit follow-up ledger through `d8ae039`. Since `9e6171e`, the ledger increases by **230 files**, comprising 217 newly fixed files and thirteen additional evidence-only passes. The latest outerHTML, gap, Blob/File, node comparison and alignment parts fix **63 complete files**, adding **+0.16398 percentage points** among eligible cases. Two additional passing files were newly recorded without attributing them to these implementations. This round therefore adds 65 ledger passes (+0.16918 percentage points). Incomplete files remain nonpasses; exact-URL artifacts are recorded separately, and this is not a new whole-suite run.

### Font-family, keyboard initialization and XHR upload follow-ups

- `c279d4d`: share font-family grammar and canonical serialization across CSSOM, CSS.supports, computed styles, font loading and canvas text, **+5 freshly fixed complete files** (+0.01301 percentage points). Five official files improve from 23/68 to 68/68 assertions. Quoted custom names remain distinct from generic families through caches and font lookup; CSS escapes, commas, shorthand family tails and literal quoted `var()` text keep their meaning. Eighty local tests / 764 assertions and two prior passing official files pass, with independent review. This adds no typefaces or FontFaceSet implementation and does not claim complete modern font shorthand support.
- `5904146`: implement the deployed `initKeyboardEvent` signature, missing keyboard members and realm-safe UI initialization, **+1 freshly fixed complete file** (+0.00260 percentage points). `Event-init-while-dispatching.html` improves from 4/5 to 5/5. Argument conversion precedes the dispatch guard; genuine Window facades are internally branded, and initialized state follows the native event across wrappers. Twenty-two focused/related tests / 114 assertions pass, with independent review. The unrelated HTMLCollection failures involving SES error-constructor identity remain separate.
- `04800ed`: snapshot XHR bodies before loadstart and deliver trusted upload progress/terminal events through the existing EventTarget and network IPC paths, **+8 freshly fixed complete files** (+0.02082 percentage points), confirmed by a final 8/8 rerun. Upload listeners require CORS preflight; pull-driven consumption, fresh retry streams and request-generation guards preserve redirect, cancellation and reentry behavior. Fifty-one local body/network/renderer tests / 466 assertions pass, with independent review. Eight additional official body/progress files pass, including **five newly recorded passes over the frozen ledger**; these have no fresh pre-change run, so their gains are not all attributed to this part. The Blob MIME file passes its four asynchronous cases but fails all four synchronous cases, which remain unsupported. A broader WebSocket test's 1006-versus-1002 close-code failure also reproduces with the exact pre-change network-service source.

The additional checks reveal one stale frozen pass: `css/css-fonts/font-shorthand-subproperties-reset.html` now registers zero tests and reports a harness error instead of its frozen 13/13. All thirteen conditional CSS.supports gates are already false in a fresh comparison against the exact pre-font HEAD source and remain false afterward. This is **not a regression introduced by the font-family change**, but the current ledger correctly removes that old passing result. The supporting source comparison is `/tmp/font-family-subproperty-regression-audit.json`; the nonpassing official artifact is recorded in BASELINE.json.

Relative to the ledger through `70aab18`, this round adds **14 freshly demonstrated fixes**, records **five additional passing outcomes without fresh-before attribution**, and removes **one stale pass**: a net **+18 complete files**, or **+0.04685 percentage points** among eligible cases. It replaces 26 exact-URL outcomes, of which 24 are newly included URLs, bringing the ledger to 602 distinct cases. Historical baseline and patch-series estimates stay unchanged. Runtime tests used the concurrent working tree; these commits exclude the independent paint-damage changes in `page-renderer.js`, `video-mask.js` and `test/fixtures/canvas-damage.js`.

### HTTP request validation, computed font weights and text mutations

- `3f857b4`: validate XHR arguments in Web IDL order, preserve active requests after invalid `open()` calls, and share HTTP method/header rules with fetch and the controller, **+6 freshly fixed complete files** (+0.01562 percentage points). Eleven official cases yield ten complete passes versus four before, with the same registered tests. Four already-passing cases newly enter this ledger as **four evidence-only passes**. Thirty-eight local tests / 197 assertions cover reentry, upload, response state and real native transport. Bun methods that would be rewritten are rejected before preflight; custom methods are preserved with capable injected transports. One header-spelling case still fails because Bun lowercases wire header names; synchronous XHR remains unsupported.
- `b06d4c0`: share numeric and relative font-weight grammar through CSSOM, cascade, descriptor ranges, DOM font selection and Canvas assignment, **+2 freshly fixed complete files** (+0.00521 percentage points). Seven official files improve from 70/147 to 142/147 assertions and two to four complete passes. Fractional weights, absolute typed calculations, inherited bolder/lighter thresholds and pending shorthand fallback use shared semantics; @font-face retains its separate range grammar. One hundred five local tests / 1,596 assertions and independent review pass. Context-dependent `rem`/`cqw` sign calculations remain failures; no new font assets or native dependencies are introduced.

- `05b950a`: replace Element/DocumentFragment `textContent` atomically while preserving native mutation hooks, transient observers and captured custom-element reactions, **+1 freshly fixed complete file** (+0.00260 percentage points). `MutationObserver-textContent.html` improves from 1/4 to 4/4 and passes again after review. Native/manual slot changes share the observer notification microtask; author-dispatched events remain synchronous. Independent Chromium comparisons caught and verified fixes for callback-time slot duplication and lost queued callbacks after adoption. Twenty-seven local tests / 487 assertions pass. Related slot-event assertions improve from 0/32 to 12/32, but that file remains a harness error from exposed assertion failures. Separate saved registration diagnostics show `slotchange.html` has 17 registered tests (4 pass, 13 time out), and `imperative-slot-api-slotchange.html` has 13 (9 pass, 2 time out, 2 not run). Earlier partial result reports containing only the 4 or 9 passes are not the full registered totals. Both files still have harness timeouts; none of these three slot files is counted as a complete pass.
- `74605de`: normalize exclusive Text descendants while preserving live Range/Selection boundaries, **+3 freshly fixed complete files** (+0.00781 percentage points). `Node-normalize.html`, `Node-normalize-2.html` and `Range-mutations-normalize.html` improve from fresh 3/4, 0/2 and 0/4 to 4/4, 2/2 and 4/4; all pass again on the final working tree with unchanged registered assertions. The frozen first-file result was 2/4 and remains the ledger's baseline comparison. Iterative traversal preserves the first nonempty Text identity, UTF-16 offsets, parent-index boundaries and existing observer/iterator/style hooks; weak registries also cover selection-created and retained cloned ranges. Fifty-one related tests / 831 assertions and 139 independent native review checks pass. This is a normalization fix, not a claim that all Range mutation operations are implemented.

Together these parts add **12 freshly demonstrated fixes** and **four evidence-only passes**, a net **+16 complete files** (+0.04164 percentage points) over the ledger through `04800ed`. They update 25 distinct URLs, 24 newly included in the ledger, and passing files retain the frozen baseline's registered assertions. These targeted results were collected in a concurrent working tree; functional commits remain separate. The partial-repaint correctness commit `c583b21` and CSSOM performance commit `0d05346` have their own regression coverage and contribute no claimed WPT gain here.

### Select indices, ordinary Range roots and relative numeric CSS

- `413dada`: expose live indexed operations on page select elements through the existing options collection, and reset selection when `multiple` is added or removed, **+3 freshly fixed complete files** (+0.00781 percentage points). Three official files improve from fresh 1/3, 6/8 and 2/3 to 3/3, 8/8 and 3/3. Wrappers retain node identity, receiver semantics and page Array iteration; removing `multiple` retains the first selected option. Sixty-four related tests / 586 assertions and independent Chromium comparisons pass. Nonconfigurable indexed descriptors retain the existing options-collection limitation; the separate `moveBefore` case still fails and is not counted as fixed.
- `0d7eb0e`: compare Range boundaries by ordinary tree root rather than `ownerDocument`, **+7 freshly fixed complete files** (+0.01822 percentage points). Seven official files improve from 21/43 to 43/43 assertions, while eight previously passing files retain 112/112. Attr, detached and ShadowRoot boundaries collapse and compare within their actual trees; cloned/extracted fragments derive their document from the current start node even after adoption. Native overrides load before normalize tracking, and page bindings preserve conversion order, error realms and author exception identity. Twenty-three local tests / 378 assertions and 54,430 independent comparison checks pass. General live-range mutations, cross-shadow Selection, contextual fragment parsing and Range geometry remain separate.
- `2d0a80a`: validate relative typed numeric math before resolving actual font/root/viewport bases in the cascade and Canvas text, **+2 freshly fixed complete files** (+0.00521 percentage points). `font-weight-sign-function.html` improves from 0/3 to 3/3 and `font-weight-valid.html` from 21/22 to 22/22. Six official files retain their exact registered tests; the other four stay nonpasses. Symbolic serialization preserves arithmetic precedence, repeated CSSOM writes and negative zero without an extra source-storage layer. Negative zero uses an arithmetic form rather than claiming byte-identical Chromium CSSOM serialization. One hundred eighteen local tests / 3,029 assertions pass; independent review checks 2,500 expressions in 12,500 contexts and verifies the signed-zero fix. Missing container-query geometry and animation timelines remain explicit limitations.

These parts add **12 freshly demonstrated complete passes**, or **+0.03123 percentage points** among eligible cases, over the ledger through `74605de`. They update 16 exact URLs, seven newly included, bringing the ledger to 633 distinct cases. Every final passing artifact retains the frozen baseline's registered assertions; the fresh before/after name multisets also match. Tests used the concurrent working tree, with separate functional commits. The frozen full-run and historical patch-series estimates remain unchanged.

### Registration and scope limitations

Global script exceptions now reach `ErrorEvent` and `window.onerror`, allowing the ordinary testharness to report errors that could previously truncate registration silently. All passing artifacts in this ledger were checked against the frozen baseline's registered subtest names; none loses a previously registered assertion. This cannot prove completeness when both runs abort before the same subtests are registered.

The old apparent 67/67 pass in `form-validation-willValidate.html` remains excluded: execution had stopped before six tests were registered. The corrected 73/73 result is retained. The three ordinary XML-iframe factory cases now fully pass through the separately recorded active-XML path, as do the earlier XHTML processing-instruction cases. Unrelated incomplete SVG and worker cases, including four URLPattern worker wrappers, remain nonpasses.

This remains a **mixed-results estimate**, combining the uniform 249-case audit and explicitly identified follow-ups with the Android baseline. It is not a full rerun; unretested cases are assumed unchanged, so regressions elsewhere remain possible. Retests use Linux ARM64 and a different Bun canary revision, which also affects timing. The whole-manifest percentage is an estimate, not a fresh verified full-manifest run.

`BASELINE.json` records exact URLs, artifacts, SHA-256 hashes, runtime/revision identifiers, before/after outcomes and the uniform audit's source fingerprint. Raw audit artifacts are in `/tmp/wpt-mainline-current-wicq3Q/`; follow-ups use the separate paths recorded in that ledger. Preserve those artifacts elsewhere if they must survive temporary-directory cleanup. Multi-tab and `window.open` remain outside this work.
