import QtQuick

// The Display board's seven-stop ruler: one tick per size Omarchy offers, each carrying its own
// number, with the stop in force marked by a taller tick under a foreground number rather than by a
// fill nobody could read (SettingsRest rule 2). The marked tick takes the accent once an override
// makes the ruler the control, which is the Blueprint's own rule for an active control against a
// quiet one, and stays muted while Omarchy owns the size and the ruler is only reporting it.
Item {
    id: root

    property var stops: []
    // The last filled tick. Omarchy can be on a size that is not a stop, so the caller fills to the
    // nearest one rather than leaving the ruler blank.
    property int index: -1
    property bool active: false

    signal picked(int stop)

    readonly property int tickGap: Theme.spacing.hairline * 2
    readonly property int tickHeight: Theme.spacing.hairline * 3
    // The board's own 7 against 11: the stop in force stands taller, so the mark is never a colour alone.
    readonly property int markedHeight: Theme.spacing.hairline * 5
    // And the board's own 2 against 3 across; the tap target is the slot behind the ink, so a mark this narrow still answers a click anywhere on its stop.
    readonly property int tickInk: Theme.spacing.hairline * 2
    readonly property int markedInk: Theme.spacing.hairline * 3
    // The hairline treatment the panel already uses for a quiet edge, so an unmarked stop reads as one.
    readonly property real restOpacity: 0.4
    readonly property real tickWidth: root.stops.length > 0
        ? (root.width - root.tickGap * (root.stops.length - 1)) / root.stops.length : 0
    readonly property real numberHeight: Theme.font.caption * 1.5
    // WCAG 2.5.8's floor under the tap target, whatever height the numbers and ticks come to.
    readonly property int hitHeight: Math.max(Theme.hitMin, Math.round(root.numberHeight + root.markedHeight))

    implicitHeight: root.hitHeight

    Repeater {
        model: root.stops

        delegate: Item {
            id: tick
            required property var modelData
            required property int index
            readonly property bool marked: tick.index === root.index

            // The hit box is taller than the drawn tick and centred on the ruler, so it moves nothing.
            x: tick.index * (root.tickWidth + root.tickGap)
            y: Math.round((root.height - tick.height) / 2)
            width: root.tickWidth
            height: root.hitHeight

            Text {
                id: number
                anchors.horizontalCenter: parent.horizontalCenter
                y: Math.round((root.numberHeight - implicitHeight) / 2)
                text: tick.modelData
                color: tick.marked ? Theme.color.foreground : Theme.color.muted
                opacity: tick.marked ? 1 : root.restOpacity
                font.family: Theme.font.family
                font.pixelSize: Theme.font.caption
                textFormat: Text.PlainText
            }

            Rectangle {
                anchors.horizontalCenter: parent.horizontalCenter
                y: Math.round(root.numberHeight)
                width: tick.marked ? root.markedInk : root.tickInk
                height: tick.marked ? root.markedHeight : root.tickHeight
                color: root.active && tick.marked ? Theme.color.accent : Theme.color.mutedFrame
                opacity: tick.marked ? 1 : root.restOpacity
            }

            HoverHandler {
                enabled: root.active
                cursorShape: Qt.PointingHandCursor
            }

            TapHandler {
                enabled: root.active
                acceptedButtons: Qt.LeftButton
                gesturePolicy: TapHandler.ReleaseWithinBounds
                onTapped: root.picked(tick.modelData)
            }
        }
    }
}
