import { mkdir, open, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { downloadsDirectory } from "./download-directory.js";

export const DEFAULT_DOWNLOAD_DIR = downloadsDirectory();

export function isAttachment(value) {
  return /^\s*attachment\s*(?:;|$)/i.test(value ?? "");
}

export function suggestedFilename(url, disposition = "", attributeName = "") {
  const encoded = /(?:^|;)\s*filename\*\s*=\s*(?:UTF-8''|utf-8'[^']*')([^;]+)/i.exec(disposition)?.[1];
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(disposition);
  let name = "";
  if (encoded) { try { name = decodeURIComponent(encoded.trim().replace(/^"|"$/g, "")); } catch {} }
  if (!name) name = plain?.[1] ?? plain?.[2]?.trim() ?? attributeName;
  if (!name) {
    const target = new URL(url);
    const segment = target.pathname.split("/").filter(Boolean).at(-1);
    try { name = decodeURIComponent(segment ?? ""); } catch { name = segment ?? ""; }
    if (!name) name = target.hostname || "download";
  }
  name = name.split(/[\\/]/).at(-1).replace(/[<>:"|?*\x00-\x1f\x7f]/g, "_").replace(/^\.+/, "_").replace(/[. ]+$/, "").slice(0, 200);
  return name || "download";
}

/** Save a response stream or already held bytes without replacing an existing file. */
export async function saveDownload({ url, disposition = "", attributeName = "", filename = null, body, dir = DEFAULT_DOWNLOAD_DIR }) {
  await mkdir(dir, { recursive: true });
  const name = filename ?? suggestedFilename(url, disposition, attributeName);
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  let file;
  let path;
  for (let number = 1; ; number++) {
    path = join(dir, number === 1 ? name : `${stem} (${number})${extension}`);
    try { file = await open(path, "wx"); break; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  try {
    let bytes = 0;
    if (body instanceof Uint8Array) {
      bytes = body.byteLength;
      await file.writeFile(body);
    } else if (body) {
      const count = new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.byteLength;
        done(null, chunk);
      } });
      await pipeline(Readable.fromWeb(body), count, file.createWriteStream());
    }
    else await file.close();
    return { path, name: path.slice(dir.length + 1), bytes };
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw error;
  } finally {
    await file.close().catch(() => {});
  }
}
