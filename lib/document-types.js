/**
 * What a top-level response looks like in the viewport. HTML is shown as
 * itself; anything else gets a small generated HTML document, as browsers do
 * for "standalone" resources (HTML §7.4.4-§7.4.7):
 *
 * - images: the image alone on a dark background, centered and fitted to the
 *   width (SVG inline, other formats as a data: URL so they are not fetched
 *   twice);
 * - video and audio: a <video> or <audio> element for the URL on the same
 *   background, with the file's name and type under it;
 * - the formats bunmsh's `serve` previews, handled the way it does: Markdown
 *   rendered with Bun.markdown.html, and JSON, JSON5, JSONC, JSON Lines, YAML,
 *   TOML and XML parsed with Bun's parsers and printed as highlighted JSON,
 *   under a "Pretty-print" checkbox that is on by default and, unticked,
 *   shows the text as sent;
 * - everything else, whatever its bytes: the text in a <pre>. There is no
 *   "cannot be shown" page (see AGENTS.md).
 *
 * Large files would stall layout (on a phone, 1 MB of text takes seconds and
 * 4 MB never finished): past DISPLAY_LIMIT only the start of the text is
 * shown, and past PRETTY_LIMIT the preview is skipped for the text, each
 * with a bar at the top that says so and points to casty's `download`.
 *
 * The bytes kept for downloads are the response's own, not this HTML. Text is
 * decoded with the Content-Type charset, UTF-8 when there is none.
 */

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
// Measured on a phone: 256 KiB of text lays out in about 2 s; a 32 KiB
// preview (highlighted JSON, many spans) in about 2.5 s.
export const DISPLAY_LIMIT = 256 * 1024;
export const PRETTY_LIMIT = 32 * 1024;

// From bunmsh serve.js (MIT, same author): the formats it previews, by file
// extension, with its parser names, pretty() and highlightJson().
const PARSERS = new Map([
  ["json", { name: "json.parse", parse: JSON.parse }],
  ["json5", { name: "bun.json5.parse", parse: Bun.JSON5.parse }],
  ["jsonc", { name: "bun.jsonc.parse", parse: Bun.JSONC.parse }],
  ["jsonl", { name: "bun.jsonl.parse", parse: Bun.JSONL.parse }],
  ["ndjson", { name: "bun.jsonl.parse", parse: Bun.JSONL.parse }],
  ["yaml", { name: "bun.yaml.parse", parse: Bun.YAML.parse }],
  ["yml", { name: "bun.yaml.parse", parse: Bun.YAML.parse }],
  ["toml", { name: "bun.toml.parse", parse: Bun.TOML.parse }],
]);
if (typeof Bun.XML?.parse === "function") {
  PARSERS.set("xml", { name: "bun.xml.parse", parse: Bun.XML.parse });
}
const MARKDOWN = "bun.markdown.html";

// A URL without one of those extensions: its Content-Type names the format.
const EXTENSION_BY_TYPE = new Map([
  ["text/markdown", "md"], ["text/x-markdown", "md"],
  ["application/json", "json"], ["text/json", "json"], ["application/json5", "json5"], ["application/jsonc", "jsonc"],
  ["application/jsonl", "jsonl"], ["application/x-ndjson", "ndjson"], ["application/jsonlines", "jsonl"],
  ["text/yaml", "yaml"], ["application/yaml", "yaml"], ["application/x-yaml", "yaml"], ["text/x-yaml", "yaml"],
  ["application/toml", "toml"], ["text/x-toml", "toml"],
  ["application/xml", "xml"], ["text/xml", "xml"],
]);

/** "md", a PARSERS key, or null: what bunmsh serve would preview this as. */
function previewKind(name, type) {
  const byName = extension(name);
  if (byName === "md" || PARSERS.has(byName)) return byName;
  const byType = EXTENSION_BY_TYPE.get(type) ?? (type.endsWith("+json") ? "json" : type.endsWith("+xml") ? "xml" : null);
  return byType === "md" || PARSERS.has(byType) ? byType : null;
}

/**
 * @param {{ url: string, contentType?: string, body: Uint8Array }} response
 * @returns {{ source: string, contentType: string }}
 */
export function displayDocument({ url, contentType = "", body }) {
  const { type, charset } = parseContentType(contentType);
  const name = fileName(url);
  if (HTML_TYPES.has(type) || (type === "" && looksLikeHtml(body))) {
    return { source: decode(body, charset), contentType: contentType || "text/html" };
  }
  if (type === "image/svg+xml") return html(name, IMAGE_STYLE, `<div class="image">${stripProlog(decode(body, charset))}</div>`);
  if (type.startsWith("image/")) {
    const src = `data:${type};base64,${Buffer.from(body).toString("base64")}`;
    return html(name, IMAGE_STYLE, `<div class="image"><img src="${src}" alt="${Bun.escapeHTML(name)}"></div>`);
  }
  const media = mediaKind(type, name);
  if (media) return mediaDocument(url, name, type || media, media, body.byteLength);
  const kind = previewKind(name, type);
  if (kind && body.byteLength <= PRETTY_LIMIT) return previewDocument(url, name, kind, decode(body, charset));
  // Everything else is shown as text, whatever the bytes are: no file is unviewable.
  const note = kind
    ? `Too large to pretty-print quickly (${formatSize(body.byteLength)})${body.byteLength > DISPLAY_LIMIT ? `; showing the first ${formatSize(DISPLAY_LIMIT)}` : ""}.`
    : body.byteLength > DISPLAY_LIMIT ? `Large file (${formatSize(body.byteLength)}); showing the first ${formatSize(DISPLAY_LIMIT)}.` : null;
  const shown = body.byteLength > DISPLAY_LIMIT ? body.subarray(0, DISPLAY_LIMIT) : body;
  const bar = `<div class="bar"><span>${note ? `${note} The whole file: casty's <code>download</code> (Ctrl+E).` : ""}</span>${downloadButton(url)}</div>`;
  return html(name, TEXT_STYLE, `${bar}<pre>${Bun.escapeHTML(decode(shown, charset))}</pre>`);
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

// Media the renderer's decoder (wasmpeg's FFmpeg) handles: by type, or by
// extension when the server's type says nothing.
const VIDEO_TYPES = new Set(["application/ogg", "application/mp4", "application/x-matroska", "application/mxf"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm", "mkv", "avi", "ogv", "ogg", "ts", "mts", "m2ts",
  "mpg", "mpeg", "3gp", "3g2", "wmv", "flv", "mxf", "y4m"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "flac", "oga", "opus", "m4a", "aac", "wma", "aiff", "aif", "amr", "ac3", "mka"]);

/** "video", "audio" or null. */
function mediaKind(type, name) {
  if (type.startsWith("video/") || VIDEO_TYPES.has(type)) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (!["", "application/octet-stream", "binary/octet-stream"].includes(type)) return null;
  const ext = extension(name);
  return VIDEO_EXTENSIONS.has(ext) ? "video" : AUDIO_EXTENSIONS.has(ext) ? "audio" : null;
}

/** A media document (HTML §7.4.6): the element alone, playing the URL itself. */
function mediaDocument(url, name, type, kind, size) {
  const src = Bun.escapeHTML(url);
  const about = `${Bun.escapeHTML(name)} (${Bun.escapeHTML(type)}, ${size} bytes)`;
  const element = kind === "video"
    ? `<video controls autoplay src="${src}"></video><p class="note">${about}. Click the video to play.</p>`
    : `<audio controls src="${src}"></audio><p class="note">${about}. Click to play; `
      + "sound goes to a PulseAudio server on 127.0.0.1:4713, such as jspulse.</p>";
  return html(name, IMAGE_STYLE, `<div class="image">${element}</div>`);
}

/** bunmsh serve's preview (its previewResponse), under a Pretty-print checkbox over the text as sent. */
function previewDocument(url, name, kind, source) {
  const raw = (hidden) => `<pre id="raw"${hidden ? " hidden" : ""}>${Bun.escapeHTML(source)}</pre>`;
  const parser = PARSERS.get(kind);
  const previewer = kind === "md" ? MARKDOWN : parser.name;
  let formatted;
  try {
    formatted = kind === "md"
      ? `<div id="formatted">${Bun.markdown.html(source, { headings: true })}</div>`
      : `<pre id="formatted"><code>${highlightJson(pretty(parser.parse(source)))}</code></pre>`;
  } catch (error) {
    return html(`Cannot preview ${name}`, TEXT_STYLE, `<div class="bar"><span></span>${downloadButton(url)}</div><h1>Cannot preview ${Bun.escapeHTML(name)}</h1>`
      + `<pre>${Bun.escapeHTML(error?.stack ?? String(error))}</pre>${raw(false)}`);
  }
  return html(`${name} — ${previewer}`, TEXT_STYLE, `<div class="bar"><span><label><input type="checkbox" id="pretty-print" checked> Pretty-print</label>`
    + ` <span class="note">(${previewer})</span></span>${downloadButton(url)}</div>${formatted}${raw(true)}`
    + `<script>(() => {
  const box = document.getElementById("pretty-print");
  const show = () => {
    document.getElementById("formatted").hidden = !box.checked;
    document.getElementById("raw").hidden = box.checked;
  };
  box.addEventListener("change", show);
})();</script>`);
}

function downloadButton(url) {
  return `<a class="download" href="${Bun.escapeHTML(url)}" download>Download</a>`;
}

// Centered in the viewport both ways, as browsers show a standalone image.
const IMAGE_STYLE = `body { margin: 0; background: #0e0e0e }
.image { min-height: 100vh; display: flex; align-items: center; justify-content: center }
.image { flex-direction: column }
.image img, .image svg { max-width: 100%; height: auto; background: white }
.image video { max-width: 100% }
.image .note { color: #bbb; font-family: sans-serif; font-size: 13px }`;
// The link style and highlight colors are bunmsh serve's.
const TEXT_STYLE = `:root { color-scheme: light dark }
body { margin: 8px }
a { color: inherit; text-decoration: none }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: monospace }
code { font: inherit }
.bar { display: flex; justify-content: space-between; align-items: center; gap: 16px; font-family: sans-serif; margin-bottom: 8px }
.download { margin-left: auto; padding: 4px 9px; border: 1px solid currentColor; border-radius: 4px; white-space: nowrap }
.note { font-family: sans-serif; color: #666 }
.json-statement { color: #b0005a }
.json-string { color: #6b5d00 }
.json-special { color: #087f5b }
.json-number, .json-constant { color: #5f3dc4 }
@media (prefers-color-scheme: dark) {
  .json-statement { color: #f92672 }
  .json-string { color: #e6db74 }
  .json-special { color: #a6e22e }
  .json-number, .json-constant { color: #ae81ff }
}`;

function html(title, style, body) {
  return {
    source: `<!doctype html><html><head><meta charset="utf-8"><title>${Bun.escapeHTML(title)}</title>`
      + `<style>${style}</style></head><body>${body}</body></html>`,
    contentType: "text/html",
  };
}

// bunmsh serve.js pretty(): BigInts (TOML integers) keep their digits as "123n".
const pretty = (value) => {
  try {
    return JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? `${item}n` : item, 2) ?? String(value);
  } catch {
    return Bun.inspect(value, { colors: false, depth: Infinity });
  }
};

// bunmsh serve.js highlightJson(): statement keys, strings and escapes,
// numbers, and true/false/null constants of the JSON pretty() emits.
export const highlightJson = (source) => {
  const input = String(source);
  const token = /"(?:\\(?:u[\da-fA-F]{4}|.)|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g;
  let output = "", cursor = 0, match;
  const stringHtml = (value) => {
    let html = "", offset = 0;
    for (const escape of value.matchAll(/\\(?:u[\da-fA-F]{4}|.)/g)) {
      html += Bun.escapeHTML(value.slice(offset, escape.index));
      html += `<span class="json-special">${Bun.escapeHTML(escape[0])}</span>`;
      offset = escape.index + escape[0].length;
    }
    return html + Bun.escapeHTML(value.slice(offset));
  };
  while ((match = token.exec(input))) {
    output += Bun.escapeHTML(input.slice(cursor, match.index));
    const value = match[0];
    let end = token.lastIndex;
    if (value.startsWith('"')) {
      const propertyEnd = /^\s*:/.exec(input.slice(end));
      if (propertyEnd) {
        end += propertyEnd[0].length;
        output += `<span class="json-statement">${Bun.escapeHTML(input.slice(match.index, end))}</span>`;
      } else {
        output += `<span class="json-string">${stringHtml(value)}</span>`;
      }
    } else if (value === "true" || value === "false" || value === "null") {
      output += `<span class="json-constant">${value}</span>`;
    } else {
      output += `<span class="json-number">${value}</span>`;
    }
    cursor = end;
    token.lastIndex = end;
  }
  return output + Bun.escapeHTML(input.slice(cursor));
};

export function parseContentType(value) {
  const [type = "", ...parameters] = String(value).split(";");
  const charset = parameters.map((part) => part.trim().match(/^charset=["']?([^"';]+)/i)?.[1]).find(Boolean) ?? null;
  return { type: type.trim().toLowerCase(), charset };
}

function decode(body, charset) {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder().decode(body);
  }
}

function fileName(url) {
  try {
    const segment = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(segment) || new URL(url).hostname || url;
  } catch {
    return String(url);
  }
}

function extension(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function stripProlog(svg) {
  return svg.replace(/^\s*<\?xml[^>]*>\s*/i, "").replace(/<!DOCTYPE[^>]*>\s*/i, "");
}

function looksLikeHtml(body) {
  const head = new TextDecoder().decode(body.subarray(0, 512)).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<head") || head.startsWith("<body") || head === "";
}
