.pragma library
.import "Input.js" as Input
.import "Format.js" as Format

// The status bar's two search lines, each filled by Format.fill.
var WORDS = {
    searching: "%1 found · Searching, %2 scanned",
    landed: "%1 found in %2 s"
}

// Live subtree search: the strip opens a session, each keystroke sends its query, rows replace folder rows with no Enter.
var OFF = ""
var TYPING = "typing"
var RESULTS = "results"

// f opens the session with no rows touched; from Recent it leaves first, so the scope and rows are the real folder.
function start(root) {
    if (root.searchMode === RESULTS) {
        root.searchMode = TYPING
        return
    }
    if ((root.searchMode || "").length > 0) {
        return
    }
    // The cursor's file rides pendingSelect until Esc; mid-session landings skip it while the query stands.
    var under = root.rowFor(root.cursorIndex)
    root.pendingSelect = under && under.n ? root.join(root.path, under.n) : ""
    var fromRecent = root.recentMode.length > 0
    if (fromRecent) {
        // The history rows keep their own base until the folder's rows, asked below, replace them.
        root.searchBase = root.path
        if (root.recentFrom.length > 0) {
            root.path = root.recentFrom
        }
        root.recentMode = ""
        root.recentFrom = ""
        root.recentPaths = []
        root.restoreRecentSort()
    }
    root.searchFrom = root.path
    root.searchMode = TYPING
    openScope(root)
    // Recent's rows name paths under "/", so the folder's own rows are asked for now and Esc re-lists it.
    if (fromRecent) {
        sendQuery(root)
    }
}

// The backend session for the pane's scope, with the drawn state of a fresh walk; f and a tag place both open through here.
function openScope(root) {
    // Gens keep rising across sessions, so a closed session's late line never matches; the first answer parks on row 0.
    root.searchOpenedGen = root.searchGen
    if (root.swap) { root.swap.landedGen = 0; root.swap.answeredQuery = "" }
    root.searchQuery = ""
    root.searchRunning = true
    root.searchCancelled = false
    root.searchScanned = 0
    root.backend.searchOpen(scopeRoot(root.path, root.home || "", root.searchHere), root.path, root.showHidden)
}

// Universal search: home when the pane stands inside it, else the pane's directory (backend has no home notion). Issue 30: here=true stays; abort()/reveal() leave it; nothing persists.
function scopeRoot(path, home, here) {
    if (here === true) {
        return path
    }
    if (home.length === 0) {
        return path
    }
    if (path === home || String(path).indexOf(home + "/") === 0) {
        return home
    }
    return path
}

// Keystrokes send rising gens with old rows held and the cursor standing for the landing to keep.
function sendQuery(root) {
    root.searchGen += 1
    root.searchKeyAt = Date.now()
    root.searchFirstRowsAt = 0
    root.searchSettledAt = 0
    root.backend.searchQuery(root.searchQuery, root.searchGen, root.windowSize, root.sizeWish)
}

function extend(root, character) {
    root.searchQuery += character
    sendQuery(root)
}

// Backspace to empty sends "" and the folder rows come back, with the strip still open.
function shrink(root) {
    if (root.searchQuery.length === 0) {
        return
    }
    root.searchQuery = root.searchQuery.substring(0, root.searchQuery.length - 1)
    sendQuery(root)
}

// Enter keeps the results and moves the keys to them, with no new request.
function commit(root) {
    if ((root.searchQuery || "").length === 0) {
        abort(root)
        return
    }
    root.searchMode = RESULTS
}

// A leaving session takes no query from outside, so a caller that clears its own state first asks here.
function takesQuery(root) {
    return root.searchLeaving !== true
}

// A query set from outside the strip lands as results over the Home scope, from a fresh session, a standing one or a cancelled one; a leaving session takes none.
// Sample input: (pane, "tag:Red") with the pane browsing, in Recent, or typing or showing results at either scope.
function openQuery(root, query) {
    if (!takesQuery(root)) {
        return
    }
    if ((root.searchMode || "").length === 0) {
        root.searchHere = false
        start(root)
    } else if (root.searchCancelled === true) {
        // A cancelled walk answers nothing more, so the place opens a fresh Home session with the drawn state of a new walk.
        root.searchHere = false
        openScope(root)
    } else if (root.searchHere) {
        // The old query is dropped first, so the rescope sends nothing and the new query is the one request.
        root.searchQuery = ""
        rescope(root)
    }
    root.searchQuery = query
    sendQuery(root)
    commit(root)
}

// Tab flips the scope, opens the new scope at once and re-sends the standing query.
function rescope(root) {
    root.searchHere = !root.searchHere
    var scope = scopeRoot(root.path, root.home || "", root.searchHere)
    root.backend.searchOpen(scope, root.path, root.showHidden)
    if ((root.searchQuery || "").length > 0) {
        sendQuery(root)
    }
}

// The first Esc while the walk runs stops it and keeps the results on screen.
function cancel(root) {
    if (root.backend) {
        root.backend.searchCancel()
    }
}

// Esc leaves at once when empty or landed, or re-lists the folder it came from otherwise.
function abort(root) {
    // A second Esc lands nowhere: the first already closed the backend and owes the landing.
    if (root.searchLeaving === true) {
        return
    }
    if (root.searchRunning && (root.searchQuery || "").length > 0) {
        cancel(root)
        return
    }
    var back = (root.searchFrom || "").length > 0 ? root.searchFrom : root.path
    if (!owesRelist(root)) {
        closeSession(root)
        root.pendingSelect = ""
        return
    }
    // The backend closes at the request; the drawn state waits for the folder to land.
    leaveWalk(root)
    root.openWithoutHistory(back, { holdWalk: true, relist: true })
}

// Any gen this session sent may have drawn rows the folder does not own, so leaving it re-lists the folder.
function owesRelist(root) {
    return (root.searchMode || "").length > 0 && root.searchGen > (root.searchOpenedGen || 0)
}

// A live re-answer keeps the cursor's file when the new window still names it, else row 0.
function keptIndex(name, items, start) {
    if (name === null || name === undefined) {
        return start
    }
    for (var i = 0; i < items.length; i++) {
        if (items[i].n === name) {
            return start + i
        }
    }
    return start
}

// A navigation drops the session without re-listing, so the next listing lands on clean state.
function leaveWalk(root) {
    if ((root.searchMode || "").length === 0) {
        return false
    }
    // One close per exit: tabs close the walk before the navigation closes it again.
    if (root.searchLeaving === true) {
        return true
    }
    // Results on screen keep their strip until the next listing lands; the backend closes now.
    if (live(root)) {
        if (root.backend) {
            root.backend.searchClose()
        }
        root.searchLeaving = true
        return true
    }
    return closeSession(root)
}

// Closing the session is one searchclose; a list closes it too, so a doubled close is silence.
function closeSession(root) {
    if ((root.searchMode || "").length === 0) {
        return false
    }
    if (root.backend) {
        root.backend.searchClose()
    }
    root.searchMode = OFF
    root.searchQuery = ""
    root.searchRunning = false
    root.searchCancelled = false
    root.searchScanned = 0
    root.searchFrom = ""
    root.searchBase = ""
    root.listingState = listingState(root, root.total)
    root.stateMessage = ""
    return true
}

// A terminal line answers only the newest gen this session sent; older gens drop with anything gen-less.
function accepts(root, gen) {
    return (root.searchMode || "").length > 0 && gen === root.searchGen && gen > (root.searchOpenedGen || 0)
}

// An exit landing clears the drawn search state in the same turn its rows do; the backend already closed.
function closeLeaving(root) {
    root.searchLeaving = false
    root.searchMode = OFF
    root.searchQuery = ""
    root.searchRunning = false
    root.searchCancelled = false
    root.searchScanned = 0
    root.searchFrom = ""
    root.searchBase = ""
}

// The answered counts land; the first window rides its own rows line, so nothing is asked for.
function searched(root, total, scanned, ms, cancelled, gen, walking) {
    // Answers for a session closed at its exit's request never land.
    if (root.searchLeaving === true) {
        return
    }
    if (!accepts(root, gen)) {
        return
    }
    root.searchRunning = walking === true
    root.searchCancelled = cancelled
    if (walking !== true) {
        root.searchSettledAt = Date.now()
    }
    root.total = total
    root.searchScanned = scanned
    root.searchMs = ms
    root.listingState = listingState(root, total)
    root.listArea.restartSettle()
}

// Query-line keys: enter keeps, escape leaves, tab rescopes, printables extend; cursor motions run through Focus.
function typeKey(event, root) {
    // Keys struck while the exit is out wait for the folder, the way any held listing holds them.
    if (root.searchLeaving === true) {
        return true
    }
    // Ctrl+V and Shift+Insert extend the query by the clipboard's first line, one generation (issue 287).
    if (Input.isPasteKey(event))
        return Input.pasteInto(root, function (text) { extend(root, text) })
    if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
        commit(root)
        return true
    }
    if (event.key === Qt.Key_Escape) {
        abort(root)
        return true
    }
    if (event.key === Qt.Key_Backspace) {
        shrink(root)
        return true
    }
    // Issue 30's control: tab flips the scope between the whole home directory and the one the pane
    // is standing in. It is the only writer, and nothing resets it, so the flip holds for the window;
    // ui/SearchStrip.qml draws "in <scope>" under the caret, so every search says which one it took.
    if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) {
        rescope(root)
        return true
    }
    if (Input.isPrintable(event.text)) {
        extend(root, event.text)
        return true
    }
    return true
}

// o on a result opens the directory that holds it and puts the cursor on the row, the design's reveal.
function reveal(root) {
    var row = root.rowFor(root.cursorIndex)
    if (!row) {
        return
    }
    var full = root.join(baseOf(root), row.n)
    var cut = full.lastIndexOf("/")
    if (cut <= 0) {
        return
    }
    root.recentMode = ""
    root.recentFrom = ""
    root.recentPaths = []
    // Through the pane: importing RecentMode.js here would close a Nav import cycle.
    root.restoreRecentSort()
    root.pendingSelect = full
    root.open(full.substring(0, cut))
}

// Read-only stopwatch for the newest gen; per-keystroke latency is measured off it.
function stamps(root) {
    return { gen: root.searchGen, keyAt: root.searchKeyAt || 0,
        firstRowsAt: root.searchFirstRowsAt || 0, settledAt: root.searchSettledAt || 0 }
}

// Rows on screen belong to a standing query: results in, folder out, whatever mode holds them.
function live(root) {
    return (root.searchMode || "").length > 0 && (root.searchQuery || "").length > 0
}

// What activating a row means right now. On a search result it takes
// you to the file instead of opening it; the canvas keeps enter on open and o on reveal, so it is
// only the pointer that asks this. ui/js/Tap.js is the one caller.
function activateAction(root) {
    return live(root) ? "reveal" : "open"
}

// A walk with no matches yet is still working, so the list area keeps the crawl rather than
// flashing the empty state at every directory that happens to hold nothing.
function listingState(root, total) {
    if (total > 0) {
        return "ready"
    }
    return root.searchRunning ? "loading" : "empty"
}

// Strip note as whole templates: the count with its crawl while the walk runs, alone landed.
var NOTE = { walking: "%1 found · still scanning", landed: "%1 found" }
function note(total, running, empty) {
    if (empty === true) {
        return ""
    }
    if (running) {
        return NOTE.walking.replace("%1", Format.count(total))
    }
    return NOTE.landed.replace("%1", Format.count(total))
}

// Empty-state caption for the query the shown answer is for; the function replacer keeps "$&" and "$$" in it literal.
function nothingMatches(answered) {
    if (answered.length === 0) {
        return ""
    }
    return "Nothing matches %1".replace("%1", function () { return answered })
}

// Strip right edge as whole templates: walking esc stops the walk, any other esc leaves.
var WAY = { walking: "esc cancels, then returns", done: "esc returns" }
function wayOut(running, empty) {
    if (running && empty !== true) {
        return WAY.walking
    }
    return WAY.done
}

// Row facilities join a row against the listing's base, the scope or the folder, never pane.path mid-session.
function baseOf(root) {
    return (root.searchBase || "").length > 0 ? root.searchBase : root.path
}

// The rule itself lives in Format.tilde, because the window chrome draws a path through the same one.
function scope(path, home) {
    return Format.tilde(path, home)
}

// The status bar's own left half while a search is up, the two lines the canvas draws.
function statusLine(running, total, scanned, ms) {
    if (running) {
        return Format.fill(WORDS.searching, Format.count(total), Format.count(scanned))
    }
    return Format.fill(WORDS.landed, Format.count(total), (ms / 1000).toFixed(1))
}
