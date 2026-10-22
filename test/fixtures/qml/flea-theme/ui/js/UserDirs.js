.pragma library

// Sample input: XDG_DOWNLOAD_DIR="$HOME/Photo\"Inbox" # local inbox
function parseLine(line, home) {
    var kv = String(line || "").match(/^[ \t]*XDG_([A-Z]+)_DIR[ \t]*=([\s\S]*)$/)
    if (!kv)
        return null
    var value = kv[2].match(/^[ \t]*"(\$HOME(?=\/|"))?((?:\\[\s\S]|[^"\\])*)"/)
    var path = null
    if (value && (value[1] || value[2].charAt(0) === "/")) {
        path = (value[1] ? home : "") + value[2].replace(/\\([\s\S])/g, "$1")
        path = path.replace(/\/+$/, "")
        if (path.charAt(0) !== "/")
            path = null
    }
    return { role: kv[1], path: path }
}

// Sample input: XDG_DOWNLOAD_DIR="$HOME/Old" then XDG_DOWNLOAD_DIR="$HOME/Inbox"; the last valid path wins.
function readRoles(body, home) {
    var roles = []
    var paths = {}
    var lines = String(body || "").split("\n")
    for (var i = 0; i < lines.length; i++) {
        var entry = parseLine(lines[i], home)
        if (!entry)
            continue
        if (roles.indexOf(entry.role) < 0)
            roles.push(entry.role)
        if (entry.path)
            paths[entry.role] = entry.path
    }
    var out = []
    for (var r = 0; r < roles.length; r++) {
        if (paths[roles[r]] !== undefined)
            out.push({ role: roles[r], path: paths[roles[r]] })
    }
    return out
}

// Sample input: XDG_DOWNLOAD_DIR="$HOME/Downloads".
function userDirs(body, home) {
    var out = []
    var entries = readRoles(body, home)
    for (var i = 0; i < entries.length; i++) {
        // A disabled role points at Home, which is not a separate place or a default-sort folder.
        if (entries[i].path !== home)
            out.push({ path: entries[i].path, label: leaf(entries[i].path) })
    }
    return out
}

function leaf(path) {
    var cut = path.lastIndexOf("/")
    return cut < 0 ? path : path.substring(cut + 1)
}
