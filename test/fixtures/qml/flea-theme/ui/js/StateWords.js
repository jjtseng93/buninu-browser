.pragma library

.import "Format.js" as Format

// The state word an errored menu row says in its hint slot: a fixed value here, never a provider's reason.
var WORDS = {
    taildropFolder: "files only",
    taildropSignedOut: "signed out",
    taildropNoPeers: "no devices",
    taildropDown: "offline",
    localsendFolder: "files only",
    localsendNoPeers: "no devices",
    dropboxSignedOut: "signed out",
    dropboxDown: "not running",
    permissionsLink: "symlink",
    permissionsSpecial: "special file",
    permissionsNotYours: "not yours"
}

// Sample input: { rowIsFile: false, taildropCode: "" }, or { rowIsFile: true, taildropCode: "signedOut" }; codes are ui/js/Taildrop.js status().
function taildrop(p) {
    if (p.rowIsFile === false) return WORDS.taildropFolder
    if (p.taildropCode === "signedOut") return WORDS.taildropSignedOut
    return p.taildropCode === "noPeers" ? WORDS.taildropNoPeers : WORDS.taildropDown
}

// Sample input: { rowIsFile: false }. The send finds nobody on the network for any other cause.
function localsend(p) {
    return p.rowIsFile === false ? WORDS.localsendFolder : WORDS.localsendNoPeers
}

// Sample input: { dropboxCode: "signedOut" }; codes are ui/js/Dropbox.js account() and status().
function dropbox(p) {
    return p.dropboxCode === "signedOut" ? WORDS.dropboxSignedOut : WORDS.dropboxDown
}

// A link names itself; any other kind that is neither a file nor a folder is special, and a mode never read names nothing.
function permissions(mode) {
    var kind = (Number(mode) || 0) & Format.S_IFMT
    if (kind === 0) return ""
    return kind === Format.S_IFLNK ? WORDS.permissionsLink : WORDS.permissionsSpecial
}
