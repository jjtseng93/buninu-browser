// Web fonts belong to the document. Built-in typefaces are shared native
// references: registering their byte buffers again would copy tens of MB for
// every document and iframe.
const encoder = new TextEncoder();
const MAX_FONT_BYTES = 32 * 1024 * 1024;
const MAX_RANKED_FONT_CHOICES = 128;

export function registerTypeface(CanvasKit, provider, typeface, family) {
  const bytes = encoder.encode(`${family}\0`);
  const memory = CanvasKit.Malloc(Uint8Array, bytes.length);
  try {
    memory.toTypedArray().set(bytes);
    // This is the entry point the bundled registerFont(bytes, family) uses
    // after creating a Typeface. Skia retains the typeface and copies the name.
    provider._registerFont(typeface, memory.byteOffset);
  } finally {
    CanvasKit.Free(memory);
  }
}

function styleRank(face, wanted) {
  const order = wanted === "italic" ? ["italic", "oblique", "normal"]
    : wanted === "oblique" ? ["oblique", "italic", "normal"] : ["normal", "oblique", "italic"];
  return order.indexOf(face.style ?? "normal");
}

/** CSS Fonts weight fallback order, including the special 400..500 interval. */
function weightRank(face, wanted) {
  const [low, high] = face.weight ?? [400, 400];
  if (low <= wanted && wanted <= high) return 0;
  if (wanted >= 400 && wanted <= 500) {
    if (low > wanted && low <= 500) return low - wanted;
    if (high < wanted) return 1000 + wanted - high;
    return 2000 + low - wanted;
  }
  if (wanted < 400) return high < wanted ? wanted - high : 1000 + low - wanted;
  return low > wanted ? low - wanted : 1000 + wanted - high;
}

function covers(face, point) {
  const ranges = face.unicodeRanges;
  if (!ranges) return 0 <= point && point <= 0x10ffff;
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index];
    if (range[0] <= point && point <= range[1]) return true;
  }
  return false;
}

function stretchRank(face, wanted) {
  const [low, high] = face.stretch ?? [100, 100];
  if (low <= wanted && wanted <= high) return 0;
  if (wanted <= 100) return high < wanted ? wanted - high : 1000 + low - wanted;
  return low > wanted ? low - wanted : 1000 + wanted - high;
}

function ranked(faces, weight, style, stretch = 100) {
  return faces.toReversed().sort((left, right) => stretchRank(left, stretch) - stretchRank(right, stretch)
    || styleRank(left, style) - styleRank(right, style)
    || weightRank(left, weight) - weightRank(right, weight));
}

/** Only request faces needed by text which actually participates in layout. */
export function neededFontFaces(faces, textRuns, availableFamilies = new Set()) {
  const families = new Map();
  for (const face of faces) {
    const key = face.family.toLowerCase();
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(face);
  }
  return neededFacesFromIndex(families, new Map(), textRuns, availableFamilies);
}

function orderedFontFaces(families, choices, name, weight, style, stretch) {
  const definitions = families.get(name);
  if (!definitions) return null;
  const key = JSON.stringify([name, weight, style, stretch]);
  let ordered = choices.get(key);
  if (!ordered) {
    // Ranking is independent of Unicode coverage; stable sorting preserves
    // the CSS face order even when a character filters out other subsets.
    ordered = ranked(definitions, weight, style, stretch);
    if (choices.size >= MAX_RANKED_FONT_CHOICES) choices.clear();
    choices.set(key, ordered);
  }
  return ordered;
}

function neededFacesFromIndex(families, choices, textRuns, availableFamilies) {
  const needed = new Set();
  for (const { text, style } of textRuns) {
    if (!text || !style) continue;
    const points = new Set([...text].map(character => character.codePointAt(0)));
    for (const family of style.fontFamily ?? []) {
      const name = family.toLowerCase();
      const ordered = orderedFontFaces(families, choices, name,
        style.fontWeight ?? 400, style.fontStyle ?? "normal", style.fontStretch ?? 100);
      if (!ordered) {
        if (availableFamilies.has(name)) break;
        continue;
      }
      for (const point of points) {
        const face = ordered.find(face => covers(face, point));
        if (face) { needed.add(face); points.delete(point); }
      }
      if (!points.size) break;
    }
  }
  return needed;
}

export class DocumentFonts {
  #CanvasKit;
  #builtins;
  #defaultCollection;
  #fetch;
  #changed;
  #error;
  #provider = null;
  #collection = null;
  #families = new Map();
  #faceKeys = new WeakMap();
  #rankedFaces = new Map();
  #records = new Map();
  #sources = new Map();
  #pending = new Set();
  #requests = new Set();
  #closed = false;
  #nextAlias = 1;
  #availableFamilies;
  #hasUnicodeRanges = false;

  constructor({ CanvasKit, builtins, defaultCollection, fetch, availableFamilies = new Set(), changed = () => {}, error = () => {} }) {
    this.#CanvasKit = CanvasKit;
    this.#builtins = builtins;
    this.#defaultCollection = defaultCollection;
    this.#fetch = fetch;
    this.#changed = changed;
    this.#error = error;
    this.#availableFamilies = availableFamilies;
  }

  get collection() { return this.#collection ?? this.#defaultCollection; }

  get hasUnicodeRanges() { return this.#hasUnicodeRanges; }

  setFaces(faces) {
    this.#families.clear();
    this.#faceKeys = new WeakMap();
    this.#rankedFaces.clear();
    for (const face of faces) {
      const family = face.family.toLowerCase();
      let definitions = this.#families.get(family);
      if (!definitions) this.#families.set(family, definitions = []);
      definitions.push(face);
      this.#faceKeys.set(face, JSON.stringify(face));
    }
    this.#hasUnicodeRanges = faces.some(face => face.unicodeRanges?.length
      && !(face.unicodeRanges.length === 1 && face.unicodeRanges[0][0] === 0 && face.unicodeRanges[0][1] === 0x10ffff));
  }

  update(faces, textRuns) {
    if (this.#closed) return;
    this.setFaces(faces);
    for (const face of neededFacesFromIndex(this.#families, this.#rankedFaces, textRuns, this.#availableFamilies)) {
      const key = this.#faceKeys.get(face);
      if (this.#records.has(key)) continue;
      const record = { face, alias: null };
      this.#records.set(key, record);
      const pending = this.#load(record).catch(error => {
        if (!this.#closed) this.#error(error);
      }).finally(() => this.#pending.delete(pending));
      this.#pending.add(pending);
    }
  }

  /** Available faces in CSS fallback order; unicode-subset files share a family. */
  resolve(family, weight = 400, style = "normal", point = null, stretch = 100) {
    const ordered = orderedFontFaces(this.#families, this.#rankedFaces, family.toLowerCase(), weight, style, stretch);
    if (!ordered) return [];
    const aliases = [];
    for (const face of ordered) {
      if (point !== null && !covers(face, point)) continue;
      // Read the live record: a face may finish loading after it was ranked.
      const alias = this.#records.get(this.#faceKeys.get(face))?.alias;
      if (alias) aliases.push(alias);
    }
    return aliases;
  }

  async ready() {
    while (!this.#closed && this.#pending.size) await Promise.all([...this.#pending]);
  }

  #ensureProvider() {
    if (this.#provider) return;
    const kit = this.#CanvasKit;
    this.#provider = kit.TypefaceFontProvider.Make();
    for (const { family, typeface } of this.#builtins) registerTypeface(kit, this.#provider, typeface, family);
    this.#collection = kit.FontCollection.Make();
    this.#collection.setDefaultFontManager(this.#provider);
    this.#collection.enableFontFallback();
  }

  async #load(record) {
    let failure;
    for (const source of record.face.sources) {
      if (this.#closed) return;
      try {
        let typeface;
        if (source.local) {
          typeface = this.#builtins.find(entry => entry.family.toLowerCase() === source.local.toLowerCase())?.typeface;
          if (!typeface) continue;
        } else {
          if (!source.url || (source.format && !/^(?:woff2?|truetype|opentype)(?:-variations)?$/i.test(source.format))) continue;
          let pending = this.#sources.get(source.url);
          if (!pending) {
            pending = this.#loadSource(source.url);
            this.#sources.set(source.url, pending);
          }
          typeface = await pending;
          if (this.#closed) return;
        }
        this.#ensureProvider();
        const alias = `Buninu Web Font ${this.#nextAlias++}`;
        registerTypeface(this.#CanvasKit, this.#provider, typeface, alias);
        record.alias = alias;
        this.#changed();
        return;
      } catch (error) { failure = error; }
    }
    if (failure) throw failure;
  }

  async #loadSource(url) {
    // Fonts use CORS even though images and classic stylesheets normally do
    // not. This goes through the controller's existing page-fetch policy.
    const request = this.#fetch({ url, method: "GET", headers: [], body: null,
      mode: "cors", credentials: "same-origin", redirect: "follow" });
    this.#requests.add(request);
    try {
      const response = await request;
      if (this.#closed) return null;
      if (response.status < 200 || response.status >= 300) throw new Error(`Font HTTP ${response.status}`);
      const bytes = response.body instanceof Uint8Array ? response.body : await Bun.readableStreamToBytes(response.body);
      if (this.#closed) return null;
      if (!bytes.length || bytes.length > MAX_FONT_BYTES) throw new Error("Font size exceeds the renderer limit");
      const typeface = this.#CanvasKit.Typeface.MakeTypefaceFromData(bytes);
      if (!typeface) throw new Error("Font decoding failed");
      return typeface;
    } finally {
      this.#requests.delete(request);
    }
  }

  dispose() {
    if (this.#closed) return;
    this.#closed = true;
    for (const request of this.#requests) request.abort?.();
    this.#requests.clear();
    this.#collection?.delete();
    this.#provider?.delete();
    this.#collection = this.#provider = null;
    for (const source of this.#sources.values()) source.then(typeface => typeface?.delete(), () => {});
    this.#sources.clear();
    this.#records.clear();
    this.#families.clear();
    this.#faceKeys = new WeakMap();
    this.#rankedFaces.clear();
  }
}
