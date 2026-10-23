// "download" (Ctrl+E): save the current page's document as the browser
// received it, via CDP Page.getResourceContent (Chrome and buninu-browser),
// into the same folder as browser downloads.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { downloadsDirectory } from './download-directory.js';

export const DOWNLOAD_DIR = downloadsDirectory();

// A file name for a URL: its last path segment, else its host; characters
// Windows and POSIX reject become "_", and an HTML page without an extension
// gets ".html".
export function fileNameFor(url, mimeType = '') {
  let name = '';
  let host = 'page';
  try {
    const parsed = new URL(url);
    host = parsed.hostname || host;
    const segment = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    try { name = decodeURIComponent(segment); } catch { name = segment; }
  } catch {}
  // A host name ("example.com") has no file extension of its own.
  const fromHost = !name;
  name = (name || host).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '_').slice(0, 200);
  if ((fromHost || !extname(name)) && /html/i.test(mimeType)) name += '.html';
  return name;
}

// dir/name, or dir/name (2).ext, (3)… when it exists.
export function uniquePath(dir, name, exists = existsSync) {
  const extension = extname(name);
  const base = name.slice(0, name.length - extension.length);
  let candidate = join(dir, name);
  for (let n = 2; exists(candidate); n++) candidate = join(dir, `${base} (${n})${extension}`);
  return candidate;
}

// Saves the main frame's document; returns the path written.
export async function downloadPage(client, dir = DOWNLOAD_DIR) {
  const { frameTree } = await client.send('Page.getFrameTree');
  const { id: frameId, url, mimeType } = frameTree.frame;
  if (!/^(https?|file|data):/.test(url)) throw new Error(`Nothing to download for ${url}`);
  const { content, base64Encoded } = await client.send('Page.getResourceContent', { frameId, url });
  mkdirSync(dir, { recursive: true });
  const path = uniquePath(dir, fileNameFor(url, mimeType));
  writeFileSync(path, base64Encoded ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8'));
  return path;
}
