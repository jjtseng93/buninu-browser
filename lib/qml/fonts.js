import {readdir, realpath, stat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {registerTypeface} from '../renderer/font-loading.js';

// Capture before a host-mode document can replace globals/environment.
const directory = process.env.QT_QPA_FONTDIR || '';
const cache = new WeakMap();
const MAX_FILE = 32 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;

// QT_QPA_FONTDIR is one directory, not a PATH-style list. Recursion is our
// extension; canonical paths prevent directory symlink cycles and duplicates.
export async function qmlFontFiles(root, warn = () => {}) {
  const files = [], seen = new Set();
  async function walk(path, depth = 0) {
    if (depth > 16 || seen.size >= 4096) return;
    try {
      path = await realpath(path);
      if (seen.has(path)) return;
      seen.add(path);
      const info = await stat(path);
      if (info.isDirectory()) {
        for (const name of (await readdir(path)).sort()) await walk(join(path, name), depth + 1);
      } else if (info.isFile() && /\.(ttf|otf)$/i.test(path)) files.push({path, size:info.size});
    } catch (error) { warn(`QML font: ${path}: ${error.message}`); }
  }
  if (root) await walk(resolve(root));
  return files.sort((a,b)=>Number(!/regular/i.test(a.path))-Number(!/regular/i.test(b.path)) || a.path.localeCompare(b.path));
}

// One private collection per graphics instance, shared by its local QML pages.
// The ordinary HTML collection and font aliases are never mutated.
export function loadQmlFonts(base, warn = () => {}, root = directory) {
  if (!root) return Promise.resolve(base);
  let roots = cache.get(base);
  if (!roots) cache.set(base, roots = new Map());
  const key = resolve(root);
  if (!roots.has(key)) roots.set(key, build(base, key, warn));
  return roots.get(key);
}
async function build(base, root, warn) {
  const {CanvasKit} = base;
  const extra = [];
  let total = 0;
  for (const file of await qmlFontFiles(root, warn)) {
    if (file.size > MAX_FILE || total + file.size > MAX_TOTAL || extra.length >= 128) {
      warn(`QML font: skipped ${file.path}: font loading limit`);continue;
    }
    try {
      const bytes = await Bun.file(file.path).bytes();
      if (bytes.length > MAX_FILE || total + bytes.length > MAX_TOTAL) continue;
      const typeface = CanvasKit.Typeface.MakeTypefaceFromData(bytes);
      if (!typeface) throw Error('unsupported or invalid font');
      total += bytes.length;
      extra.push({family:`Buninu QML Fallback ${extra.length}`, name:typeface.getFamilyName(), typeface});
    } catch(error) {warn(`QML font: ${file.path}: ${error.message}`);}
  }
  if (!extra.length) return base;
  const provider = CanvasKit.TypefaceFontProvider.Make();
  const builtinTypefaces = [...base.builtinTypefaces, ...extra];
  for (const face of builtinTypefaces) registerTypeface(CanvasKit, provider, face.typeface, face.family);
  const fontCollection = CanvasKit.FontCollection.Make();
  fontCollection.setDefaultFontManager(provider);
  fontCollection.enableFontFallback();
  const loadedFamilies = new Map(base.loadedFamilies);
  for (const face of extra) if (!loadedFamilies.has(face.name.toLowerCase())) loadedFamilies.set(face.name.toLowerCase(), face.family);
  return {...base, fontCollection, loadedFamilies, builtinTypefaces,
    fontFamilies:[...base.fontFamilies, ...extra.map(face=>face.family)]};
}
