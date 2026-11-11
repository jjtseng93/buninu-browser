# Happy DOM patch queue

The vendored Happy DOM tree is based on upstream tag `v20.14.5`, commit
`0d4cdbe7442af49d16b49ddf1acf7cc9684ed318`:

- Upstream: <https://github.com/capricorn86/happy-dom>
- Vendored tree: `vendor/happy-dom`
- Patch paths are relative to the root of the upstream Happy DOM repository.

Every patch applies in numeric order to a checkout of that commit, and the
whole queue reproduces `vendor/happy-dom/packages/happy-dom/src` exactly:

```sh
for patch in patches/happy-dom/0*.patch; do
  git -C vendor/happy-dom apply --check "../../$patch" &&
  git -C vendor/happy-dom apply "../../$patch"
done
```

For the already-patched vendored tree, check each patch independently in
reverse without modifying files (this is not a sequential queue removal):

```sh
for patch in $(ls -r patches/happy-dom/0*.patch); do
  git -C vendor/happy-dom apply --reverse --check "../../$patch"
done
```

## Patch manifest

| Patch | Modified upstream file | Reason | Verification |
|---|---|---|---|
| `0001-use-bun-entity-adapter.patch` | `packages/happy-dom/src/utilities/XMLEncodeUtility.ts` | Route entity decoding through the project-owned `Bun.markdown.render()` adapter instead of installing the external `entities` package. | `bun test test/entities-adapter.test.js` |
| `0002-use-bun-platform-adapters.patch` | `packages/happy-dom/src/file/FileReader.ts`, `packages/happy-dom/src/nodes/html-image-element/HTMLImageElement.ts`, `packages/happy-dom/src/web-socket/WebSocket.ts` | Route the remaining static package imports through project-owned adapters backed by Bun APIs, so importing the DOM tree does not require installing npm dependencies. | `bun test test/html-parser.test.js test/happy-dom-platform-adapters.test.js` |
| `0003-defer-script-events-to-renderer.patch` | `packages/happy-dom/src/nodes/html-script-element/HTMLScriptElement.ts` | Suppress Happy DOM's synthetic load/error event when its own script loader is disabled; the renderer fetches and executes scripts and dispatches the real outcome itself. | `bun test test/page-scripts.test.js` (`page-inserted scripts run; innerHTML scripts do not; on* handlers fire`) |
| `0004-insert-adjacent-html-in-order.patch` | `packages/happy-dom/src/nodes/element/Element.ts` | `insertAdjacentHTML` inserted the parsed nodes one at a time, which reversed their order at `afterbegin` and `afterend`; insert the parsed fragment as a whole. | `bun test test/page-scripts.test.js` (`insertAdjacentHTML keeps the order of the inserted nodes at every position`) |
| `0005-invalidate-matches-on-structure-changes.patch` | `packages/happy-dom/src/query-selector/QuerySelector.ts` | `Element.matches()` cached results that were invalidated only by changes to the elements the matcher visited, so structural pseudo-classes and sibling combinators stayed stale after a child list change, and `:has()` after any change in the subtree; register the parent of every visited element, and do not cache `:has()` matches. | `bun test test/happy-dom-matches.test.js` |
| `0006-parse-css-escapes-in-selectors.patch` | `packages/happy-dom/src/query-selector/SelectorParser.ts` | The group scan treated a comma, space, quote, or parenthesis that belonged to a CSS escape (`\,`, `\31 `, `\"`, `\(`) as a combinator or grouping character, and a type selector stopped at the first backslash, so `\64 iv` and `my\-el` did not parse. Escapes are consumed first (CSS Syntax §4.3.7) and every identifier is decoded with `cssUnescape`, which maps zero, surrogates and code points past U+10FFFF to U+FFFD instead of throwing `RangeError`. | `bun test test/page-scripts.test.js -t "selectors with CSS escapes"` |
| `0007-scope-content-models-to-html-namespace.patch` | `packages/happy-dom/src/html-parser/HTMLParser.ts` | HTML content-model rules (implied end tags, forbidden descendants) apply only to elements in the HTML namespace, not to SVG or MathML elements that share a local name. | `bun test test/html-rcdata.test.js` |
| `0008-serialize-cdata-sections.patch` | `packages/happy-dom/src/xml-serializer/XMLSerializer.ts` | Preserve CDATA sections in the existing recursive XML serializer, including nested nodes and namespace state. | `bun test test/cdata-section.test.js` |
| `0009-defer-all-image-loading-to-renderer.patch` | `packages/happy-dom/src/nodes/html-image-element/HTMLImageElement.ts` | Disabled image loading also covers data URLs and invalid-source errors, so they do not race the renderer. Depends on `0002`. | `bun test test/raster-codecs.test.js test/happy-dom-platform-adapters.test.js` |
| `0010-parse-title-and-textarea-as-rcdata.patch` | `packages/happy-dom/src/config/HTMLElementConfig.ts`, `packages/happy-dom/src/config/HTMLElementConfigContentModelEnum.ts`, `packages/happy-dom/src/html-parser/HTMLParser.ts` | `<title>` and `<textarea>` were parsed as ordinary elements, so markup inside them became child elements. Parse their content as RCDATA (HTML §13.2.5.2): text up to the matching end tag, with character references decoded, CR/CRLF normalised, NUL replaced, and one leading LF dropped in a textarea. Only HTML-namespace elements take this path. | `bun test test/html-rcdata.test.js` |
| `0011-keep-empty-mutation-old-value.patch` | `packages/happy-dom/src/mutation-observer/MutationRecord.ts` | `oldValue` used `||`, so an empty old value was reported as `null`; use `??`. | `bun test test/mutation-record-old-value.test.js` |

### `0006` against upstream `SelectorParser.ts`

Upstream `v20.14.5` splits a selector with `SELECTOR_GROUP_REGEXP`. Its groups
are a combinator (` `, `,`, `+`, `>`, `~`) and a grouping character (`(`, `)`,
`[`, `]`, `"` or `'`). A backslash is not special there, so the character after
it is what the scan sees. The type-selector alternative is
`[a-zA-Z0-9\u00A0-\uFFFF-]+`, which also stops at `\`.

| Selector | Upstream | With `0006` |
|---|---|---|
| `style\=\"\"` | each `"` changes the quote depth, then the type selector stops at `\`, so the selector is rejected | both escapes stay in one type selector; `cssUnescape` yields `style=""` |
| `.x\,y > span` | the comma starts another selector in the list | `\,` stays in the class; `>` is still the child combinator |
| `\64 iv` | the space after the hex escape is a descendant combinator, and `\` is not a type-selector character | `\64 ` is one escape (U+0064), so the type is `div` |
| `my\-el` | the type selector matches `my` and then fails on `\-el` | the type is `my-el` |
| `#\110000 x` | `String.fromCodePoint` throws `RangeError` | the escape decodes to U+FFFD, as in Chromium's `ConsumeEscape` |

The patched group expression matches an escape first
(`\[0-9a-fA-F]{1,6}\s?` or `\[\s\S]`) and skips it. Combinators and grouping
characters move to groups 2 and 3. Type selectors, ids, classes and attribute
names may contain the same escapes and are all decoded with `cssUnescape`.

### `0007` and `0010`: HTML parsing rules do not apply to SVG

`HTMLParser.ts` must use HTML content-model rules and the RCDATA fast path
only for nodes in the HTML namespace. Treating an SVG `<title>` as HTML
RCDATA repeatedly consumed later markup without closing the lowercase SVG
node, deleting following controls and preventing Hextris initialization.
`0007` scopes the content models; `0010` adds RCDATA with the same namespace
check. Validation: `bun test test/html-rcdata.test.js`; live game
<https://hextris.io/>. The same rule preserves SVG title text and following
SVG/HTML siblings.

### `0008`: XML CDATA serialization

The project DOM adapter supplies genuine CDATA nodes. The XML serializer uses a
private recursive method, so its type switch needs one local branch to emit the
CDATA delimiters without escaping its data. HTML fragment serialization remains
in the project adapter and escapes CDATA as ordinary text.

### `0009`: renderer-owned image loading

Previously data URLs and invalid sources escaped the disabled-loading setting
and raced the renderer, dispatching duplicate load/error events and probing
encoded images twice. DOM-only adapter tests explicitly enable loading; page
images remain owned by the renderer.

Keep each local Happy DOM change in a separate numbered patch and add it to
this table with its reason and focused test. When updating Happy DOM, regenerate
and re-check the queue against the new pinned commit before changing the version
record in `THIRD_PARTY_NOTICES.md`.
