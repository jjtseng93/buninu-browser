import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { isAbsolute, join } from "node:path";
import { homeDirectory } from "../home-directory.js";

const ENTRY_LIMIT = 96 * 1024 * 1024;
const COMPRESSED = 4;
const compressionOptions = {params:{[constants.ZSTD_c_compressionLevel]:1}};
const COMPRESSION_THRESHOLD = 256 * 1024;
const CACHE_LIMIT = 256 * 1024 * 1024;
const isEntry = name => /^[a-f0-9]{64}$/.test(name);

export function scriptCacheDirectory() {
  const home = homeDirectory();
  const root = process.platform === "win32" ? process.env.LOCALAPPDATA || (home && join(home, "AppData", "Local"))
    : process.platform === "darwin" ? home && join(home, "Library", "Caches")
    : process.env.XDG_CACHE_HOME && isAbsolute(process.env.XDG_CACHE_HOME) ? process.env.XDG_CACHE_HOME
    : home && join(home, ".cache");
  return root && isAbsolute(root) ? join(root, "buninu-browser", "scripts") : null;
}

// Include the implementation as well as the format so checkouts with the same
// package version cannot reuse code produced by a different transformation.
export function scriptCacheVersion() {
  const hash = new Bun.CryptoHasher("sha256").update("classic-v1\0" + Bun.version);
  for (const file of ["./script-rewrite.js", "./prepared-script-cache.js", "../../vendor/acorn/dist/acorn.mjs"]) {
    hash.update(readFileSync(new URL(file, import.meta.url)));
  }
  return hash.digest("hex");
}

function trim(directory, limit) {
  const entries = [];
  let total = 0;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (!isEntry(name)) {
      // A process killed between write and rename can leave a partial file.
      if (/^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(name) &&
          Date.now() - (statSync(path, {throwIfNoEntry:false})?.mtimeMs ?? Date.now()) > 86400000) {
        try { unlinkSync(path); } catch {}
      }
      continue;
    }
    const stat = statSync(path, {throwIfNoEntry:false});
    if (!stat?.isFile()) continue;
    entries.push({path, stat});
    total += stat.size;
  }
  if (total <= limit) return;
  entries.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
  for (const {path, stat} of entries) {
    try { unlinkSync(path); } catch { continue; }
    total -= stat.size;
    if (total <= limit) break;
  }
}

// Only called on the controller's preparation worker. Its input is the body
// received by the network service. Neither paths nor prepared code come from
// a page. Disk errors always leave the ordinary preparation path usable.
export function prepareDiskCached(bytes, directory, version, prepare, limit = CACHE_LIMIT) {
  const compile = () => prepare(new TextDecoder().decode(bytes));
  if (!directory) return compile();
  const key = new Bun.CryptoHasher("sha256").update(version).update(bytes).digest("hex");
  const path = join(directory, key);
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size >= 5 && size <= ENTRY_LIMIT) {
      const entry = readFileSync(fd);
      const flags = entry[0];
      const length = entry.readUInt32LE(1) * 2;
      if (flags < 8 && length <= ENTRY_LIMIT - 5) {
        const payload = entry.subarray(5);
        const raw = flags & COMPRESSED
          ? zstdDecompressSync(payload, {maxOutputLength: Math.max(1, length)})
          : payload;
        if (raw.length === length) {
          return {code:raw.toString("utf16le"), parsed:!!(flags & 1), strict:!!(flags & 2)};
        }
      }
    }
  } catch {} finally { if (fd !== undefined) closeSync(fd); }

  const result = compile();
  const size = 5 + result.code.length * 2;
  if (size > ENTRY_LIMIT) return result;
  const temporary = path + "." + crypto.randomUUID() + ".tmp";
  try {
    mkdirSync(directory, {recursive:true, mode:0o700});
    const raw = Buffer.from(result.code, "utf16le");
    const compressed = size >= COMPRESSION_THRESHOLD ? zstdCompressSync(raw, compressionOptions) : null;
    const payload = compressed && compressed.length < raw.length ? compressed : raw;
    if (payload.length + 5 > limit) return result;
    const entry = Buffer.allocUnsafe(payload.length + 5);
    entry[0] = Number(result.parsed) | (Number(result.strict) << 1) | (payload === raw ? 0 : COMPRESSED);
    entry.writeUInt32LE(result.code.length, 1);
    payload.copy(entry, 5);
    writeFileSync(temporary, entry, {flag:"wx", mode:0o600});
    renameSync(temporary, path);
    trim(directory, limit);
  } catch {} finally {
    try { unlinkSync(temporary); } catch {}
  }
  return result;
}
