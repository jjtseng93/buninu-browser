# WPT testing


## Recorded results

[BASELINE.md](BASELINE.md) documents the completed 39,877-case official-server
testharness run and separately lists targeted retests for patches 001–025.
[BASELINE.json](BASELINE.json) stores counts and provenance. The baseline rates
are **10.33% of supported attempted cases** and a **3.00865% verified lower bound
across the whole manifest**. These are frozen-base results, not a score for the
current patched browser. Replacing matching baseline outcomes with 44 distinct
saved targeted retests gives an approximate post-patch **10.42%** tested-case rate
and **3.03517%** whole-manifest passing share. This assumes other cases remain
unchanged and is not a full patched rerun. See BASELINE.md for details and caveats.
The later mainline ledger, including the uniform audit and functional follow-ups
through `6fc59dd`, estimates **11.14263%** of eligible cases and **3.24434%** of the
whole manifest (4,281 complete passes). This is also a mixed-results estimate,
not a full rerun of the latest revision. The historical patch-only estimate above
is retained separately. See BASELINE.md for exact scope and remaining failures.
The earlier static sample is no longer retained here.

## Complete testharness run with the official server

The current runner traverses **every official testharness manifest case**, with
no directory filter or sampling. It uses unmodified upstream **wptserve** and
the browser's production `createBrowser` controller. This is our browser
adapter, not an official wptrunner/WebDriver implementation.

Install upstream's Python dependencies outside this project:

```sh
python3 -m venv ../wpt-run/venv
../wpt-run/venv/bin/pip install -r ../wpt/tools/wpt/requirements.txt -r ../wpt/tools/serve/requirements.txt
../wpt-run/venv/bin/python test/wpt/serve.py ../wpt --config test/wpt/server.json
```

`python3-venv` may need installing on Debian. `serve.py` only imports upstream's
vendored modules and calls its original entry point. No production browser
code is changed, and no node_modules are installed here.

Generate the official manifest as described below, then run:

```sh
bun test/wpt/all.js --manifest=../wpt-run/MANIFEST.json --jobs=4 --output=../wpt-run/results
```

Inspect saved progress, or watch a resumed run without affecting its workers:

```sh
bun test/wpt/watch.js
bun test/wpt/watch.js ../wpt-run/results --interval=5
bun test/wpt/watch.js --once
```

The monitor defaults to `../wpt-run/native-all` relative to this repository,
refreshes every two seconds, and exits with Ctrl-C. It displays both case-level
pass rates, progress, outcome counts and an estimated remaining time. A temporary
partial write retains the last complete snapshot. Early results follow directory
order and must not be treated as a representative compatibility estimate.

The same command resumes completed cases. It rejects changed browser/WPT
revisions, runner code, runtime, manifest or budgets; use a new output directory
for a different setup. `results.jsonl` is appended once per completed case;
`progress.json` reports counts and both requested percentages. `manifest.json`
records the complete case inventory and provenance. All large outputs stay
outside the project. Stop with Ctrl-C/SIGTERM; active worker process groups are
terminated and incomplete cases are retried on resume.

For disjoint shards across machines/environments, use `--shard=0/2` and
`--shard=1/2` with different output directories. Serve the same WPT checkout.
This local adapter uses loopback: Termux and its proot can share the server,
but genuinely remote machines need their own server or a network adapter.
Keep per-case runtime/platform records when combining results, and deduplicate
by manifest test URL, including its query variant.

- Official routes handle Python handlers, `.sub` substitutions, `.headers`,
  response pipes, generated `.any`/`.window` pages and URL variants.
- Configured WPT domains are routed to loopback while preserving document
  origins and HTTP Host headers. Official nonexistent hosts stay nonexistent.
  `domains.json` comes from upstream `ConfigBuilder`'s domain sets. Update it
  if a newer upstream changes its test-domain configuration.
- HTTP/HTTPS and HTTP/2 servers are enabled. Local HTTPS test certificate
  validation is bypassed only by the test fetch adapter; certificate trust and
  transport-specific browser behavior are not conformance-tested by that bypass.
- Normal cookies, CORS, redirects, document decoding, navigation and renderer
  isolation use the production browser paths. The upstream test bodies and
  assertions are unchanged. A result collector is appended to testharness.js.
- Testdriver pages are **not excluded merely for importing testdriver**. The
  adapter records an unsupported automation command only if it is invoked,
  including its name. It does not fabricate successful clicks or permissions.
- Normal cases get 20 seconds; upstream `timeout: long` cases get 75 seconds.
  Override with `--timeout` / `--long-timeout`. A separate watchdog allows
  12 seconds for cleanup/RPC completion. Unfinished cases remain nonpasses;
  a timeout is not proof of a particular browser bug.
- The two rates are fully passing cases / supported attempted cases and fully
  passing cases / all official manifest cases. The latter is a verified lower
  bound. Untested cases are unknown, not failures. Partial results in directory
  order are not a statistically representative sample.

Actual infrastructure gaps are recorded separately:

- WebDriver automation: permissions, virtual devices, multi-window operations,
  input actions and similar commands need a browser adapter, not an apt package.
- PAC proxy setup is recorded when the manifest requires it. WebSocket DNS does
  not yet use the HTTP loopback adapter; HTTP/3/WebTransport, unusual hostnames,
  certificate trust and transport-specific setups need additional work.
- Reftests require readiness handling and screenshot/reference comparison with
  fuzzy tolerances; they are not testharness pages. Print reftests need printing.
  Visual/manual tests require a separate procedure; wdspec needs WebDriver;
  test262 needs its JavaScript language-test execution adapter. Their manifest
  counts remain in the whole-suite denominator, never silently disappear.

`official.js` is a targeted runner (`--cases` accepts a JSON list of manifest
URLs), not the full-run entry point. `official-case.js` runs a single case:

```sh
bun test/wpt/official-case.js http://web-platform.test:18000/dom/nodes/ChildNode-before.html ../wpt-run/child-before-retest.json 20000
```

Run from the checkout you intend to measure. Keep patched retests separate;
never merge their passes into the frozen baseline snapshot. `run.js` remains a
legacy static-resource diagnostic tool, not the current baseline runner.
`count-manifest.js` and `summarize.js` remain available for manifest counting
and legacy report inspection.
