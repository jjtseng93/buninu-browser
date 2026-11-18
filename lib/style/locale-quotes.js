// ICU 76.1 locale quotation delimiters (Unicode License V3, LICENSES/icu.txt).
// Only overrides of the parent locale are stored; each string is outer then inner.
const overrides = new Map();
for (const [marks, locales] of [
  ["«»«»", "fr hy oc yav"],
  ["«»‘’", "dua ksf nb nn no rw"],
  ["«»“”", "ast blo bm br ca dyo el es-us eu ewo ie it kab kk lij mg mua nnh pt-ao pt-ch pt-cv pt-gq pt-gw pt-lu pt-mo pt-mz pt-pt pt-st pt-tl sc sg sq ti"],
  ["«»”“", "fr-ca"],
  ["«»„“", "bas be cv ky os ru sah uk"],
  ["«»„”", "shi zgh"],
  ["«»‹›", "am az-cyrl fa fr-ch gsw jgo kkj mzn rm wae"],
  ["»«›‹", "ug"],
  ["‘’‘’", "nl"],
  ["‘’“”", "fur ia nso ti-er tn"],
  ["“’“”", "st"],
  ["“”‘’", "ff-adlm uz-arab uz-cyrl yue-hans"],
  ["“”’‘", "uz"],
  ["“”“”", "tk"],
  ["”“’‘", "ar syr ur"],
  ["””’’", "fi he lag rn se sn sv yi"],
  ["„“«»", "ka"],
  ["„“‚‘", "bs-cyrl cs de dsb et hr hsb is ksh lb luy mk nds sk sl"],
  ["„“„“", "bg lt prg"],
  ["„”«»", "nmg pl ro"],
  ["„”»«", "hu szl"],
  ["„”‘’", "bs"],
  ["„”’’", "sr"],
  ["„”‚’", "agq ff"],
  ["「」『』", "ja yue zh-hant"],
]) for (const locale of locales.split(" ")) overrides.set(locale, marks);

export function automaticQuotes(element) {
  for (let node = element; node; node = node.parentElement ?? node.getRootNode?.().host) {
    const language = node.getAttributeNS?.("http://www.w3.org/XML/1998/namespace", "lang") ?? node.getAttribute?.("lang");
    if (language == null) continue;
    if (!language) break;
    try {
      const locale = new Intl.Locale(language);
      const explicit = overrides.get(locale.baseName.toLowerCase());
      if (explicit) return explicit;
      const {language:lang, script, region} = locale.maximize();
      return overrides.get((lang+"-"+script+"-"+region).toLowerCase())
        ?? overrides.get((lang+"-"+script).toLowerCase()) ?? overrides.get(lang) ?? "“”‘’";
    } catch { break; }
  }
  return "“”‘’";
}
