import { expect, test } from "bun:test";
import { displayDocument, highlightJson, parseContentType } from "../lib/document-types.js";

const bytes = (text) => new TextEncoder().encode(text);
const show = (url, contentType, body) => displayDocument({ url, contentType, body: typeof body === "string" ? bytes(body) : body });

test("HTML stays itself, decoded with its charset", () => {
  expect(show("https://x.test/", "text/html; charset=utf-8", "<p>hi</p>")).toEqual({ source: "<p>hi</p>", contentType: "text/html; charset=utf-8" });
  const big5 = new Uint8Array([0x3c, 0x70, 0x3e, 0xa4, 0xa4, 0xa4, 0xe5]);
  expect(show("https://x.test/", "text/html; charset=big5", big5).source).toBe("<p>中文");
  // No type: HTML-looking bytes are HTML.
  expect(show("https://x.test/", "", "<!doctype html><p>x").source).toBe("<!doctype html><p>x");
});

test("images are shown alone: SVG inline, others as a data: URL", () => {
  const png = show("https://x.test/a/pic.png?x=1", "image/png", new Uint8Array([137, 80, 78, 71]));
  expect(png.contentType).toBe("text/html");
  expect(png.source).toContain('<img src="data:image/png;base64,iVBORw==" alt="pic.png">');
  expect(png.source).toContain("<title>pic.png</title>");
  const svg = show("https://x.test/i.svg", "image/svg+xml", '<?xml version="1.0"?><svg width="4" height="4"></svg>');
  expect(svg.source).toContain('<div class="image"><svg width="4" height="4"></svg></div>');
});

test("bunmsh serve's formats get its preview under a Pretty-print checkbox, checked", () => {
  const toml = show("https://x.test/Cargo.toml", "application/toml", 'name = "buninu"\n').source;
  expect(toml).toContain('<input type="checkbox" id="pretty-print" checked> Pretty-print');
  expect(toml).toContain('<a class="download" href="https://x.test/Cargo.toml" download>Download</a>');
  expect(toml).toContain("<title>Cargo.toml — bun.toml.parse</title>");
  expect(toml).toContain("(bun.toml.parse)");
  expect(toml).toContain('<span class="json-statement">&quot;name&quot;:</span> <span class="json-string">&quot;buninu&quot;</span>');
  expect(toml).toContain('<pre id="raw" hidden>name = &quot;buninu&quot;');
  // The extension decides first, as in serve.js (it sends octet-stream for .jsonc and .jsonl).
  expect(show("https://x.test/a.jsonc", "application/octet-stream", '{ "a": 1, // c\n}').source).toContain("(bun.jsonc.parse)");
  expect(show("https://x.test/l.ndjson", "application/octet-stream", '{"a":1}\n').source).toContain("(bun.jsonl.parse)");
  expect(show("https://x.test/c.yml", "text/yaml", "a: [1, true]").source).toContain('<span class="json-constant">true</span>');
  expect(show("https://x.test/f.xml", "application/xml", '<a x="1"><b>hi</b></a>').source).toContain("(bun.xml.parse)");
  // Markdown is rendered by Bun.markdown.html with headings.
  const md = show("https://x.test/README.md", "text/markdown", "# Title\n\n- item").source;
  expect(md).toContain("(bun.markdown.html)");
  expect(md).toContain('<div id="formatted"><h1 id="title"><a href="#title">Title</a></h1>');
  expect(md).toContain('<pre id="raw" hidden># Title');
  // Without a known extension, the Content-Type names the format.
  expect(show("https://x.test/api", "application/vnd.api+json", '{"x":null}').source).toContain("(json.parse)");
  expect(show("https://x.test/doc", "text/markdown", "*a*").source).toContain("<em>a</em>");
  // What cannot be parsed is shown as serve.js reports it, with the text below.
  const bad = show("https://x.test/b.json", "application/json", "{nope").source;
  expect(bad).toContain("<h1>Cannot preview b.json</h1>");
  expect(bad).toContain('<pre id="raw">{nope</pre>');
  expect(bad).not.toContain("checkbox");
  // Bun.TOML refuses integers a JavaScript number cannot hold exactly.
  expect(show("https://x.test/n.toml", "application/toml", "n = 9007199254740993").source).toContain("Integer cannot be losslessly represented");
});

test("everything else is text, whatever the bytes: no file is unviewable", () => {
  expect(show("https://x.test/a.txt", "text/plain", "a < b").source).toContain("<pre>a &lt; b</pre>");
  expect(show("https://x.test/app.js", "text/javascript", "let x").source).toContain("<pre>let x</pre>");
  expect(show("https://x.test/a.zip", "application/zip", new Uint8Array([80, 75, 3, 4])).source).toContain("<pre>PK\u0003\u0004</pre>");
  expect(show("https://x.test/d.pdf", "application/pdf", "%PDF-1.7").source).toContain("<pre>%PDF-1.7</pre>");
  // No meaningful type: shown as text even when the bytes are binary.
  expect(show("https://x.test/blob", "application/octet-stream", new Uint8Array([65, 0, 66, 255])).source).toContain("<pre>A\u0000B\uFFFD</pre>");
  for (const [url, type] of [["https://x.test/f.woff2", "font/woff2"], ["https://x.test/m.wasm", "application/wasm"]]) {
    expect(show(url, type, new Uint8Array([0, 97])).source).toContain("<pre>");
  }
});

test("video and audio get a media document playing the URL itself", () => {
  const video = show("https://x.test/v/clip.mp4?t=1", "video/mp4", new Uint8Array(10)).source;
  expect(video).toContain('<video controls autoplay src="https://x.test/v/clip.mp4?t=1"></video>');
  expect(video).toContain("clip.mp4 (video/mp4, 10 bytes). Click the video to play.");
  const audio = show("https://x.test/tone.mp3", "audio/mpeg", new Uint8Array(3)).source;
  expect(audio).toContain('<audio controls src="https://x.test/tone.mp3"></audio><p class="note">tone.mp3 (audio/mpeg, 3 bytes). Click to play;');
});

test("content type parsing and JSON highlighting", () => {
  expect(parseContentType('Text/HTML; Charset="Big5"')).toEqual({ type: "text/html", charset: "Big5" });
  expect(parseContentType("")).toEqual({ type: "", charset: null });
  expect(highlightJson('{"a": [1, "b\\n", false]}'))
    .toBe('{<span class="json-statement">&quot;a&quot;:</span> [<span class="json-number">1</span>, '
      + '<span class="json-string">&quot;b<span class="json-special">\\n</span>&quot;</span>, <span class="json-constant">false</span>]}');
});

test("large files show their start with a bar pointing to download; large previews show the text", async () => {
  const { DISPLAY_LIMIT, PRETTY_LIMIT } = await import("../lib/document-types.js");
  const big = "x".repeat(DISPLAY_LIMIT + 10);
  const text = show("https://x.test/big.txt", "text/plain", big).source;
  expect(text).toContain(`Large file (256 KB); showing the first 256 KB. The whole file: casty's <code>download</code>`);
  expect(text).toContain('<a class="download" href="https://x.test/big.txt" download>Download</a>');
  expect(text).toContain(`<pre>${"x".repeat(DISPLAY_LIMIT)}</pre>`);
  // A small file still offers a download button.
  expect(show("https://x.test/a.txt", "text/plain", "hi").source).toContain('href="https://x.test/a.txt" download');
  const json = JSON.stringify(Array.from({ length: PRETTY_LIMIT / 4 }, (_, i) => i));
  expect(json.length).toBeGreaterThan(PRETTY_LIMIT);
  const preview = show("https://x.test/big.json", "application/json", json).source;
  expect(preview).toContain("Too large to pretty-print quickly");
  expect(preview).not.toContain("pretty-print\" checked");
  expect(preview).toContain(`<pre>${json}</pre>`);
});
