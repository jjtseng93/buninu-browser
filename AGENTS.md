# AGENTS

## General
- This project only uses pure JavaScript +/- WASM.
- Native bindings are generally not allowed in the headless shell itself
  * In the future when it is wrapped into a full browser on each platform, the frontend should stay as thin wrappers just enough to draw rendered content from the headlesss shell
  * Specifically, able to work with ../casty through CDP is an important goal
- Only use Bun FFI to dlopen libc when other methods are clearly not enough

## Viewing files
- No file is unviewable: every response the browser navigates to must show something, never a "cannot be shown" page
  * HTML is shown as itself; images and video/audio get a generated page like Chromium's standalone image and media documents
  * The formats bunmsh `serve` previews (md, json, json5, jsonc, jsonl, ndjson, yaml, yml, toml, xml) get its preview under a "Pretty-print" checkbox, checked by default; unchecked shows the raw text
  * Everything else, binary included, is shown as text
  * Large files must not stall the renderer: past a size limit only their start is shown (and previews fall back to the text), with a bar at the top that says so and points to `download`
  * See `lib/document-types.js`; `download` still saves the response's original bytes

## Bun
- Bun doesn't have `bun --check`
- Bun has many built-in functions; use/check them first before implementing your own
  * "$ Archive ArrayBufferSink Cookie CookieMap CryptoHasher FFI FileSystemRouter Glob Image MD4 MD5 SHA1 SHA224 SHA256 SHA384 SHA512 SHA512_256 JSONC JSON5 JSONL markdown TOML XML YAML Transpiler embeddedFiles S3Client s3 CSRF allocUnsafe argv build concatArrayBuffers connect cron color deepEquals deepMatch deflateSync dns enableANSIColors env escapeHTML fetch file fileURLToPath gc generateHeapSnapshot gunzipSync gzipSync hash indexOfLine inflateSync inspect isMainThread isStandaloneExecutable listen udpSocket main mmap nanoseconds openInEditor password pathToFileURL peek plugin randomUUIDv7 randomUUIDv5 readableStreamToArray readableStreamToArrayBuffer readableStreamToBytes readableStreamToBlob readableStreamToFormData readableStreamToJSON readableStreamToText resolve resolveSync revision semver sql postgres SQL serve sha shrink sliceAnsi sleep sleepSync spawn spawnSync stderr stdin stdout stringWidth stripANSI wrapAnsi Terminal unsafe version WebView which RedisClient redis secrets write zstdCompressSync zstdDecompressSync zstdCompress zstdDecompress"
