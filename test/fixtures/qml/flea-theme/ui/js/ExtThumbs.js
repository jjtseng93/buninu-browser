.pragma library

.import "Thumbs.js" as Thumbs
.import "Format.js" as Format

// The ExtThumbs board's storage-class gate: network shares and phones are off, USB
// drives are on, and anything else is local and always gets thumbnails. A class is
// src/backend/extclass.rs's own word, carried beside the fsinfo line once per
// directory change, so nothing here classifies and there is no second classifier.

// Whole sentences with "%1" for a value, filled by fill so each translates as one; one per state.
var WORDS = {
    hide: "Hide %1 thumbnails",
    show: "Show %1 thumbnails",
    isOn: "%1 thumbnails are on",
    isOff: "%1 thumbnails are off"
}

// Sample input: "network" answers "thumbNetwork", "" answers "".
function keyForClass(storageClass) {
    if (storageClass === "network") return "thumbNetwork"
    if (storageClass === "phone") return "thumbPhone"
    if (storageClass === "usb") return "thumbUsb"
    return ""
}

// The menu row is present only on network, phone or USB storage, never locally.
function present(storageClass) {
    return keyForClass(storageClass) !== ""
}

// Sample input: ("usb", {}) answers true, ("network", {}) answers false.
function classOn(storageClass, preview) {
    var key = keyForClass(storageClass)
    if (key === "") return true
    if (key === "thumbUsb") return !preview || preview.thumbUsb !== false
    return !!preview && preview[key] === true
}

function classOff(storageClass, preview) {
    return present(storageClass) && !classOn(storageClass, preview)
}

// Off is cache-only, not blank: a visible row still asks, and the backend answers from
// the shared cache with one stat and never starts a decoder. Thumbnails already made
// still show, because the cache answers them. Sample input: ("network", {}) answers true.
function cacheOnly(storageClass, preview) {
    if (!classOff(storageClass, preview)) return false
    return !preview || preview.thumbnails !== "off"
}

// The thumbed line's record: a cache-only miss on a generating class returns to unasked, any other reply is remembered.
function thumbReply(state, row, file, cap, known, storageClass, preview) {
    if (file === "" && state.file[row] === Thumbs.CACHE_ASKED && (!known || !cacheOnly(storageClass, preview)))
        return { state: Thumbs.miss(state, row, true, cap), missed: true }
    return { state: Thumbs.remember(state, row, file, cap), missed: false }
}

// In Columns the preview is manual on a class that is off: one condition, two surfaces.
function manualHold(storageClass, preview) {
    return cacheOnly(storageClass, preview)
}

// The menu row's own entrance: absent off the three classes, otherwise labelled for
// the class and its state. Sample input: ({storageClass: "usb"}) answers "Hide USB thumbnails".
function entry(e, p) {
    if (!present(p.storageClass)) return false
    e.label = label(p.storageClass, classOn(p.storageClass, p.thumbPreview))
    return true
}

// Sample input: ("network", false) answers "Show network thumbnails".
function label(storageClass, on) {
    var noun = storageClass === "usb" ? "USB" : storageClass
    return Format.fill(on ? WORDS.hide : WORDS.show, noun)
}

// The status bar's own verdict for the toggle, in the board's words.
// Sample input: ("network", true) answers "Network thumbnails are on".
function statusLine(storageClass, on) {
    var noun = storageClass === "usb" ? "USB"
        : storageClass.charAt(0).toUpperCase() + storageClass.slice(1)
    return Format.fill(on ? WORDS.isOn : WORDS.isOff, noun)
}

// A class switched on decodes again: only its cache-only marks leave the map, so a
// real refusal stays answered and is never decoded twice. Sample input:
// {file: {3: "", 4: "/c/x.png", 5: "cache-missed"}, order: [3, 4, 5]} forgets 5 alone.
function forgetMisses(state) {
    var kept = []
    for (var i = 0; i < state.order.length; i++) {
        var at = state.order[i]
        if (state.file[at] === Thumbs.CACHE_MISS || state.file[at] === Thumbs.CACHE_ASKED) delete state.file[at]
        else kept.push(at)
    }
    state.order = kept
    return { file: state.file, order: state.order }
}

// Sample input: ("network", {}) answers "only|media"; a zoom step or another class keeps it, so refreshes nothing.
function verdict(storageClass, preview) {
    var mode = preview && preview.thumbnails ? preview.thumbnails : "media"
    return (cacheOnly(storageClass, preview) ? "only" : "full") + "|" + mode
}

// FileView reads the whole file, so a row over the gate is refused, not truncated, the
// same rule ui/PreviewText.qml already keeps. Text previews on network and phone storage
// read at most the first 256 KiB. Sample input: ("phone") answers 262144.
var TEXT_PREVIEW_MAX = 1048576
var REMOTE_TEXT_PREVIEW_MAX = 262144

function textLimit(storageClass) {
    if (storageClass === "network" || storageClass === "phone") return REMOTE_TEXT_PREVIEW_MAX
    return TEXT_PREVIEW_MAX
}
