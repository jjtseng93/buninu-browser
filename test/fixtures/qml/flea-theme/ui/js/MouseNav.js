.pragma library

// The mouse's side buttons: Nav.js mouseBack takes refused, WindowBody.qml takes both after refusing its own overlays.

// No navigation closes the pane's context menu or the collision card, so a press behind one would act on another directory's rows.
function refused(pane) {
    return pane.menuVisible || !!(pane.collide && pane.collide.opened)
}

// Forward takes pane.goForward, the key's own entry, so Trash and Recent refuse it as they refuse the key.
function forward(pane) {
    if (!refused(pane)) pane.goForward()
}
