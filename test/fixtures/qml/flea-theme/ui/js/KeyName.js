.pragma library

.import "Keymap.js" as Keymap
.import "Format.js" as Format

// A key the way the running preset binds it, spelled for a sentence; the sentences stay in their own modules with a "%1" for the key.

// The names keys.toml gives a key that a person would write as a mark.
var MARKS = { plus: "+", minus: "-", equal: "=", underscore: "_", greater: ">", less: "<", slash: "/", period: ".", comma: "," }
var MODIFIERS = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", super: "Super" }

// Sample input: "ctrl-shift-n" answers "Ctrl+Shift+N"; "delete" answers "Delete"; "ctrl-shift-plus" answers "Ctrl+Shift++".
function spelled(keys) {
    var parts = String(keys).split("-")
    var out = []
    for (var i = 0; i < parts.length; i++) {
        var part = parts[i]
        if (i < parts.length - 1 && MODIFIERS[part] !== undefined) { out.push(MODIFIERS[part]); continue }
        if (MARKS[part] !== undefined) out.push(MARKS[part])
        else if (part.length === 1) out.push(out.length > 0 ? part.toUpperCase() : part)
        else out.push(part.charAt(0).toUpperCase() + part.substring(1))
    }
    return out.join("+")
}

// The row the running preset binds to an action in the listing, the first of the given modifier kind when one is asked for.
function rowFor(action, mods) {
    var rows = Keymap.bindingRows(Keymap.preset, "gui", Keymap.actionGroup(action))
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].action === action && (mods === undefined || rows[i].mods === mods)) return rows[i]
    }
    return null
}

// The key to press for an action: the plain key the menus draw, else the first chord. "" when the preset binds none.
function keyFor(action) {
    var plain = Keymap.hintFor(action)
    if (plain.length > 0) return plain
    var row = rowFor(action)
    return row === null ? "" : spelled(row.keys)
}

// The key of one modifier kind ("none" for a key pressed alone), "" when the preset binds none.
function keyOf(action, mods) {
    var row = rowFor(action, mods)
    return row === null ? "" : spelled(row.keys)
}

// A whole sentence with "%1" for the key bound to an action, "" when the preset binds none so no hint names a missing key.
function hinted(template, action) {
    var key = keyFor(action)
    return key.length > 0 ? Format.fill(template, key) : ""
}

// The same with "%1", "%2" and on for the keys bound to several actions, "" when the preset leaves any one of them unbound.
function hintedAll(template, actions) {
    var keys = [template]
    for (var i = 0; i < actions.length; i++) {
        var key = keyFor(actions[i])
        if (key.length === 0) return ""
        keys.push(key)
    }
    return Format.fill.apply(null, keys)
}
