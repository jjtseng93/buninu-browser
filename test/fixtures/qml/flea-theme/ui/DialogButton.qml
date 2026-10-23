import QtQuick
import qs.Commons
import "js/Buttons.js" as Buttons

// The one control every dialog, card, picker button and strip action draws.
Item {
    id: root

    property string label: ""
    property bool primary: false
    // A destructive action rests as the error label in a muted frame, never primary.
    property bool destructive: false
    property real horizontalPadding: Theme.spacing.gap
    // An unavailable action shows muted ink and its press does nothing.
    property bool available: true
    // The keyboard's own signal. Callers whose focus sits on a wrapper pass it down.
    property bool focused: root.activeFocus
    // True where the form owns the Tab order and the button only reports through tabbed.
    property bool tabHandle: false
    // A stop in its dialog's own Tab walk; while unavailable it is disabled, so it leaves the walk and keeps its look.
    property bool tabStop: false
    // A member of a set (the protocols): its frame and label are foreground while it is the current one and muted otherwise.
    property bool setMember: false
    property bool current: false
    // Hosted in the chrome strip: a Theme.chromeHeight press area around a Theme.chromeControlHeight frame at caption size, and Tab reaches it.
    property bool inStrip: false

    // The pointer's own state, read by the native capture harness before it shoots a hover or a press.
    readonly property bool hovered: hover.hovered
    readonly property bool pressed: tap.pressed
    // A release activates only inside the press area, so a held point outside draws the resting control.
    readonly property bool pressShown: root.pressed && root.available && tap.point.position.x >= 0 && tap.point.position.x < root.width
        && tap.point.position.y >= 0 && tap.point.position.y < root.height

    signal activated()
    // The form owns the order; a button only reports that Tab happened inside it.
    signal tabbed(var from, bool back)

    // Focus is the control's own frame: foreground, or accent for a set member where it has hue. Where a hairline would match the rest (a primary whose rest frame is the foreground, a set member without hue) the frame draws RING wide.
    readonly property string focusFrame: Buttons.focusFrame(Theme.color.accentHasHue, root.setMember, root.primary && Qt.colorEqual(Theme.color.accentFrame, Theme.color.foreground))
    readonly property bool focusShown: root.focused && root.available
    // A secondary frame takes mutedFrame, ThemeRoles' border role, under a live label; a set member takes foreground while current and mutedFrame otherwise.
    readonly property color frame: root.focusShown && root.focusFrame === "accent" ? Theme.color.accent
        : root.focusShown ? Theme.color.foreground
        : root.setMember ? (root.current ? Theme.color.foreground : Theme.color.mutedFrame)
        : root.primary && root.available ? Theme.color.accentFrame : Theme.color.mutedFrame
    readonly property color ink: !root.available || root.setMember && !root.current ? Theme.color.muted
        : root.destructive ? Theme.color.error : Theme.color.foreground
    // The frame and this wash say which action is being asked for; the label stays foreground.
    readonly property color wash: root.primary && root.available ? Qt.alpha(Theme.color.accent, Buttons.WASH_PRIMARY) : "transparent"
    // A border draws inside its rectangle, so the thick frame grows inward and nothing moves.
    readonly property int frameWidth: root.focusShown && root.focusFrame === "thick" ? Buttons.RING : Theme.spacing.hairline

    // A chrome strip's press area fills the strip and centres the control height above its rule.
    readonly property real frameHeight: root.inStrip ? Theme.chromeControlHeight : root.height
    readonly property real frameY: root.inStrip ? Math.round((root.height - Theme.spacing.hairline - root.frameHeight) / 2) : 0

    implicitWidth: Math.max(Theme.hitMin, text.implicitWidth + 2 * root.horizontalPadding + 2 * Theme.spacing.hairline)
    implicitHeight: root.inStrip ? Theme.chromeHeight : Theme.rowHeight - Theme.spacing.rowPaddingY
    // A strip control or a tab stop stays in the Tab chain and drops out as a disabled item; flipping activeFocusOnTab under a focused control only warns.
    activeFocusOnTab: root.inStrip || root.tabStop
    enabled: root.available || !root.inStrip && !root.tabStop
    opacity: root.available ? 1 : Buttons.DISABLED_OPACITY

    Accessible.role: Accessible.Button
    Accessible.name: root.label
    Accessible.onPressAction: if (root.available) root.activated()

    Item {
        id: box
        y: root.frameY
        width: parent.width
        height: root.frameHeight

        // Only the frame and wash shrink: native text loses thin stems under a non-integer scale.
        Item {
            id: chrome
            property int insetX: root.pressShown && !Theme.reducedMotion ? Math.round(box.width * (1 - Buttons.PRESS_SCALE) / 2) : 0
            property int insetY: root.pressShown && !Theme.reducedMotion ? Math.round(box.height * (1 - Buttons.PRESS_SCALE) / 2) : 0
            x: chrome.insetX
            y: chrome.insetY
            width: Math.round(box.width) - 2 * chrome.insetX
            height: Math.round(box.height) - 2 * chrome.insetY
            Behavior on insetX {
                enabled: !Theme.reducedMotion
                NumberAnimation { duration: Buttons.PRESS_MS; easing.type: Easing.OutCubic }
            }
            Behavior on insetY {
                enabled: !Theme.reducedMotion
                NumberAnimation { duration: Buttons.PRESS_MS; easing.type: Easing.OutCubic }
            }
            Rectangle {
                objectName: "buttonFrame"
                anchors.fill: parent
                color: root.wash
                border.width: root.frameWidth
                border.color: root.frame
            }
            // Hover and press lay the control's own ink inside the frame at its width.
            Rectangle {
                objectName: "buttonWash"
                anchors.fill: parent
                anchors.margins: root.frameWidth
                color: root.pressShown ? Qt.alpha(root.ink, Buttons.WASH_PRESS)
                    : !root.pressed && hover.hovered && root.available ? Qt.alpha(root.ink, Buttons.WASH_HOVER) : "transparent"
            }
        }

        Text {
            id: text
            objectName: "buttonLabel"
            anchors.centerIn: parent
            text: root.label
            color: root.ink
            font.family: Theme.font.family
            font.pixelSize: root.inStrip ? Theme.font.caption : Theme.font.body
            textFormat: Text.PlainText
        }
    }

    HoverHandler {
        id: hover
        cursorShape: root.available ? Qt.PointingHandCursor : Qt.ArrowCursor
    }

    // A held key's repeats never activate again, so a key held past a focus move cannot press the next button.
    function keyActivate(event) { if (!root.available) event.accepted = false; else if (!event.isAutoRepeat) root.activated() }

    // A focused button answers Enter exactly as a press does; a handled Tab is accepted here so Qt never moves focus past the form's own stepFocus order.
    Keys.onReturnPressed: function(event) { root.keyActivate(event) }
    Keys.onEnterPressed: function(event) { root.keyActivate(event) }
    Keys.onSpacePressed: function(event) { root.keyActivate(event) }
    Keys.onTabPressed: function(event) {
        if (!root.tabHandle) { event.accepted = false; return }
        root.tabbed(root, (event.modifiers & Qt.ShiftModifier) !== 0)
        event.accepted = true
    }
    Keys.onBacktabPressed: function(event) {
        if (!root.tabHandle) { event.accepted = false; return }
        root.tabbed(root, true)
        event.accepted = true
    }

    TapHandler {
        id: tap
        acceptedButtons: Qt.LeftButton
        gesturePolicy: TapHandler.ReleaseWithinBounds
        onTapped: if (root.available) root.activated()
    }
}
