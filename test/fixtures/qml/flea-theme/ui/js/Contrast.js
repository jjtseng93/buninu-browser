.pragma library

// WCAG 2.1 relative luminance, so a test can assert a ratio rather than an eye judging a screenshot.
function channel(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function luminance(r, g, b) {
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

// Sample input: "#c8ccd0"
function parse(hex) {
    var s = String(hex).replace("#", "")
    if (s.length === 8)
        s = s.substring(2)
    return [parseInt(s.substr(0, 2), 16) / 255,
            parseInt(s.substr(2, 2), 16) / 255,
            parseInt(s.substr(4, 2), 16) / 255]
}

function over(fg, alpha, bg) {
    var f = parse(fg)
    var b = parse(bg)
    return [f[0] * alpha + b[0] * (1 - alpha),
            f[1] * alpha + b[1] * (1 - alpha),
            f[2] * alpha + b[2] * (1 - alpha)]
}

function ratioOf(a, b) {
    var la = luminance(a[0], a[1], a[2])
    var lb = luminance(b[0], b[1], b[2])
    var hi = Math.max(la, lb)
    var lo = Math.min(la, lb)
    return (hi + 0.05) / (lo + 0.05)
}

function ratio(fgHex, bgHex) {
    return ratioOf(parse(fgHex), parse(bgHex))
}

function pad2(n) {
    return n < 16 ? "0" + n.toString(16) : n.toString(16)
}

function hexOf(rgb) {
    return "#" + pad2(Math.round(Math.max(0, Math.min(1, rgb[0])) * 255))
            + pad2(Math.round(Math.max(0, Math.min(1, rgb[1])) * 255))
            + pad2(Math.round(Math.max(0, Math.min(1, rgb[2])) * 255))
}

function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

// Keep hue; walk lightness toward black or white until WCAG AA (or minRatio) holds.
function ensureRatio(fgHex, bgHex, minRatio) {
    var need = minRatio > 0 ? minRatio : 4.5
    if (ratio(fgHex, bgHex) >= need)
        return String(fgHex)
    var fg = parse(fgHex)
    var bg = parse(bgHex)
    var toward = luminance(bg[0], bg[1], bg[2]) > 0.179 ? [0, 0, 0] : [1, 1, 1]
    var lo = 0
    var hi = 1
    var best = toward
    for (var i = 0; i < 18; i++) {
        var mid = (lo + hi) / 2
        var cand = mix(fg, toward, mid)
        if (ratioOf(cand, bg) >= need) {
            best = cand
            hi = mid
        } else {
            lo = mid
        }
    }
    if (ratioOf(best, bg) < need)
        best = toward
    return stepped(hexOf(best), bgHex, need, toward)
}

// Rounding to 8 bits can land just under the ratio asked for, 2.99 for 3 on 20 of the 22 stock palettes.
function stepped(hex, bgHex, need, toward) {
    var c = parse(hex)
    var step = toward[0] > 0.5 ? 1 / 255 : -1 / 255
    var bg = parse(bgHex)
    for (var i = 0; i < 255; i++) {
        if (ratioOf(c, bg) >= need)
            break
        // Each channel clamps on its own, so one already at the extreme cannot carry the others out.
        var next = [clamp(c[0] + step), clamp(c[1] + step), clamp(c[2] + step)]
        // A step that moves no channel at all is the extreme itself, and there is nowhere further to go.
        if (hexOf(next) === hexOf(c))
            break
        c = next
    }
    return hexOf(c)
}

function clamp(v) {
    return v < 0 ? 0 : (v > 1 ? 1 : v)
}

// The seven tag names, member for member with src/backend/tags.rs NAMES and ui/js/Tags.js NAMES.
var TAG_NAMES = ["Red", "Orange", "Yellow", "Green", "Blue", "Purple", "Gray"];
var TAG_ROLES = { Red: "red", Orange: "orange", Yellow: "yellow", Green: "green",
                  Blue: "blue", Purple: "magenta", Gray: "dark_foreground" };
var TAG_HUES = { Red: [335, 12], Orange: [8, 45], Yellow: [28, 70],
                 Green: [80, 170], Blue: [195, 255], Purple: [250, 335] };

// Each role lifted to 3:1 on the listing ground and the menu ground, plus the digit fallback, decided once per theme load.
function tagTheme(found, bg, surface) {
    var colors = {};
    var menuColors = {};
    var seen = {};
    var fallback = false;
    for (var i = 0; i < TAG_NAMES.length; i++) {
        var name = TAG_NAMES[i];
        var hex = (found || {})[TAG_ROLES[name]] || "";
        if (!hex) {
            fallback = true;
        } else {
            var key = String(hex).toLowerCase();
            if (seen[key]) fallback = true;
            seen[key] = true;
        }
        colors[name] = hex ? ensureRatio(hex, bg, 3) : "";
        menuColors[name] = hex ? ensureRatio(hex, surface, 3) : "";
        if (name !== "Gray" && hex) {
            var rgb = parse(hex);
            var hi = Math.max(rgb[0], rgb[1], rgb[2]);
            var lo = Math.min(rgb[0], rgb[1], rgb[2]);
            // Almost no chroma is a grey whatever its name claims.
            if (hi === 0 || (hi - lo) / hi < 0.12) fallback = true;
            else if (!tagHueHolds(rgb, TAG_HUES[name])) fallback = true;
        }
    }
    return { colors: colors, menuColors: menuColors, fallback: fallback };
}

// A hue inside a window that wraps past red, so one comparison covers both ends.
function tagHueHolds(rgb, window) {
    var hi = Math.max(rgb[0], rgb[1], rgb[2]);
    var lo = Math.min(rgb[0], rgb[1], rgb[2]);
    var delta = hi - lo;
    var hue = 0;
    if (delta > 0) {
        if (hi === rgb[0]) {
            hue = 60 * (((rgb[1] - rgb[2]) / delta + 6) % 6);
        } else if (hi === rgb[1]) {
            hue = 60 * ((rgb[2] - rgb[0]) / delta + 2);
        } else {
            hue = 60 * ((rgb[0] - rgb[1]) / delta + 4);
        }
    }
    return window[0] <= window[1] ? hue >= window[0] && hue <= window[1] : hue >= window[0] || hue <= window[1];
}
