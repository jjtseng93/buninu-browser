.pragma library

// Sample input: primaryFor("collide") === "keep", isDestructive("trash", "delete") === true.
// Variant A: one control for every dialog button, sized by Theme, primary is the safe Enter action.

// The members of a set (the protocols) sit this many hairlines apart, 4 px at base size 14.
var SET_GAP = 4
// The segments of a settings chooser sit this many hairlines apart, 2 px at base size 14.
var SEGMENT_GAP = 2
// A focused control whose foreground hairline would match its rest draws its own frame this wide, inward.
var RING = 2
var DISABLED_OPACITY = 0.55
// The pointer's wash and the press wash, laid in the control's own ink.
var WASH_HOVER = 0.08
var WASH_PRESS = 0.14
// A primary's resting accent wash, at the press wash's weight.
var WASH_PRIMARY = WASH_PRESS
// Chrome marks scale by this factor; dialog buttons inset only their frame and wash by whole pixels.
var PRESS_SCALE = 0.96
var PRESS_MS = 150

// One primary per dialog, fixed: it never moves with focus.
var PRIMARY = {
    trash: "cancel",
    collide: "keep",
    openWith: "open",
    convert: "convert",
    newFile: "create",
    moveTo: "move",
    copyTo: "copy",
    network: "action",
    permissions: "apply",
    picker: "accept"
}

// A destructive action rests as the error label in a muted frame, never primary.
var DESTRUCTIVE = {
    trash: { "delete": true },
    collide: { "replace": true },
    picker: { "replace": true }
}

// Sample input: focusFrame(true, false, false) === "foreground", focusFrame(true, false, true) === "thick", focusFrame(false, false, true) === "thick", focusFrame(true, true, true) === "accent", focusFrame(false, true, false) === "thick".
// What a focused control's own frame draws: one foreground hairline, one accent hairline for a set member where the accent has hue, or "thick", RING wide in the foreground, where a hairline would match the rest.
function focusFrame(accentHasHue, setMember, restIsForeground) { return setMember !== true ? (restIsForeground === true ? "thick" : "foreground") : accentHasHue === true ? "accent" : "thick" }

function primaryFor(dialog) {
    return PRIMARY[dialog] || ""
}

function isDestructive(dialog, name) {
    var set = DESTRUCTIVE[dialog] || {}
    return set[name] === true
}
