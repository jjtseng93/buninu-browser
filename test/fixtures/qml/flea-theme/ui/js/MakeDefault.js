.pragma library

// Settings > About's Make Flea the default: which state the row is in, the note under it and what a press runs; ui/DefaultClaim.qml runs the processes.

.import "Format.js" as Format

// Whole sentences with "%1" for the program that never started, its name and not its command line.
var WORDS = {
    unstarted: "%1 could not start"
}

// The row's id, which ui/SettingsPanel.qml routes to the run instead of writing it into ui.json.
var ROW_ID = "makeDefault"
// The entry flea --default points the desktop at; the box is ticked exactly when xdg-mime answers it.
var DESKTOP_ID = "com.thisisgm.flea.desktop"
// src/main.rs claim_both() says this and still exits 0 when a build has no flea.portal to route file dialogs to.
var SKIPPED = "no file chooser service is installed, so Flea could not become the file chooser"
// src/defaults.rs EXIT_UNINSTALLED: the status claim() exits with when the running binary has no desktop entry to point at.
var UNINSTALLED_STATUS = 3
// The portal reads its routing once, at startup; try-restart leaves a portal that is not running alone.
var RESTART = ["systemctl", "--user", "try-restart", "xdg-desktop-portal.service"]
// flea's own stderr lines start with its name, which the note drops.
var OWN_PREFIX = "flea: "

// Nothing run in this process yet; an entry is assumed until the probe or a refusal says otherwise.
function idle() {
    return { running: false, claiming: false, reading: false, readFrom: 0, restarting: false, outcome: "", error: "", packaged: true }
}

// A run in flight, or a build with no entry, takes no press.
function inert(claim) {
    return claim.running || claim.packaged === false
}

// flea's arguments for a press, or null while the row is inert.
function press(handler, claim) {
    if (inert(claim))
        return null
    return handler === DESKTOP_ID ? ["--default", "off"] : ["--default"]
}

// A new run drops the last one's outcome; which way it goes picks the working note.
function started(claim, args) {
    return { running: true, claiming: args.length === 1, reading: false, readFrom: 0, restarting: false, outcome: "", error: "",
             packaged: claim.packaged }
}

// Still running until a handler read numbered nextRead or later lands and a switch that went through has restarted the portal.
// Sample stderr: "flea: no file chooser service is installed, so Flea could not become the file chooser\n"
function finished(claim, code, stderr, nextRead) {
    var text = stderr || ""
    var next = Object.assign({}, claim, { reading: true, readFrom: nextRead, restarting: code === 0 })
    if (code === 0) {
        next.outcome = text.indexOf(SKIPPED) >= 0 ? "partly" : ""
        return next
    }
    if (code === UNINSTALLED_STATUS) {
        next.packaged = false
        return next
    }
    next.outcome = "failed"
    next.error = errorLine(text, code, claim.claiming)
    return next
}

// xdg-mime's stderr reaches flea's own, so flea's line is the one that starts with its name.
// Sample stderr: "xdg-mime: no method available\nflea: xdg-mime default exited 3\n"
function errorLine(stderr, code, claiming) {
    var lines = stderr.split("\n").map(function (line) { return line.trim() })
    var own = lines.filter(function (line) { return line.indexOf(OWN_PREFIX) === 0 })[0]
    if (own !== undefined)
        return own.substring(OWN_PREFIX.length)
    var first = lines.filter(function (line) { return line.length > 0 })[0]
    return first !== undefined ? first : (claiming ? "flea --default" : "flea --default off") + " exited " + code
}

// The handler read numbered read has landed; only one begun after the run exited ends it, and only once the portal restart has answered too.
function settled(claim, read) {
    if (!claim.reading || read < claim.readFrom)
        return claim
    return Object.assign({}, claim, { reading: false, running: claim.restarting })
}

// A Process's exit and its collector's text land in either order (AGENTS.md "The state file"), so an answer is read once it holds both.
// Sample: landed(landed({}, { code: 0 }), { text: "com.thisisgm.flea.desktop\n" }) is { code: 0, text: "com.thisisgm.flea.desktop\n" }
function landed(answer, half) {
    return Object.assign({}, answer, half)
}

// An empty text is an answer too: a run that says nothing has still finished saying it.
function whole(answer) {
    return answer.code !== undefined && answer.text !== undefined
}

// The whole answer a program that never started is given: no real exit status is negative.
var NEVER_RAN = { code: -1, text: "" }

// ui/ViewState.qml's writer rule, measured on Quickshell 0.3.1: a program that cannot start raises no exited, only running going false, and a real exit lands its status before that false.
function neverRan(answer, running) {
    return !running && answer.code === undefined
}

// The handler an answer states; any other status, a read that never ran among them, states none, which About shows as Not reported.
function handlerOf(answer) {
    return answer.code === 0 ? answer.text.trim() : ""
}

// A run whose program never started wrote nothing, so it is over at once, failed, naming what could not start.
// Sample command: ["/usr/bin/flea", "--default"]
function unstarted(claim, command) {
    return Object.assign({}, claim, { running: false, reading: false, restarting: false, outcome: "failed",
                                      error: Format.fill(WORDS.unstarted, String(command[0]).split("/").pop()) })
}

// A portal that would not restart keeps the switch as it went; partly keeps its own note, whose dialogs never follow.
function restarted(claim, ok) {
    var outcome = !ok && claim.outcome === "" ? "portal" : claim.outcome
    return Object.assign({}, claim, { restarting: false, running: claim.reading, outcome: outcome })
}

// restarted() clears restarting on a real exit before running goes false, so a stop that finds it still set is a systemctl that never ran.
function restartStopped(claim, running) {
    return !running && claim.restarting ? restarted(claim, false) : claim
}

function probed(claim, found) {
    return Object.assign({}, claim, { packaged: found })
}

// One of off, on, working, partly, portal, failed, unpackaged.
function state(handler, claim) {
    if (claim.packaged === false)
        return "unpackaged"
    if (claim.running)
        return "working"
    if (claim.outcome === "failed")
        return "failed"
    if (handler === DESKTOP_ID && claim.outcome === "partly")
        return "partly"
    if (claim.outcome === "portal")
        return "portal"
    return handler === DESKTOP_ID ? "on" : "off"
}

// [words, role] for the one line under the row, or null when off says nothing.
function note(handler, claim) {
    var now = state(handler, claim)
    if (now === "on")
        return ["Folders, Show in folder and file dialogs open Flea.", "foreground"]
    if (now === "working")
        return [claim.claiming ? "Making Flea the default" : "Handing folders back", "muted"]
    if (now === "partly")
        return ["File dialogs need the flea package's portal files.", "foreground"]
    if (now === "portal")
        return ["File dialogs follow after xdg-desktop-portal restarts.", "foreground"]
    if (now === "failed")
        return [claim.error, "error"]
    if (now === "unpackaged")
        return ["Install a Flea package to make it the default.", "foreground"]
    return null
}

// The check row and its note for About's This box group; the note elides on one line rather than wrapping.
function rows(handler, claim) {
    var live = claim || idle()
    var out = [{ kind: "check", id: ROW_ID, label: "Make Flea the default", on: handler === DESKTOP_ID, inert: inert(live) }]
    var line = note(handler, live)
    if (line !== null)
        out.push({ kind: "hint", label: line[0], role: line[1], elide: "right" })
    return out
}

// src/userfile.rs data_file()'s ladder: the data home, then every data dir, an empty variable read as unset.
// Sample env: { HOME: "/home/gm", XDG_DATA_HOME: "", XDG_DATA_DIRS: "/usr/local/share:/usr/share" }
function entryPaths(env) {
    var home = env.XDG_DATA_HOME || (env.HOME ? env.HOME + "/.local/share" : "")
    var dirs = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":")
    return [home].concat(dirs)
        .filter(function (dir) { return dir.length > 0 })
        .map(function (dir) { return dir + "/applications/" + DESKTOP_ID })
}

// data_file()'s regular-file test; each path is an argument, so no path reaches the shell as code.
function probeCommand(paths) {
    return ["sh", "-c", "for f; do [ -f \"$f\" ] && exit 0; done; exit 1", "sh"].concat(paths)
}
