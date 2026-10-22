.pragma library

// Neighbour-column background menus: a peek's empty space navigates to its DRAWN directory (parent/ancestor or shownChildPath, never pending childPath) and opens the background menu once its rows land.

// A trailing slash trimmed except at the root itself.
// Sample input: trimSlash("/home/gm/") is "/home/gm".
function trimSlash(path) {
    var text = String(path)
    return text.length > 1 && text.charAt(text.length - 1) === "/" ? text.substring(0, text.length - 1) : text
}

// True when two paths name the same directory, trailing slash aside.
// Sample input: samePath("/a/", "/a") is true.
function samePath(a, b) {
    return trimSlash(a) === trimSlash(b)
}

// "" when a background intent may arm, else the busy reason: rejects before any intent is stored, so a refused open never leaves one behind.
// Sample input: canArm({listInFlight: true}) is "loading".
function canArm(pane) {
    if (!pane)
        return "no pane"
    if (pane.listInFlight === true)
        return "loading"
    if (pane.trash && (pane.trash.opened === true || pane.trash.confirming === true))
        return "trash"
    if (pane.searchMode && pane.searchMode.length > 0)
        return "search"
    if (pane.collide && (pane.collide.opened === true || pane.collide.pending !== null))
        return "collide"
    if (pane.menuVisible === true)
        return "menu"
    if (pane.menuActions && pane.menuActions.opened === true)
        return "menu"
    if (pane.renamingIndex >= 0 || pane.renamePending === true)
        return "rename"
    if (pane.filterTyping === true)
        return "filter"
    if (pane.selectionBand !== null && pane.selectionBand !== undefined)
        return "band"
    return ""
}

// True when the target is already shown: open the menu where it stands, no navigation.
// Sample input: directOpen("/a", "/a/") is true.
function directOpen(target, panePath) {
    return target.length > 0 && samePath(target, panePath)
}

// True when landed rows may open the deferred menu: the pending target names this listing and it succeeded; empty counts because an empty directory is where the menu matters most, while locked, error and loading drop the intent.
// Sample input: shouldOpen("/a", "/a", "ready") is true.
function shouldOpen(panePath, pending, listingState) {
    if (!pending || pending.length === 0)
        return false
    if (!samePath(panePath, pending))
        return false
    return listingState === "ready" || listingState === "empty"
}

// A failed listing drops the deferred menu, so no later rows open it.
function clearPendingBackground(pane) {
    if (!pane)
        return
    pane.pendingBackground = ""
    pane.pendingBackgroundAt = null
}

// The deferred neighbour background, consumed either way so later rows never open it: opens only a successful listing of the drawn target, at the stored point.
function applyPendingBackground(pane) {
    if (!pane || !pane.pendingBackground || pane.pendingBackground.length === 0)
        return
    var target = pane.pendingBackground
    var at = pane.pendingBackgroundAt
    pane.pendingBackground = ""
    pane.pendingBackgroundAt = null
    if (!shouldOpen(pane.path, target, pane.listingState))
        return
    if (pane.searchMode && pane.searchMode.length > 0)
        return
    if (pane.trash && pane.trash.opened)
        return
    if (at === null || at === undefined)
        return
    pane.openBackgroundMenu(at)
}

// Routes one neighbour background for the columns view: busy refuses before any intent is stored, the shown folder opens its menu where it stands, and any other target navigates with the menu waiting on its rows. Answers opened, navigating, ignored or refused:<reason>.
// Sample input: routeBackground({path: "/a"}, "/a", {x: 1}, {openBackground: function () {}}) is "opened".
function routeBackground(pane, base, scenePoint, menu) {
    if (!pane || !base || base.length === 0 || !scenePoint)
        return "ignored"
    var busy = canArm(pane)
    if (busy.length > 0) {
        if (busy === "loading")
            pane.message("A directory is already loading.", false)
        return "refused:" + busy
    }
    if (directOpen(base, pane.path)) {
        menu.openBackground(scenePoint)
        return "opened"
    }
    pane.pendingBackground = base
    pane.pendingBackgroundAt = scenePoint
    pane.open(base)
    if (!pane.listInFlight) {
        pane.pendingBackground = ""
        pane.pendingBackgroundAt = null
        return "refused:not-started"
    }
    return "navigating"
}
