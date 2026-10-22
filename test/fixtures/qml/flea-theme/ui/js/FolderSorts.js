.pragma library
.import "UserDirs.js" as UserDirs

// Owned here so Backend.qml loads no sort closure at startup.
var ORDERS = ["name", "size", "mtime", "kind"]

// Written only on a user sort in that folder, read once per listing, oldest first.

// The cap ui.json holds, oldest first; setting past it drops the folders sorted longest ago.
var MAX = 500

// Sample input: XDG_DOWNLOAD_DIR="$HOME/Inbox"; absent PICTURES and VIDEOS use their conventional names.
function newestPaths(body, home) {
    var roles = ["DOWNLOAD", "PICTURES", "VIDEOS"]
    var names = ["Downloads", "Pictures", "Videos"]
    var paths = []
    if (!home) return paths
    var configured = {}
    var entries = UserDirs.readRoles(body, home)
    for (var e = 0; e < entries.length; e++)
        configured[entries[e].role] = entries[e].path
    for (var i = 0; i < roles.length; i++) {
        var path = configured[roles[i]] === undefined ? home + "/" + names[i] : configured[roles[i]]
        if (path && path !== home && paths.indexOf(path) < 0)
            paths.push(path)
    }
    return paths
}

function defaultOrder(path, newest) {
    var folder = String(path || "").replace(/\/+$/, "")
    return newest && newest.indexOf(folder) >= 0 ? { key: "mtime", reverse: true } : null
}

// Settings stores Modified as "date" while ORDERS and the backend spell it "mtime".
function liveKey(key) {
    return key === "date" ? "mtime" : key
}

// Sample input: {"/home/gm/Work": {"key": "size", "reverse": true}}.
function get(sorts, path) {
    var entry = sorts ? sorts[path] : null
    if (!entry || ORDERS.indexOf(liveKey(entry.key)) < 0)
        return null
    return { key: liveKey(entry.key), reverse: entry.reverse === true }
}

function has(sorts, path) {
    return get(sorts, path) !== null
}

function count(sorts) {
    return sorts ? Object.keys(sorts).length : 0
}

// A re-sort moves its folder to the most recent end; past the cap the oldest entries go.
function set(sorts, path, key, reverse) {
    var next = {}
    if (sorts) {
        for (var k in sorts) {
            if (k !== path)
                next[k] = sorts[k]
        }
    }
    next[path] = { key: key, reverse: reverse === true }
    var keys = Object.keys(next)
    while (keys.length > MAX)
        delete next[keys.shift()]
    return next
}

function forget(sorts, path) {
    var next = {}
    if (sorts) {
        for (var k in sorts) {
            if (k !== path)
                next[k] = sorts[k]
        }
    }
    return next
}

// A user sort writes its folder only while remembering is on.
function shouldRemember(remember, path) {
    return remember !== false && !!path
}

// Columns pass keep: a saved order wins over XDG defaults; remembering off uses the global order, except kind, unsupported by peeks.
function peekOrder(sorts, path, remember, keep, newest, fallback) {
    if (!Array.isArray(keep)) return {}
    var own = remember !== false ? get(sorts, path) || defaultOrder(path, newest)
                                : fallback ? orderFor(null, path, fallback, false) : null
    if (remember === false && own && own.key === "name" && !own.reverse) return {}
    return own && own.key !== "kind" ? { by: own.key, desc: own.reverse } : {}
}

// An unknown stored key reads as the default, so a newer Flea never wedges this one.
function orderFor(sorts, path, fallback, remember, newest) {
    if (remember !== false) {
        var own = get(sorts, path) || defaultOrder(path, newest)
        if (own)
            return own
    }
    fallback = fallback || {}
    var key = liveKey(fallback.key)
    return { key: ORDERS.indexOf(key) >= 0 ? key : "name",
             reverse: fallback.reverse === true }
}
