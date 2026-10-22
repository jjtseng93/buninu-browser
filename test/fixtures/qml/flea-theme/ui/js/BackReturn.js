.pragma library

// Back and Forward entries and the landing ui/PaneSwap.qml runs in the rows' turn.

// A stack entry names the directory and the row its cursor stood on; bare paths read as empty rows.
function makeEntry(path, name, index) {
    return { path: String(path), name: String(name || ""), index: Math.max(0, Math.floor(Number(index) || 0)) }
}

function pathOf(entry) {
    return typeof entry === "string" ? entry : String(entry.path || "")
}

function asEntry(target) {
    return typeof target === "string" ? makeEntry(target, "", 0) : target
}

// The place a listing still out asked for, with the cursor its Back or Forward owes it; null when none is out or it re-reads the drawn folder.
function pending(pane) {
    if (!pane.listInFlight || !pane.listingPath || pane.listingPath === pane.path)
        return null
    var owed = pane.swap ? pane.swap.restore : null
    if (owed && owed.path === pane.listingPath)
        return makeEntry(owed.path, owed.name, owed.index)
    return makeEntry(pane.listingPath, "", 0)
}

// A tab switch left its cursor, order and located row to its landing; the listing let go never lands, so a later one must not take them.
function dropOwed(pane) {
    if (pane.tabs)
        Object.assign(pane.tabs, { pendingCursor: -1, pendingCursorName: null, pendingLocatePath: "", pendingSortBy: "", pendingSortDesc: false })
}

// The stack a Back or Forward still out pushed the drawn place onto, or "" when the listing out is any other.
function pushedOnto(pane) {
    var owed = pending(pane) && pane.swap ? pane.swap.restore : null
    return owed && owed.pushedOnto ? owed.pushedOnto : ""
}

// The drawn folder with the cursor row it stands on; leaving a walk names no row, so the landing stays at the top.
function drawn(pane) {
    var walk = pane.searchMode === "results" || (pane.searchFrom || "").length > 0
    var row = !walk && pane.rowFor ? pane.rowFor(pane.cursorIndex) : null
    return makeEntry(pane.path, row ? row.n : "", walk ? 0 : pane.cursorIndex)
}

// The departing cursor, or the pending place while a listing is out.
function capture(pane) {
    return pending(pane) || drawn(pane)
}

// One step through the stacks after Nav's guard, popping before the open pushes back.
function travel(pane, from, to) {
    var stack = pane[from]
    var target = asEntry(stack[stack.length - 1])
    pane[to] = (pane[to] || []).concat([capture(pane)])
    pane[from] = stack.slice(0, -1)
    pane.openWithoutHistory(pathOf(target), { restore: Object.assign({}, target, { pushedOnto: to }), supersede: true })
}

// The landing in the rows reply's turn: name, then clamped index, then the top.
function landRestore(pane, entry) {
    if (!entry)
        return
    if (pane.path !== entry.path || (pane.searchMode || "").length > 0 || pane.total === 0)
        return
    var name = String(entry.name || "")
    if (name.length > 0) {
        for (var i = 0; i < pane.rows.length; i++) {
            if (String(pane.rows[i].n) === name) {
                pane.setCursor(pane.held + i)
                return
            }
        }
    }
    pane.setCursor(Math.min(entry.index, pane.total - 1))
}

// True when a Back listing's first window lacks the owed name: the existing locate is sent and the rows wait for its window.
function deferForLocate(pane, entry, items, listed) {
    if (!entry || entry.pendingPath || !listed || listed.path !== entry.path)
        return false
    var name = String(entry.name || "")
    if (name.length === 0 || !(listed.total > items.length) || (pane.searchMode || "").length > 0)
        return false
    for (var i = 0; i < items.length; i++) {
        if (String(items[i].n) === name)
            return false
    }
    if (!(pane.windowSize > 0) || typeof pane.backend.window !== "function")
        return false
    entry.pendingPath = pane.join(entry.path, name)
    entry.total = listed.total
    pane.backend.send({ c: "locate", path: entry.pendingPath })
    return true
}

// The locate reply for a waiting landing fetches the window holding the row, or the clamped index on a miss.
function takeLocated(pane, message) {
    var entry = pane.swap ? pane.swap.restore : null
    if (!entry || !entry.pendingPath || entry.fetched || !message
            || message.path !== entry.pendingPath || message.directory !== entry.path)
        return false
    var index = Number(message.index)
    if (!(index >= 0) || index >= entry.total)
        index = Math.min(entry.index, entry.total - 1)
    entry.fetched = true
    pane.backend.window(index, pane.windowSize)
    return true
}
