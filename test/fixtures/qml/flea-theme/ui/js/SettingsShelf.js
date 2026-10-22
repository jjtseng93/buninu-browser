.pragma library

// The Settings panel's Shelf section, SettingsRest rules 1 to 4 and ledger directive 59. It lives
// beside Settings.js rather than in it: the section owns the shelf's switches, the bar plugin reads
// them from ui.json, and the pins are the shelf's own entries the panel is handed.

// `choice` is handed in because this library cannot import the one that imports it.
function rows(state, choice) {
    var data = (state.data || {}).shelf || {}
    var on = data.enabled === true
    var out = [{ kind: "group", label: "Shelf", id: "shelf.enabled", master: true,
                  state: on ? "all" : "none", value: on ? "on" : "off" }]
    out.push({ kind: "check", id: "shelf.bar", label: "Show in bar", mark: "flea",
                available: on, on: data.bar !== false })
    out.push(choice("shelf.rail", "Edge rail", "maximize", ["off", "left", "right", "bottom"],
                     ["Off", "Left", "Right", "Bottom"], railEdge(data.rail)))
    out[out.length - 1].available = on
    // The board's own sentence, second half included: the bind is the user's line in hyprland's
    // config and nothing here installs it.
    out.push({ kind: "hint", label: "Super+D opens it from anywhere once you add the bind from the README." })
    out.push({ kind: "group", label: "Recent captures" })
    out.push({ kind: "check", id: "shelf.screenshots", label: "Screenshots", glyph: "image",
                available: on, on: data.screenshots !== false })
    out.push({ kind: "check", id: "shelf.recordings", label: "Recordings", glyph: "film",
                available: on, on: data.recordings !== false })
    out.push(choice("shelf.recent", "Show", "list", CAPTURE_COUNTS, ["1", "2", "3", "5"],
                     captureCount(data.recent)))
    out[out.length - 1].available = on
    out.push({ kind: "group", label: "Pinned", id: "pinFolder", action: "pinFolder",
                value: "Pin this folder" })
    var pins = state.pins || []
    for (var i = 0; i < pins.length; i++) {
        out.push({ kind: "favourite", id: "pin:" + i, label: pins[i].name, value: pins[i].path,
                    glyph: pins[i].folder ? "folder" : "file", pinPath: pins[i].path,
                    pinIndex: i, pinCount: pins.length,
                    available: on, error: pins[i].missing === true ? "missing" : "" })
    }
    return out
}

// The four the board offers, and the fallback for a count a hand-edited file left behind.
var CAPTURE_COUNTS = [1, 2, 3, 5]

function captureCount(value) {
    var n = Number(value)
    return CAPTURE_COUNTS.indexOf(n) >= 0 ? n : 3
}

function railEdge(value) {
    var edges = ["off", "left", "right", "bottom"]
    return edges.indexOf(String(value)) >= 0 ? String(value) : "off"
}
