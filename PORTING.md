# Porting Blink concepts to a Bun/JavaScript browser engine

## 1. Goal and constraints

This document evaluates building a new browser engine in JavaScript/TypeScript on
top of Bun. It is not a plan to mechanically translate Blink's C++ files.

The intended architecture has these constraints:

- Browser engine code is JavaScript or TypeScript executed by Bun.
- Page JavaScript is executed by Bun/JavaScriptCore. Controlled documents may
  use an in-process realm; arbitrary remote documents use a dedicated Bun
  renderer subprocess.
- Rendering uses CanvasKit WebAssembly and its Canvas 2D-compatible API.
- Bun's built-in networking, streams, workers, IPC, image, storage, and runtime
  facilities should be reused instead of reimplemented.
- A JavaScript realm is not a security sandbox. Bun 1.4.3 exposes `process` and
  `Bun` inside `ShadowRealm`, and `node:vm` has constructor escapes. Process
  separation is therefore required for untrusted pages; until an OS/platform
  sandbox is present, remote script execution must be disabled or explicitly
  marked unsafe.
- Native addons are not part of the browser implementation. Existing Bun
  internals and CanvasKit WASM are platform dependencies, not code maintained by
  the browser project.

The practical goal is therefore:

> Implement Web-platform behavior, DOM, style, layout, and browser scheduling
> in JS/TS while delegating runtime, I/O, codecs, and rasterization to Bun and
> CanvasKit.

## 2. Investigation baseline

The observations below were verified locally rather than inferred from public
documentation.

### Chromium checkout

- Chromium commit: `2e7327eeeab051c4837bc03a17cbeae763449bcd`
- Blink implementation directory: `third_party/blink/renderer`
- Blink renderer physical lines: approximately 3.52 million
- Renderer source-language lines: approximately 3.47 million
- C++ accounts for approximately 3.36 million lines, or 96.8% of renderer
  source code.

Those numbers describe Blink's current implementation, not the amount of code a
new engine must reproduce. Blink contains V8 bindings, Oilpan integration,
Chromium embedder interfaces, platform abstractions, and mature Web API modules
that do not transfer to this architecture.

### Bun binary

Verified binary:

```text
/usr/bin/bun
Bun 1.4.3
revision 97246d044e1e6e7c570ed911bb6911ec068759e5
```

Relevant Bun source checkout:

```text
../bun
```

### CanvasKit demo

Relevant working demo:

```text
../score-simplify
```

The CanvasKit tests were run with:

```sh
cd ../score-simplify
bun run tri
bun run test:canvas
```

All 16 Canvas 2D tests passed.

## 3. Capabilities verified in Bun 1.4.3

### 3.1 JavaScript runtime and realms

Bun provides JavaScriptCore, garbage collection, promises, microtasks, timers,
WebAssembly, modules, and the base event loop. DOM objects implemented as JS
objects can live in the same garbage-collected heap as page JavaScript. This
eliminates Blink's V8 wrapper layer and Oilpan-to-JavaScript heap bridge.

`node:vm` was tested successfully with:

- `vm.createContext()`
- a separate global object
- `microtaskMode: "afterEvaluate"`
- `vm.Script`
- execution timeouts
- `vm.SourceTextModule`
- module `link()` and `evaluate()`
- module evaluation timeouts

Minimal verified pattern:

```ts
import vm from "node:vm";

const context = vm.createContext({}, {
  microtaskMode: "afterEvaluate",
});

const module = new vm.SourceTextModule("export default 6 * 7", {
  context,
  identifier: "https://example.test/a.js",
});

await module.link(() => {});
await module.evaluate({ timeout: 100 });

console.assert(module.namespace.default === 42);
```

This is sufficient as the execution foundation for classic scripts and module
scripts. The browser still needs to implement URL-based module fetching, import
maps, the module map, MIME/CORS policy if desired, and installation of the
Window-facing globals in each realm.

### 3.2 Event loop foundation

Bun already implements:

- OS I/O polling
- task and concurrent-task queues
- timers and immediates
- JavaScriptCore's microtask queue
- `queueMicrotask`
- Promise rejection handling
- deferred work queues
- worker-to-main-thread task dispatch

The browser does not need another OS event loop. It needs a browser scheduler on
top of Bun's loop to impose Web-observable ordering:

```text
task
  -> page callback
  -> microtask checkpoint
  -> mutation observer delivery
  -> rendering opportunity
  -> style/layout flush
  -> resize observer delivery
  -> requestAnimationFrame
  -> paint
```

The distinction matters: Bun solves polling and execution; the browser must
still define when rendering work and Web callbacks occur.

### 3.3 Existing Web-facing primitives

The following globals were verified in the installed Bun binary:

- `AbortController`, `AbortSignal`
- `Blob`, `File`, `FormData`
- `Event`, `CustomEvent`, `EventTarget`
- `MessageEvent`, `MessageChannel`, `MessagePort`
- `BroadcastChannel`
- `DOMException`
- `Headers`, `Request`, `Response`, `fetch`
- `URL`, `URLPattern`, `URLSearchParams`
- `ReadableStream`, `WritableStream`, `TransformStream`
- compression/decompression streams
- `TextEncoder`, `TextDecoder` and stream variants
- `WebSocket`
- `Worker`
- `structuredClone`
- `Crypto`, `CryptoKey`, `SubtleCrypto`
- `Performance` and performance entry/observer classes
- `ShadowRealm`
- `WebAssembly`

These objects can be installed into a page realm or wrapped where browser
semantics differ. They reduce platform work, but they do not create a DOM or a
browser lifecycle by themselves.

### 3.4 Networking, process, and storage infrastructure

Bun also provides:

- HTTP through `fetch`
- TCP, UDP, TLS, DNS, and WebSocket implementations
- streams and incremental bodies
- gzip, deflate, Brotli-related HTTP support, and zstd utilities
- Bun-to-Bun subprocess IPC
- workers and structured-clone messaging
- SQLite and SQL APIs
- filesystem and memory mapping
- `Cookie` and `CookieMap` parsing primitives
- bundling, transpilation, module resolution, and single-executable packaging

For controlled content, a first implementation can run the browser controller,
page realm, DOM, style, layout, and renderer in one process. Arbitrary remote
content must instead use a Bun subprocess with a minimal environment, controlled
working directory, typed IPC, deadlines, and kill/restart handling. That process
boundary improves containment but is not a complete security sandbox by itself.

### 3.5 XML

`Bun.XML` is present in Bun 1.4.3 and was verified with:

```ts
Bun.XML.parse(input, { compact: false });
Bun.XML.stringify(value);
```

It supplies a conforming XML tree/data parser and serializer. It is useful for:

- XML-mode `DOMParser`
- XHTML
- SVG/XML documents
- XML responses
- XML serialization support

It is not an HTML parser. Normal HTML requires error recovery and WHATWG HTML
tree-construction behavior, whereas `Bun.XML` correctly requires well-formed
XML.

### 3.6 Images

`Bun.Image` is implemented as an off-main-thread image pipeline. The source
checkout shows support for decode, RGBA8 processing, transforms, and encode,
including the relevant JPEG, PNG, WebP, and platform image paths.

The browser can reuse it for image fetching and conversion. Remaining browser
work includes:

- `<img>` request and lifecycle state
- intrinsic dimensions
- `load` and `error` events
- CSS sizing and `object-fit`
- animated-frame scheduling
- decoded-image caching
- passing decoded data to CanvasKit

Reimplementing image codecs is unnecessary.

## 4. CanvasKit boundary verified in Bun

CanvasKit 0.41.1 in `../score-simplify` was initialized directly from WASM
bytes in Bun. It does not require Bun to expose `HTMLCanvasElement`,
`OffscreenCanvas`, or WebGL for the tested CPU path:

```ts
const CanvasKit = await CanvasKitInit({ wasmBinary });
const canvas = CanvasKit.MakeCanvas(width, height);
const context = canvas.getContext("2d");
```

The following operations passed locally:

- rectangle fill, clear, and stroke
- paths, line segments, close/fill/stroke
- arcs
- quadratic and cubic curves
- linear and radial gradients
- alpha and composite operations
- clipping
- translate/rotate transforms
- save/restore state
- image-data creation, write, and readback
- PNG decoding and `drawImage`
- line dashes
- font loading
- `fillText` and `measureText`
- PNG/data-URL output
- direct RGBA pixel access

The demo also verifies a useful division of labor:

- CanvasKit performs drawing, decode, and pixel access.
- `Bun.Image` can perform encoding when the selected CanvasKit build lacks a
  requested encoder.
- WASM can be bundled as a file asset and supplied as bytes for a Bun
  single-executable build.

CanvasKit therefore removes the need to implement rasterization, path geometry,
anti-aliasing, basic compositing, gradients, image drawing, and basic Canvas 2D
text drawing.

CanvasKit does not implement CSS layout, paint order, stacking contexts,
scrolling, hit testing, DOM selection, or browser scheduling.

## 5. HTML capabilities and limits

### 5.1 `HTMLRewriter` and Bun's HTML scanner

Bun's `HTMLRewriter` is based on `lol-html`. Bun's bundler reuses the same
streaming machinery for its HTML scanner. The source scanner already identifies
scripts, stylesheets, fonts, images, media, workers, manifests, and related URL
attributes.

This is directly useful for:

- resource preloading and discovery
- streaming inspection
- URL rewriting
- static-page prototypes
- serialization/transformation
- a preliminary resource scanner independent of the DOM builder

It is not a complete browser DOM parser. Its public abstraction is a streaming
rewriter with transient handlers rather than a persistent, script-reentrant
HTML tree builder.

The browser still needs, directly or through a reusable JS implementation:

- the HTML tokenizer/tree builder contract
- insertion modes
- active formatting elements
- adoption-agency recovery
- foster parenting
- template contents
- SVG/MathML namespace transitions
- parser pause/resume for scripts
- parser-inserted scripts
- `document.write()` input insertion
- DOM construction and mutation hooks

For an early static renderer, `HTMLRewriter` can help build an approximate tree.
For broad compatibility, use or implement a WHATWG-compatible tree builder and
retain `HTMLRewriter` as the preload scanner.

### 5.2 `Bun.XML`

`Bun.XML` should back strict XML modes and can reduce XML/SVG-document work. It
must not be used to parse `text/html`.

## 6. Bun's CSS parser

### 6.1 What exists internally

`../bun/src/css` contains Bun's CSS parser, derived from Lightning CSS and
Servo. Source inspection shows support for stylesheets, selectors,
declarations, known properties, media queries, supports conditions, nesting,
layers, keyframes, font rules, custom properties, calc, color, gradients,
transforms, flex/grid-related properties, minification, and serialization.

This is valuable parsing technology, but it is currently primarily part of the
bundler.

### 6.2 Public API status

The following were verified as absent in Bun 1.4.3:

```ts
typeof Bun.CSS; // "undefined"
typeof Bun.css; // "undefined"
```

There is no public runtime API returning a stylesheet, selector, declaration,
or typed property AST.

### 6.3 Private testing interface

Bun contains a private CSS interface in `bun:internal-for-testing`. Release
builds require `--expose-internals`:

```sh
bun --expose-internals app.ts
```

Verified usage:

```ts
import { cssInternals } from "bun:internal-for-testing";

cssInternals.minifyTest(
  ".a { color: red; display: flex }",
  "",
);
// ".a{color:red;display:flex}"

cssInternals.attrTest(
  "color:red;display:flex",
  "",
  false,
);
// "color: red; display: flex"
```

The exposed private operations parse, validate, normalize, prefix, minify, and
serialize CSS. They return CSS text, not a structured runtime AST.

They can help with prototypes and canonicalization, but cannot directly drive:

- selector matching
- cascade
- inheritance
- computed values
- property dependency tracking
- style invalidation
- layout

Private testing APIs are also not a stable production contract.

### 6.4 Why `dlsym`/Bun FFI does not currently expose the parser

The installed `/usr/bin/bun` was inspected with `readelf -Ws` and `nm -D`.
There is no dynamically exported CSS parsing entry point such as
`Bun__CSS__parse` or `css_parse`.

`bun:ffi` is capable of calling C ABI functions found through dynamic symbols,
but Bun's internal stylesheet parser has neither the required exported symbol
nor a suitable ABI. Its Rust API uses generic internal types, a bump arena,
borrowed AST data, import records, and internal diagnostics. Calling a mangled
Rust symbol by an address would be version-specific and unsafe even if its
address were found.

The private CSS functions do not use `dlsym`; Bun connects them through its
generated JavaScript-to-Rust dispatch mechanism.

### 6.5 CSS integration options

Ordered from least invasive to most integrated:

1. Use a pure JS CSS parser and keep the entire style AST in the JS heap.
2. Use a CSS parser compiled to WASM with a compact typed-array result.
3. Use private `cssInternals` to normalize CSS, then parse the canonical output
   in JS. This parses twice but can simplify a prototype.
4. Add an upstream-quality `Bun.CSS.parse()` API to Bun.

The ideal Bun API should not eagerly allocate a deeply nested JS object for
every token. Better possible shapes are:

- callbacks for rules/selectors/declarations; or
- a compact bytecode/typed-array IR plus a string table.

For example:

```ts
const result = Bun.CSS.parseToBuffer(source);

// Conceptual result
result.bytecode; // Uint32Array
result.strings;  // string[]
result.imports;  // string[]
result.errors;   // diagnostics
```

Exposing Bun's parser would remove CSS tokenization, grammar, property parsing,
selector parsing, and error-recovery work. It would not implement selector
matching, cascade, computed style, invalidation, or layout.

## 7. Components that still have to be built

### 7.1 DOM object model

Bun does not provide browser `Node`, `Document`, `Element`, `HTMLElement`,
`Text`, `Comment`, `DocumentFragment`, collections, ranges, selection, Shadow
DOM, or custom elements.

Required work includes:

- ownership and parent/child/sibling traversal
- attributes and namespaces
- document order
- insertion/removal/adoption/cloning
- connected-state changes
- text and HTML serialization
- live collections where required
- selector-query integration
- mutation records and observers
- event propagation paths and default actions
- realm-correct constructors and prototypes

This is a good fit for JS because DOM and page values share a garbage-collected
heap. Care is still required to maintain stable object shapes and avoid
allocating excessive temporary objects.

### 7.2 Web IDL-visible behavior

No native binding generator is required, but Web APIs expose observable IDL
semantics:

- argument and return-value conversion
- overload resolution
- brand checks
- illegal constructors
- prototype and property descriptors
- `DOMException` behavior
- callback invocation rules
- dictionary and union conversion
- realm ownership
- named and indexed properties

A JS/TS Web IDL generator may eventually be worthwhile. An MVP can implement
interfaces manually and tighten compatibility over time.

### 7.3 Selector matching, cascade, and computed style

Even with a complete CSS parser, the browser must implement:

```text
stylesheet rules
  -> selector indexes
  -> matched declarations
  -> origin/layer/specificity/source-order cascade
  -> inheritance and initial values
  -> custom-property substitution
  -> computed values
```

Important subjects include UA styles, inline styles, `!important`, layers,
media/supports rules, pseudo-classes/elements, `var()`, relative units, and
dependency tracking.

An MVP should initially recalculate all styles after relevant mutations. Style
invalidation can be added only when profiling shows the need.

### 7.4 Layout

Layout remains the largest single subsystem. CanvasKit is a renderer, not a CSS
layout engine.

Required areas include:

- block formatting and margin collapsing
- inline formatting and line boxes
- whitespace and line breaking
- replaced elements and intrinsic sizing
- absolute/fixed/sticky positioning
- percentage, min/max, and intrinsic sizes
- flexbox
- grid
- tables
- overflow and scrolling
- writing modes
- fragmentation, if required

Recommended implementation order:

1. block layout
2. inline text layout
3. replaced elements/images
4. absolute positioning
5. flexbox
6. overflow and scrolling
7. grid
8. tables
9. sticky positioning
10. advanced writing modes and fragmentation

SkParagraph or CanvasKit text measurement can perform shaping and glyph work,
but CSS inline box construction, whitespace, line-height, decoration, DOM range
mapping, and line breaking policy remain browser responsibilities.

### 7.5 Paint ordering and display lists

Layout output must be converted into Web-correct paint order and CanvasKit
operations. Remaining work includes:

- backgrounds and borders
- stacking contexts and `z-index`
- clips, transforms, and effects
- opacity groups
- shadows, filters, and text decoration
- scrolling offsets
- hit-test data
- dirty regions and retained display items

An MVP may repaint the full viewport. The preferred eventual boundary is a
retained display list rather than direct painting from every DOM node:

```text
DOM/style
  -> layout fragments
  -> paint property trees/display list
  -> CanvasKit replay
```

This reduces JS-to-WASM traffic and allows caching CanvasKit paths, images,
fonts, and paragraphs.

### 7.6 Browser scheduling and forced flushes

Bun's event loop must be wrapped with browser-specific queues and rendering
opportunities. Synchronous DOM reads require forced work:

```js
element.style.width = "100px";
const width = element.offsetWidth;
```

`offsetWidth` may need to synchronously flush pending style and layout before
returning.

Required scheduling includes parsing, scripts, network completions, timers,
microtasks, mutation observers, animation frames, resize/intersection observers,
input, load lifecycle events, and rendering.

### 7.7 Window, navigation, and resources

The browser must supply:

- `window`, `document`, `location`, `history`, `navigator`
- navigation and document replacement
- classic and module script loading
- stylesheet and font loading
- image lifecycle
- base URL resolution
- `DOMContentLoaded` and `load`
- request caching and deduplication
- cookies and storage semantics as needed
- iframe/browsing-context support when introduced

For the controlled-content MVP, cross-origin iframes, full `WindowProxy`
semantics, and origin-process assignment can be deferred. Same-origin and CORS
behavior is still required for compatibility. Arbitrary remote scripts remain
disabled or explicitly unsafe until the renderer has a platform security
sandbox; a Bun subprocess alone does not make origin checks optional.

### 7.8 Input, forms, editing, and default actions

Bun's `EventTarget` does not implement browser interaction behavior. Remaining
work includes:

- hit testing
- pointer, mouse, wheel, and keyboard events
- focus and tab navigation
- link activation
- buttons, checkboxes, radio buttons, and form submission
- text input
- selection and caret
- clipboard and IME
- editable content

Basic click/focus/input can be implemented early. Full editing, selection, and
IME are large later-stage subsystems.

### 7.9 Web API long tail

Features such as IndexedDB, service workers, Cache API, Web Audio, media,
WebRTC, accessibility, WebGL/WebGPU DOM facades, permissions, geolocation,
notifications, SVG DOM, and advanced editing are not prerequisites for the
first renderer. They should be prioritized based on target sites rather than
copied wholesale from Blink.

## 8. Recommended architecture

Keep a document's JS, DOM, style, and layout in the same Bun renderer process
so synchronous DOM APIs remain cheap. The controller may share that process
for controlled fixtures, but arbitrary remote pages require a subprocess:

```text
Bun process
|
+-- Browser controller
|   +-- tabs and navigation
|   +-- history
|   +-- resource/cache coordinator
|   +-- frame scheduler
|
+-- Page realm (Bun/JSC; not a security boundary)
|   +-- Window and Document globals
|   +-- classic scripts
|   +-- SourceTextModule graph
|   +-- Web-facing Bun primitives
|
+-- DOM and HTML
|   +-- persistent DOM tree
|   +-- HTML tree builder
|   +-- HTMLRewriter-based preload scanner
|
+-- Style engine
|   +-- CSS parser/IR
|   +-- selector matcher
|   +-- cascade and computed styles
|
+-- Layout engine
|   +-- block/inline
|   +-- replaced elements
|   +-- flex, then grid/table
|
+-- Rendering
    +-- display list and hit-test data
    +-- CanvasKit.MakeCanvas()
    +-- Bun.Image
    +-- frame/PNG/output presentation
```

Do not split page JavaScript from its DOM through RPC. DOM APIs are synchronous
and fine-grained. If processes are introduced, use one coarse renderer unit per
tab/document group and send only navigation, resource, input, frame, and
lifecycle messages across IPC.

## 9. Suggested implementation stages

### Stage 0: vertical feasibility slice and CDP contract

Render one document containing text, an image, block boxes, and flex layout:

```text
fetch HTML
  -> build DOM
  -> parse CSS
  -> cascade
  -> block/inline/flex layout
  -> display list
  -> CanvasKit
  -> RGBA/PNG
```

This validates data structures and ownership before implementing broad APIs.

In the same stage, `../casty` must be able to discover/create a page target,
navigate it, set viewport and user agent, and receive a placeholder screenshot
over CDP. Replace the placeholder with CanvasKit output during Stage 1 and add
screencast frame events as rendering invalidation becomes available.

### Stage 1: static renderer

- Document, Element, Text, attributes
- HTML tree construction
- stylesheet and inline-style parsing
- basic selectors and cascade
- block and inline layout
- images and fonts
- backgrounds, borders, and text painting
- full-frame output

### Stage 2: scripts and interaction

- Window realm bootstrap
- classic scripts and modules
- DOM mutation
- events and propagation
- timers, microtasks, and animation frames
- forced style/layout flushes
- hit testing, clicking, focus, and scrolling

### Stage 3: common modern layouts

- flexbox
- absolute/fixed positioning
- overflow and scroll containers
- grid
- forms and basic text input
- incremental resource lifecycle
- style/layout/paint caching based on profiling

### Stage 4: compatibility-driven expansion

- iframe and navigation model
- tables
- custom elements and Shadow DOM
- observers
- storage APIs
- selection/editing
- additional Web APIs based on actual target sites and WPT failures

## 10. Estimated scale

These estimates assume Bun 1.4.3, CanvasKit WASM, renderer process isolation
(with platform sandbox hardening tracked separately), reuse of available
JS/WASM parsers where appropriate, and deliberate deferral of media, WebRTC,
complete editing, accessibility, and the full Web API surface.

| Target | Estimated engine code | Estimated effort |
| --- | ---: | ---: |
| Static HTML/CSS renderer | 80k-150k JS/TS LOC | 0.5-1.5 engineer-years |
| Interactive JS-capable MVP | 150k-300k JS/TS LOC | 2-5 engineer-years |
| Useful for selected modern sites | 250k-500k JS/TS LOC | 5-15 engineer-years |
| Good general-site compatibility | 500k-1M JS/TS LOC | 20-60 engineer-years |
| Broad Web-platform compatibility | 1M+ JS/TS LOC plus extensive tests | 80-200+ engineer-years |

The estimates are dominated by cascade, layout, interaction, and compatibility,
not by Bun integration or rasterization.

## 11. Current risk ranking

| Area | Available foundation | Remaining risk |
| --- | ---: | ---: |
| JS engine and GC | Complete | Low |
| Realms and modules | Strong | Low to medium |
| OS event loop and I/O | Complete | Low |
| Networking and streams | Strong | Medium browser semantics |
| Workers and IPC | Strong | Low |
| Image codecs | Strong | Low |
| Canvas 2D rasterization | Verified strong | Low to medium |
| XML | Strong | Low |
| HTML streaming scan | Strong | Medium tree-builder gap |
| Persistent DOM | Missing | High |
| CSS grammar | Strong internally, no public AST | Medium |
| Selector matching and cascade | Missing | High |
| Layout | Missing | Very high |
| Paint order/display lists | Partial primitives only | High |
| Browser scheduling | Runtime exists, Web policy missing | Medium to high |
| Navigation/browsing contexts | Mostly missing | High |
| Forms/editing/IME | Mostly missing | High, deferrable |
| Web API long tail | Mixed | High, incremental |

## 12. Conclusion

The local evidence supports the architecture. Bun can host the engine and page
JavaScript; CanvasKit can provide a headless Canvas 2D raster target directly in
Bun; Bun already supplies most runtime, networking, streams, IPC, image, XML,
and storage primitives.

The project is therefore not blocked on native bindings, V8 replacement,
garbage-collector integration, codecs, or basic drawing. The remaining hard
problems are the actual browser semantics:

1. persistent DOM and HTML tree construction;
2. selector matching, cascade, and computed style;
3. CSS layout, especially inline formatting, flex, grid, tables, and intrinsic
   sizing;
4. paint ordering, scrolling, hit testing, and interaction;
5. browser scheduling, navigation, and compatibility behavior.

A useful constrained browser is feasible without reproducing Blink's full 3.5
million-line implementation. Broad compatibility remains a large, long-term
engine project, but its difficulty is concentrated in Web behavior rather than
in Bun or CanvasKit platform integration.
