.pragma library

.import "Format.js" as Format

// Which rows get an Extract, and what a new archive is called; the backend sends no is-archive flag, so this is the mechanism.

// The widened tail of EXTENSIONS, which 7z reads; tar and the zip class keep their own rules.
var SEVEN_TAILS = [".appimage", ".cpio", ".cab", ".jar", ".apk", ".rpm", ".deb", ".iso"]

// Longest form first, so ".tar.gz" matches before ".gz"; .rar is read here and never offered to write (src/backend/archive.rs).
var EXTENSIONS = [".tar.zst", ".tar.bz2", ".tar.gz", ".tar.xz", ".tgz", ".tar", ".zip", ".7z", ".rar"].concat(SEVEN_TAILS)

// A disk image lists in the archive preview and is never extracted.
var LIST_ONLY = [".iso"]

function isArchive(name) {
    var lower = String(name).toLowerCase()
    for (var i = 0; i < EXTENSIONS.length; i++) {
        if (lower.length > EXTENSIONS[i].length && lower.indexOf(EXTENSIONS[i], lower.length - EXTENSIONS[i].length) !== -1) {
            return true
        }
    }
    return false
}

// The name an extract unpacks into: the archive's own, with every archive extension taken off.
function extractDir(name) {
    var text = String(name)
    var lower = text.toLowerCase()
    for (var i = 0; i < EXTENSIONS.length; i++) {
        if (lower.length > EXTENSIONS[i].length && lower.indexOf(EXTENSIONS[i], lower.length - EXTENSIONS[i].length) !== -1) {
            return text.substring(0, text.length - EXTENSIONS[i].length)
        }
    }
    return text
}

// One row compresses under its own name; several compress under the directory holding them.
function archiveStem(names, parentLeaf) {
    if (names.length === 1) {
        return stripExtension(names[0])
    }
    return parentLeaf.length > 0 ? parentLeaf : "archive"
}

function stripExtension(name) {
    var text = String(name)
    var cut = text.lastIndexOf(".")
    return cut > 0 ? text.substring(0, cut) : text
}

var SHEET_COMPRESS = "Compress to .%1"

// The compress submenu is the probed table, so no 7zip means no .7z; the sheet reads each leaf "Compress to .zip" beside the board's file mark.
function formatEntries(formats) {
    var out = []
    for (var i = 0; i < formats.length; i++) {
        out.push({ id: formats[i], label: "." + formats[i], sheetLabel: SHEET_COMPRESS.replace("%1", formats[i]), glyph: "file" })
    }
    return out
}

// A disk image by name, longest form first so ".img.xz" wins over ".img"; a zip needs one such member.
function imageKind(name) {
    var lower = String(name || "").toLowerCase()
    var table = [[".img.xz", "xz"], [".img.gz", "gz"], [".img.zst", "zst"], [".img.bz2", "bz2"],
                 [".iso", "iso"], [".img", "img"], [".raw", "raw"], [".zip", "zip"]]
    for (var i = 0; i < table.length; i++) {
        var suffix = table[i][0]
        if (lower.length > suffix.length && lower.lastIndexOf(suffix) === lower.length - suffix.length)
            return table[i][1]
    }
    return ""
}

function isDiskImage(name, zipMember) {
    var kind = imageKind(name)
    if (kind === "" || kind === "zip")
        return kind === "zip" && imageKind(zipMember) !== "" && imageKind(zipMember) !== "zip"
    return true
}

// Whether an installed tool reads this archive: .7z needs 7z, .zip and .rar either tool, tar bsdtar, a disk image none.
function canExtract(name, extraction) {
    var lower = String(name).toLowerCase()
    var caps = extraction || ({})
    if (isListOnly(name)) return false
    if (hasSuffix(lower, ".7z")) return caps.sevenZip === true
    if (hasSuffix(lower, ".zip") || hasSuffix(lower, ".rar")) return caps.zip === true
    if (isSevenSuffix(lower)) return caps.sevenZip === true
    return caps.archive === true
}

// A disk image lists in the archive preview and is never extracted.
function isListOnly(name) {
    var lower = String(name).toLowerCase()
    for (var i = 0; i < LIST_ONLY.length; i++) {
        if (hasSuffix(lower, LIST_ONLY[i])) return true
    }
    return false
}

// The seven-tail membership, read off the one table above.
function isSevenSuffix(lower) {
    for (var i = 0; i < SEVEN_TAILS.length; i++) {
        if (hasSuffix(lower, SEVEN_TAILS[i])) return true
    }
    return false
}

// The missing program for a disabled Extract: only bsdtar offers "tar" and only 7z offers "7z".
function extractHint(formats) {
    var table = formats || []
    if (table.indexOf("7z") >= 0) return "bsdtar is not installed"
    if (table.indexOf("tar") >= 0) return "7-Zip is not installed"
    return "No archive tool is installed"
}

// Menu.js's Extract row: absent for none and for a disk image, disabled with its reason for no reader.
function extractEntry(entry, p, count) {
    if (!p.rowIsArchive || count !== 1) return false
    if (isListOnly(p.archiveName || "")) return false
    if (p.canExtract !== true) {
        entry.disabled = true
        entry.hint = extractHint(p.archiveFormats)
        entry.hintWrap = true
    }
    return true
}

function hasSuffix(lower, suffix) {
    return lower.length >= suffix.length && lower.indexOf(suffix, lower.length - suffix.length) !== -1
}

// The compress submenu's last row, which opens the password dialog; hidden where 7z is missing, since bsdtar writes no encryption.
function passwordEntry(formats) {
    var table = formats || []
    if (table.indexOf("7z") < 0) return []
    return [{ separator: true },
        { id: "compressPassword", label: "With password…", glyph: "key" }]
}

// The backend's two password codes, matched exactly the way "cancelled" routes, never as sentences.
function needsPassword(err) {
    return String(err) === "encrypted"
}

function wrongPassword(err) {
    return String(err) === "wrong-password"
}

// What an extract's terminal line does: "password" opens the card, "wrong" reopens it with its sentence, "" messages.
function doneAction(ok, err) {
    if (!ok && needsPassword(err)) return "password"
    if (!ok && wrongPassword(err)) return "wrong"
    return ""
}
