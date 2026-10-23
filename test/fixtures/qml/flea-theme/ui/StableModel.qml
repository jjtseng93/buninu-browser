import QtQuick
import QtQml.Models

// A view's row count as a model that never changes identity, so a new count keeps the delegates that stay drawn.
DelegateModel {
    id: root

    required property Item view
    property int total: 0
    // The compositor is filled in componentComplete, so a group change before onCompleted is silently dropped.
    property bool ready: false

    // A move asked for inside the change's own layout is dropped, so a view that places itself does it here.
    signal resized()

    // Qt refuses an integer model larger than 100,000,000 rows.
    readonly property int cap: 100000000
    model: root.cap
    groups: DelegateModelGroup { id: shown; name: "shown"; includeByDefault: false }
    filterOnGroup: "shown"

    // While true a view short of a viewport keeps a full layout's delegates in its reuse pool, so a count that grows takes them instead of building.
    property bool warm: false
    // The rows a full layout from the top builds, its cache buffer's included: the fill lays out no more, so none is left incubating.
    property int warmRows: 0

    // While true a count change leaves the current delegate current: Qt focuses each new current delegate, which takes the keys from an editor inside the old one.
    property bool holdCurrent: false

    onTotalChanged: root.resize()
    onWarmChanged: if (root.warm) root.fill()
    Component.onCompleted: { root.ready = true; root.resize() }

    // Grows the count and shrinks it back in one turn, so no frame sees the rows and what they laid out waits pooled; a geometry change drains it.
    function fill() {
        var from = shown.count
        var to = Math.min(root.warmRows, root.cap)
        if (!root.ready || !root.view.reuseItems || to <= from)
            return
        // The buffer's rows lay out with the viewport's for this pass, built at once where a buffer pass would incubate them later.
        var margin = root.view.displayMarginEnd
        root.view.displayMarginEnd = margin + root.view.cacheBuffer + root.view.height
        root.items.addGroups(from, to - from, "shown")
        root.view.forceLayout()
        shown.removeGroups(from, to - from, "shown")
        root.view.forceLayout()
        root.view.displayMarginEnd = margin
    }

    // Moves to the top and, unless holdCurrent, row 0 as a reset does, before the change, so only top rows lay out and a view placing itself after keeps its place.
    function resize() {
        var to = Math.min(Math.max(root.total, 0), root.cap)
        var from = shown.count
        if (!root.ready || to === from)
            return
        root.view.contentY = root.view.originY - root.view.topMargin
        if (from > 0 && to > 0 && !root.holdCurrent)
            root.view.currentIndex = 0
        if (to > from)
            root.items.addGroups(from, to - from, "shown")
        else
            shown.removeGroups(to, from - to, "shown")
        // Lays out now: Qt pools a layout's removed rows only after building its inserted ones, so the next count reuses them.
        root.view.forceLayout()
        if (to > 0 && root.view.currentIndex < 0)
            root.view.currentIndex = 0
        root.resized()
        if (to === 0)
            root.drainHidden()
    }

    // True where a hidden count is rows kept for the return rather than an edit in flight, so the hide drains the pool beside them.
    property bool keptRows: false
    // A hidden view holds no delegates, pooled ones included; a shown one keeps its pool, parked, for the next listing.
    function drainHidden() {
        if (root.view.visible || shown.count > 0 && !root.keptRows || !root.view.reuseItems)
            return
        // Unpersist first so the pool toggle below frees the parked tiles too.
        if (persistedItems.count > 0)
            persistedItems.removeGroups(0, persistedItems.count, "persistedItems")
        root.view.reuseItems = false
        root.view.reuseItems = true
    }
    // A view hidden after it emptied drains here, since its count does not change again.
    property Connections hiding: Connections {
        target: root.view
        function onVisibleChanged() { root.drainHidden() }
    }
}
