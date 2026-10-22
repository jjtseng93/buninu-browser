.pragma library

// The resolve and the viewport restore Anchor.js calls, split out at its hard cap.

function holdLeaf(path) {
    var text = String(path || "")
    var cut = text.lastIndexOf("/")
    return cut < 0 ? text : text.substring(cut + 1)
}

// The row height the anchor measures in: a grid tile row in the grid view, a text row elsewhere.
function rowHeight(pane, rowH) {
    if (pane.viewMode === "grid" && pane.listArea && typeof pane.listArea.cellHeightPx === "number")
        return pane.listArea.cellHeightPx
    return rowH || pane.anchorRowHeight
}

// The cursor's view position as a restorable row: a tile row in the grid view, a list row elsewhere.
function viewRow(pane) {
    var view = cursorView(pane)
    if (pane.viewMode === "grid" && pane.listArea && typeof pane.listArea.columns === "number" && pane.listArea.columns > 0)
        return Math.floor(view / pane.listArea.columns)
    return view
}

// The surface that scrolls: the active column's own list in the columns view, the pane's list area elsewhere.
function viewport(pane) {
    if (pane.viewMode === "columns" && pane.columnsArea)
        return pane.columnsArea.activeColumn().viewport
    return pane.listArea || null
}

// Where the cursor row sits in the viewport, which restoreView puts back once a re-list has reset the view to its top.
function viewFields(pane, rowH) {
    var area = viewport(pane)
    var rh = rowHeight(pane, rowH)
    var view = viewRow(pane)
    var contentY = area && typeof area.contentY === "number" ? area.contentY : 0
    var originY = area && typeof area.originY === "number" ? area.originY : 0
    return { offset: view * rh + originY - contentY, rowH: rh, view: view }
}

// Lists the anchor's own directory; a navigation while the anchor waited drops the anchor and lists nothing, so the debt never travels.
function startList(pane, anchor) {
    if (!anchor || pane.path !== anchor.path)
        return null
    if (pane.recentMode && pane.recentMode.length > 0) {
        // Recent may deliver cached history synchronously, so its run must already see the anchor.
        pane.wire.anchor = anchor
        pane.refresh("")
        return anchor
    }
    pane.openWithoutHistory(anchor.path, { keptQuery: pane.filterQuery, wantChanged: anchor.wantChanged === true, inPlace: true })
    if (anchor.wantChanged) {
        pane.reloadFrom = anchor.reloadFrom
        pane.reloadChanged = -1
    }
    if (anchor.start > 0)
        pane.backend.window(anchor.start, pane.windowSize)
    return anchor
}

function fillPaths(pane, anchor, list) {
    if (!anchor || !anchor.needPaths)
        return anchor
    var need = anchor.needPaths
    for (var i = 0; i < need.length && i < list.length; i++) {
        var path = String(list[i] || "")
        var nm = pane.recentMode && pane.recentMode.length > 0 ? path.substring(1) : holdLeaf(path)
        for (var m = 0; m < anchor.marks.length; m++) {
            if (anchor.marks[m].index === need[i])
                anchor.marks[m].name = nm
        }
    }
    anchor.needPaths = null
    if (pane.pathsPending && pane.pathsPending.kind === "anchor")
        pane.pathsPending = null
    return startList(pane, anchor)
}

function cursorView(pane) {
    if (pane.shown === null || pane.shown === undefined)
        return pane.cursorIndex
    var at = pane.shown.indexOf(pane.cursorIndex)
    return at < 0 ? 0 : at
}

// A renamed row that sorts outside the held window is asked of the backend, which alone knows where it landed; the anchor waits for the reply.
// Sample output: {"c":"locate","paths":["/d/zzz.txt"],"id":2147483649}
function locateRenamed(pane, anchor) {
    if (!anchor.renamed || anchor.locateDone || pane.total <= 0)
        return false
    if (anchor.locateSent)
        return true
    if (!pane.backend || !pane.backend.send)
        return false
    pane.backend.send({ c: "locate", paths: [pane.join(pane.path, anchor.name)], id: anchor.locateId })
    anchor.locateSent = true
    return true
}

// The located renamed row takes the cursor and the selection and is revealed, with its own window asked for when the rows are not held.
function landRenamed(pane, anchor, found) {
    if (found === undefined || !(found >= 0 && found < pane.total))
        return
    // The reveal clamps against the laid-out height, and the count that just passed through 0 has not laid out yet.
    var area = viewport(pane)
    if (area && typeof area.forceLayout === "function")
        area.forceLayout()
    pane.selectOnly(found)
    if (!pane.rowFor(found))
        pane.backend.window(found, pane.windowSize)
    anchor.landed = true
}

function fillLocated(pane, anchor, matches) {
    if (!anchor)
        return null
    anchor.locateDone = true
    var byPath = {}
    for (var i = 0; i < (matches || []).length; i++) {
        var item = matches[i]
        byPath[String(item.path || "")] = Number(item.index)
    }
    if (anchor.renamed)
        landRenamed(pane, anchor, byPath[pane.join(pane.path, anchor.name)])
    var pending = []
    for (var m = 0; m < (anchor.marks || []).length; m++) {
        var mark = anchor.marks[m]
        var key = (mark.name !== null && pane.join) ? pane.join(pane.path, mark.name) : ""
        var at = byPath[key]
        if (at !== undefined && at >= 0)
            anchor.kept.push(at)
        else if (mark.name !== null)
            pending.push(mark)
    }
    anchor.marks = pending
    return anchor
}

function restoreView(pane, anchor, rowH) {
    var area = viewport(pane)
    if (!area || anchor.offset === undefined)
        return
    // The count that just passed through 0 has not laid out yet, and a clamp against its stale height pins the view to the top.
    if (typeof area.forceLayout === "function")
        area.forceLayout()
    var rh = rowHeight(pane, rowH || anchor.rowH)
    var originY = typeof area.originY === "number" ? area.originY : 0
    var view = viewRow(pane)
    var y = view * rh + originY - anchor.offset
    // A restore past either end draws a blank strip, so clamp to the area's valid range when it names one.
    if (typeof area.contentY === "number") {
        if (typeof area.contentHeight === "number" && typeof area.height === "number") {
            // The grid's top margin holds its resting contentY at originY less the margin, so the valid range takes both margins.
            var lo = originY - (typeof area.topMargin === "number" ? area.topMargin : 0)
            var hi = Math.max(lo, area.contentHeight - area.height + originY + (typeof area.bottomMargin === "number" ? area.bottomMargin : 0))
            y = Math.max(lo, Math.min(hi, y))
        }
        area.contentY = y
    }
}
