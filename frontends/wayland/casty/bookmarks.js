// Bookmarks
// Reads ~/.casty/bookmarks.json, searchable via /b in the address bar

import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadJsonFile } from './config.js';

const bookmarkPath = join(homedir(), '.casty', 'bookmarks.json');

// Load bookmarks (normalized to [{ name, url }, ...])
export function loadBookmarks() {
  const data = loadJsonFile(bookmarkPath, []);
  // { "name": "url", ... } object format
  if (!Array.isArray(data) && typeof data === 'object') {
    return Object.entries(data).map(([name, url]) => ({ name, url }));
  }
  // [{ name, url }, ...] array format
  if (Array.isArray(data)) {
    return data.filter(e => e.name && e.url);
  }
  return [];
}

// Search bookmarks by query (case-insensitive partial match on name/URL)
export function searchBookmarks(query) {
  const bookmarks = loadBookmarks();
  if (!query) return bookmarks;
  const q = query.toLowerCase();
  return bookmarks.filter(b =>
    b.name.toLowerCase().includes(q) || b.url.toLowerCase().includes(q)
  );
}
