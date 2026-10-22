.pragma library

.import "BackReturn.js" as BackReturn
.import "DirSizes.js" as DirSizes
.import "Nav.js" as Nav
.import "Search.js" as Search
.import "Thumbs.js" as Thumbs

// Recent lists the history's paths under "/", newest first via mtime desc.
var OFF = ""
var RESULTS = "results"

// One refusal for both paste routes: the menu reaches past key dispatch, so it shares this.
function refusePaste(pane) {
    if (pane.recentMode.length > 0) {
        pane.message("Recent cannot take a paste. Open a folder first", false)
        return true
    }
    return false
}

// Open keeps where the pane stood and asks the history's paths after the bounded jump; spanning mounts leaves fsinfo unknown.
function run(pane, paths, visits) {
    // The history takes the place of a listing out; its answer is dropped by the folder it names, see ui/js/Swap.js onListed.
    if (pane.listInFlight) {
        pane.swap.stopWaiting()
        BackReturn.dropOwed(pane)
    }
    // The standing order is kept for the way back, not the mtime it replaces.
    if (pane.recentMode.length === 0 && pane.backend) {
        pane.recentSortBy = pane.backend.sortBy
        pane.recentSortDesc = pane.backend.sortDesc === true
    }
    if (pane.recentFrom.length === 0) {
        pane.recentFrom = Nav.place(pane)
    }
    // A history replaces the standing listing, so a live session closes first.
    Search.leaveWalk(pane)
    // The paths this listing stands on, so a refresh with the rail hidden still re-asks them.
    pane.recentPaths = paths || []
    pane.recentVisits = visits || ({})
    pane.listInFlight = true
    pane.listedSeen = false
    pane.path = "/"
    pane.recentMode = RESULTS
    pane.listingPath = "/"
    pane.storageClass = ""
    // Recent rows span filesystems, so the Tags row stays and the backend refuses each filesystem that cannot hold tags by name.
    pane.canTag = true
    pane.fsName = ""
    pane.fsFree = 0
    // Recent asks for no figures, so its empty slot is an answer.
    pane.fsAnswered = true
    var ask = {}
    // A walk closed above keeps its rows and its strip until the history lands.
    if (pane.searchLeaving === true) ask.holdWalk = true
    Nav.holdOrForget(pane, ask)
    pane.appliedListingPreferences = pane.listingPreferences
    pane.backend.listPaths(pane.recentPaths, pane.windowSize)
    // A deep anchored refresh asks its window only after the history's listpaths request.
    var anchor = pane.wire ? pane.wire.anchor : null
    if (anchor && anchor.path === pane.path && anchor.start > 0)
        pane.backend.window(anchor.start, pane.windowSize)
    pane.backend.sortBy = "mtime"
    pane.backend.sortDesc = true
}

// Leaving Recent re-lists the folder it was opened over, pushing no history entry.
function close(pane) {
    var back = pane.recentFrom.length > 0 ? pane.recentFrom : "/"
    leave(pane)
    pane.openWithoutHistory(back, { supersede: true })
}

// The order run() replaced, handed back before the folder re-lists.
function restoreSort(pane) {
    if (pane.backend && typeof pane.recentSortBy === "string" && pane.recentSortBy.length > 0) {
        pane.backend.sortBy = pane.recentSortBy
        pane.backend.sortDesc = pane.recentSortDesc === true
    }
    pane.recentSortBy = ""
    pane.recentSortDesc = false
}

// Every way out of Recent, a plain hop, Escape, a tab switch and reveal, leaves through this one step, so each restores the same order.
function leave(pane) {
    if (pane.recentMode.length > 0) {
        restoreSort(pane)
    }
    pane.recentMode = OFF
    pane.recentFrom = ""
    pane.recentPaths = []
    pane.recentVisits = ({})
}

// Refresh re-reads history after an operation, never re-listing "/" over it; an unloaded sidebar re-asks the standing paths.
function refresh(pane, selectPath) {
    // A re-ask of the history is no navigation, so it never takes the place of a listing out.
    if (pane.listInFlight) {
        pane.message("A directory is already loading.", false)
        return
    }
    pane.pendingSelect = selectPath ? selectPath : ""
    pane.pendingMenu = false
    if (pane.sidebar) {
        pane.sidebar.readRecent(pane)
        return
    }
    run(pane, pane.recentPaths || [], pane.recentVisits)
}

// Only the held viewport rows gain a Used stamp; filesystem metadata remains intact.
function stampRows(pane, rows) {
    if (pane.recentMode !== RESULTS) return rows
    return rows.map(function (row) {
        var visit = (pane.recentVisits || {})[pane.join(pane.path, row.n)]
        return Object.assign({}, row, { used: visit === undefined ? null : visit })
    })
}

// The folder a tab records on a history, "" elsewhere, so it lands where it stood.
function restingPath(pane) {
    return pane.recentMode === RESULTS && pane.recentFrom.length > 0 ? pane.recentFrom : ""
}

// A tab switch drops the mode and says whether it dropped one.
function dropOverlay(pane) {
    if (pane.recentMode.length === 0) {
        return false
    }
    leave(pane)
    return true
}

// o opens the row's own folder; Enter opens the file itself, so the two cannot disagree.
function reveal(pane) {
    if (pane.listInFlight) {
        pane.message("A directory is already loading.", false)
        return
    }
    var row = pane.rowFor(pane.cursorIndex)
    if (!row) {
        return
    }
    var full = pane.join(pane.path, row.n)
    var cut = full.lastIndexOf("/")
    if (cut < 0) {
        return
    }
    var dir = cut === 0 ? "/" : full.substring(0, cut)
    leave(pane)
    pane.pendingSelect = full
    pane.openWithoutHistory(dir)
}
