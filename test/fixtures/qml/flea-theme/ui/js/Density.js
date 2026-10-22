.pragma library

// One job: the numbers every surface draws from, so tests/js/density.js pins them.

// The four stops in the board's own order, Tight first as the opt-in below Compact.
var STOPS = ["tight", "compact", "normal", "comfortable"]
var LABELS = ["Tight", "Compact", "Normal", "Comfortable"]

// Tight drops the padding, Compact keeps half, Normal keeps all, Comfortable one half more.
var RATIOS = ({ tight: 0, compact: 0.5, normal: 1, comfortable: 1.5 })

// Sample input: ratioFor("tight") is 0, ratioFor("nope") is 0.5.
function ratioFor(density) {
    return RATIOS[density] !== undefined ? RATIOS[density] : 0.5
}

// Sample input: rowHeight(23, 7, "tight") is 23, the line box with no padding.
function rowHeight(lineBox, rowPaddingY, density) {
    return lineBox + 2 * Math.round(rowPaddingY * ratioFor(density))
}

// The six thumbnail stops in the board's walk order, Small 48 to Largest 256.
var THUMB_SIZES = ({ small: 48, medium: 64, large: 96, xlarge: 128, huge: 192, largest: 256 })

// Sample input: thumbPixelsFor("huge") is 192, thumbPixelsFor("nope") is 64.
function thumbPixelsFor(size) {
    return THUMB_SIZES[size] !== undefined ? THUMB_SIZES[size] : 64
}

// A folder mark never grows past its 128 px size, centred in the larger slots.
var GLYPH_CAP = 128

// Sample input: glyphCap(192) is 128, glyphCap(48) is 48.
function glyphCap(pixels) {
    return Math.min(pixels, GLYPH_CAP)
}

// The grid's vertical pad tracks density with Compact anchored at today's pad.
var GRID_BASE = 0.5

// Sample input: gridPadY(14, "compact") is 14, gridPadY(14, "tight") is 7.
function gridPadY(padX, density) {
    return Math.round(padX * (GRID_BASE + ratioFor(density)))
}
