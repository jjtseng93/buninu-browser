.pragma library

// Delete carries DEL through libxkbcommon; retain SheetQuery's single-character semantics.
function isPrintable(text) {
    var s = String(text || "")
    return s.length === 1 && s >= " " && s !== "\u007f"
}

// Issue 287's paste chords, matched on the four real modifiers the way ui/js/Keymap.js matches keys.
function isPasteKey(event) {
    var mods = event.modifiers & (Qt.ControlModifier | Qt.ShiftModifier | Qt.AltModifier | Qt.MetaModifier)
    return (event.key === Qt.Key_V && mods === Qt.ControlModifier)
        || (event.key === Qt.Key_Insert && mods === Qt.ShiftModifier)
}

// The clipboard's first line, keeping printable characters and whole surrogate pairs only.
function cleanPaste(text) {
    var line = String(text || "").split(/\r\n|[\r\n]/)[0]
    var out = ""
    for (var i = 0; i < line.length; i++) {
        var code = line.charCodeAt(i)
        var low = i + 1 < line.length ? line.charCodeAt(i + 1) : 0
        if (code >= 0xd800 && code <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
            out += line.substr(i, 2)
            i++
        } else if ((code < 0xd800 || code > 0xdfff) && isPrintable(line.charAt(i))) {
            out += line.charAt(i)
        }
    }
    return out
}

// Hands a query line's paste to its own typing route; the chord is consumed even when nothing is left to type.
function pasteInto(host, typeText) {
    var pasted = cleanPaste(host.clipboardText())
    if (pasted.length > 0)
        typeText(pasted)
    return true
}
