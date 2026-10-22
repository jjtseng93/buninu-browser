.pragma library

// SI, because a file's size on disk has no power-of-two basis; GLib's own rule and the whole GUI group.
var BYTES_PER_UNIT = 1000
var UNITS = ["B", "kB", "MB", "GB", "TB"]
// GNOME renders a narrow no-break space before the unit, and Flea's neighbours are GLib-formatted.
var UNIT_SPACE = " "

// Below one kilobyte a fraction is noise, so bytes print whole.
// Counts reach six figures on a real directory, so they are grouped the way the canvas draws them.
function count(n) {
    var digits = String(n)
    var out = ""
    for (var i = 0; i < digits.length; i++) {
        if (i > 0 && (digits.length - i) % 3 === 0)
            out += ","
        out += digits.charAt(i)
    }
    return out
}

function size(bytes) {
    if (bytes < BYTES_PER_UNIT) {
        return bytes + UNIT_SPACE + UNITS[0]
    }
    var value = bytes
    var unit = 0
    while (value >= BYTES_PER_UNIT && unit < UNITS.length - 1) {
        value = value / BYTES_PER_UNIT
        unit += 1
    }
    return value.toFixed(1) + UNIT_SPACE + UNITS[unit]
}

// Fills %1 to %9 in one pass: a value prints as given, a dollar sign or placeholder in it included; an unfilled one stays.
function fill(template) {
    var values = arguments
    return String(template).replace(/%([1-9])/g, function (token, at) { return at < values.length ? String(values[at]) : token })
}

function pad(n) {
    return n < 10 ? "0" + n : "" + n
}

// "2026-09-12 15:29", the one form every surface prints, in the machine's local wall clock.
function stamp(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
        + " " + pad(d.getHours()) + ":" + pad(d.getMinutes())
}

// One form, sortable and unambiguous, so no surface has to invent a relative word for a time.
function date(mtime) {
    return stamp(new Date(mtime * 1000))
}

// The send picker's column is SendPicker.html's 80 and not the window's 125, which holds about ten
// characters: the one place the full stamp does not fit. It drops the time and keeps the date, so it
// is still sortable and still unambiguous. Preview board, "One function, four surfaces".
function compactDate(mtime) {
    var d = new Date(mtime * 1000)
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
}

// The low nine bits of st_mode, read three at a time.
var PERMISSION_BITS = 9
var TRIAD = "rwx"

function permissions(mode) {
    var out = ""
    for (var i = 0; i < PERMISSION_BITS; i++) {
        var bit = 1 << (PERMISSION_BITS - 1 - i)
        out += (mode & bit) ? TRIAD[i % TRIAD.length] : "-"
    }
    return out
}

// The file type lives in the top four bits of st_mode, as S_IFMT masks it.
var S_IFMT = 0o170000
var S_IFREG = 0o100000
var S_IFDIR = 0o040000
// The owner execute bit, the one Make executable adds.
var S_IXUSR = 0o100
var S_IFLNK = 0o120000
var ANY_EXECUTE_BIT = 0o111

function isSymlink(mode) {
    return (mode & S_IFMT) === S_IFLNK
}

function isExecutable(mode) {
    return (mode & ANY_EXECUTE_BIT) !== 0
}

// Shared by Row.qml's iconSource and PreviewMedia.qml's player source: encodeURI leaves # and ?
// literal, which Qt then reads as a URL fragment or query rather than path bytes.
function fileUri(path) {
    return "file://" + encodeURI(path).replace(/#/g, "%23").replace(/\?/g, "%3F")
}

// "3:05", or "1:03:05" once an hour is on the clock; mm/ss are always two digits, matching a media player's own clock rather than Format.date's prose.
function duration(ms) {
    var totalSeconds = Math.max(0, Math.floor(ms / 1000))
    var hours = Math.floor(totalSeconds / 3600)
    var minutes = Math.floor((totalSeconds % 3600) / 60)
    var seconds = totalSeconds % 60
    if (hours > 0) {
        return hours + ":" + pad(minutes) + ":" + pad(seconds)
    }
    return minutes + ":" + pad(seconds)
}

// The scope reads as the user writes it, so the home prefix comes back as a tilde. Both the search
// strip and the window chrome draw a path through this, so the rule has one definition.
// Issue 95, nixfred: a bare prefix made /home/gmx into "~x", a sibling wearing home's name. The test
// is home itself or home and a separator, the one ui/js/Nav.js crumbs and Search.scopeRoot both make.
function tilde(path, home) {
    var text = String(path)
    if (home.length > 0 && (text === home || text.indexOf(home + "/") === 0)) {
        return "~" + text.substring(home.length)
    }
    return text
}

// A tab is named after the directory it is standing in, so the label is the path's last segment.
function leafPart(display) {
    var text = String(display)
    var cut = text.lastIndexOf("/")
    if (cut < 0) {
        return text
    }
    // "/" itself has no leaf, and its own separator is the whole label.
    return cut === text.length - 1 ? text : text.substring(cut + 1)
}

// "44.1 kHz", the way the canvas writes an audio row's Rate; a zero is not a rate and reads empty.
function sampleRate(hz) {
    var n = Number(hz)
    if (!n || n <= 0) {
        return ""
    }
    var khz = n / 1000
    // A whole number of kilohertz reads without a decimal, so 48000 is "48 kHz" and not "48.0 kHz".
    return (khz === Math.round(khz) ? khz : khz.toFixed(1)) + " kHz"
}

// Issue 67, jesedv: a yanked path is quoted unless a shell reads every character of it as itself.
function shellQuoted(path) {
    var text = String(path)
    if (/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(text)) {
        return text
    }
    return "'" + text.split("'").join("'\\''") + "'"
}

// One window-level day boundary, so no Date is built and no timer ticks per row.

// Sample input: Date.now() on the board date, 2026-09-23 11:40 local.
var DAY_MS = 24 * 60 * 60 * 1000
// The midnight timer's minute step, so a suspend still lands the day within a minute of resume.
var MINUTE_MS = 60 * 1000

// Local midnight starting the day nowMs falls in, in ms since the epoch.
function dayStart(nowMs) {
    var now = new Date(nowMs)
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

// True when the stamp is on or after today's local midnight.
function isRecent(mtimeSec, todayStartMs) {
    if (typeof mtimeSec !== "number" || !isFinite(mtimeSec))
        return false
    return mtimeSec * 1000 >= todayStartMs
}

// Built from components, so a daylight-saving night still lands on midnight.
function msUntilMidnight(nowMs) {
    var now = new Date(nowMs)
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - nowMs
}

// Elides in the middle so the extension stays visible; truncation costs a slice, never a relayout.
// Sample input: "screenshot-2026-08-30-final-review-for-gm-after-the-bench-v3.png", 49.

// The walk pairs surrogates by hand, so a cut never splits a code point.
function charsOf(text) {
    var out = []
    for (var i = 0; i < text.length; i++) {
        var lead = text.charCodeAt(i)
        if (lead >= 0xD800 && lead <= 0xDBFF && i + 1 < text.length) {
            var trail = text.charCodeAt(i + 1)
            if (trail >= 0xDC00 && trail <= 0xDFFF) {
                out.push(text.substring(i, i + 2))
                i += 1
                continue
            }
        }
        // A combining mark rides with the char before it, so an NFD accent never orphans.
        if (lead >= 0x0300 && lead <= 0x036F && out.length > 0) {
            out[out.length - 1] += text.charAt(i)
            continue
        }
        out.push(text.charAt(i))
    }
    return out
}

// Every fast unit sits below U+0300, so a fast name holds no surrogate, no combining mark and no wide glyph.
var FAST_LIMIT = 0x0300

// True when every UTF-16 unit is fast: each char paints one cell and slices never split a point.
function isFastText(text) {
    for (var i = 0; i < text.length; i++)
        if (text.charCodeAt(i) >= FAST_LIMIT) return false
    return true
}

function middleElide(name, maxCells) {
    var text = String(name), max = Math.max(0, Math.floor(maxCells))
    // A non-finite budget names no width, so the name goes through untouched.
    if (!isFinite(max)) return text
    // One scan serves the fit check and the store below, so a fitting fast name builds nothing.
    var fast = isFastText(text)
    // A fast name counts one cell a char, so a short one already fits untouched.
    if (fast && text.length <= max) return text
    var st = fast ? fastStoreOf(text) : storeOf(charsOf(text))
    if (rangeCells(st, 0, st.n) <= max) return text
    // The head takes the odd cell, so a 49-wide board keeps 24 and 24.
    var h = spanFrom(st, 0, Math.ceil((max - 1) / 2)), t = tailSpan(st, Math.floor((max - 1) / 2))
    return pieceOf(st, 0, h) + "…" + pieceOf(st, st.n - t, st.n)
}

// Display cells: East Asian Wide and Fullwidth paint two columns, emoji paint two, all else one.
// Sample input: cellWidthOf("🎉") is 2, cellWidthOf("A") is 1.
var WIDE_RANGES = [[0x1100, 0x115F], [0x2E80, 0x303E], [0x3041, 0x33FF], [0x3400, 0x4DBF], [0x4E00, 0xA4CF], [0xAC00, 0xD7A3], [0xF900, 0xFAFF], [0xFE10, 0xFE19], [0xFE30, 0xFE4F], [0xFF00, 0xFF60], [0xFFE0, 0xFFE6], [0x20000, 0x3FFFD]]
var EMOJI_RANGES = [[0x2600, 0x26FF], [0x2700, 0x27BF], [0x2B00, 0x2BFF], [0x1F000, 0x1FAFF]]

// True when a code point paints two columns rather than one.
function isWideCode(cp) {
    // Every wide range starts at U+1100, so a smaller code point never scans.
    if (cp < 0x1100) return false
    for (var i = 0; i < WIDE_RANGES.length; i++)
        if (cp >= WIDE_RANGES[i][0] && cp <= WIDE_RANGES[i][1]) return true
    for (var j = 0; j < EMOJI_RANGES.length; j++)
        if (cp >= EMOJI_RANGES[j][0] && cp <= EMOJI_RANGES[j][1]) return true
    return false
}

// The code point one charsOf element starts with, read without wrapping it in a string.
// Sample input: codeOf("🎉") is 0x1F389, codeOf("A") is 0x41.
function codeOf(ch) {
    var s = String(ch), lead = s.charCodeAt(0)
    if (lead >= 0xD800 && lead <= 0xDBFF && s.length > 1) {
        var trail = s.charCodeAt(1)
        if (trail >= 0xDC00 && trail <= 0xDFFF) return 0x10000 + ((lead - 0xD800) << 10) + (trail - 0xDC00)
    }
    return lead
}

// Cells one char paints: 2 for a wide code point, 1 for all else.
function cellWidthOf(ch) {
    return isWideCode(codeOf(ch)) ? 2 : 1
}

// One layout per call: widths plus prefix sums, so every range below is one subtraction.
// Sample input: storeOf(["a", "🎉"]) carries widths [1, 2].
function storeOf(chars) {
    var widths = new Array(chars.length), prefix = new Array(chars.length + 1)
    prefix[0] = 0
    for (var i = 0; i < chars.length; i++) {
        widths[i] = isWideCode(codeOf(chars[i])) ? 2 : 1
        prefix[i + 1] = prefix[i] + widths[i]
    }
    return { seq: chars, widths: widths, prefix: prefix, n: chars.length }
}

// The same layout over a fast string: no arrays, every range counts chars as cells.
function fastStoreOf(text) {
    return { seq: text, widths: null, prefix: null, n: text.length }
}

// Cells of elements [a..b).
function rangeCells(st, a, b) {
    return st.widths === null ? b - a : st.prefix[b] - st.prefix[a]
}

// Elements from pos fitting in this many cells.
function spanFrom(st, pos, budget) {
    if (st.widths === null) return Math.min(Math.max(budget, 0), st.n - pos)
    var used = 0, i = pos
    while (i < st.widths.length && used + st.widths[i] <= budget) { used += st.widths[i]; i += 1 }
    return i - pos
}

// Trailing elements fitting in this many cells.
function tailSpan(st, budget) {
    if (st.widths === null) return Math.min(Math.max(budget, 0), st.n)
    var used = 0, i = st.widths.length
    while (i > 0 && used + st.widths[i - 1] <= budget) { used += st.widths[i - 1]; i -= 1 }
    return st.widths.length - i
}

// Text of elements [a..b): a slice for a fast string, a join for a char array.
function pieceOf(st, a, b) {
    return st.widths === null ? st.seq.slice(a, b) : st.seq.slice(a, b).join("")
}
