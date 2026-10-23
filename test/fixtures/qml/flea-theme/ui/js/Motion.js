.pragma library

// The structural transitions use OutCubic, 180 ms to reveal and 140 ms to hide.

var durMs = {
    // A reveal reads slower than a hide.
    open: 180,
    close: 140
}

// Open rises into place from this far below its resting position; close does not translate,
// opacity only (see the Preview/ShareBrowser/NetworkDialog verticalCenterOffset/y bindings).
var translateUpPx = 10

// How long the pointer rests at the left edge before the auto-hidden rail opens; the OEM bar holds its centre peek 120 ms (Bar.qml:834).
var dwellMs = 120
