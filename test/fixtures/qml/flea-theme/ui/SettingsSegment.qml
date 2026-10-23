import QtQuick
import "." as Flea
import "js/Buttons.js" as Buttons

// The Display board's two-value control: both names side by side, the current one bright, rather than
// the chevron walk a longer list needs. ui/SettingsRow.qml draws it for any row whose model names its
// options, and the row above owns the writer, so nothing here holds state.
Row {
    id: root

    property var options: []
    property string value: ""
    property var glyphs: []
    // A host that puts the row in its Tab order (a dialog's Format) sets this; Settings never focuses it.
    property bool tabStop: false
    // The hit minimum in Settings; a chrome strip hosts the same cells at its control height.
    property int cellHeight: Theme.hitMin

    // The option a pointer chose, which is never the one already showing.
    signal picked(int index)

    spacing: Theme.spacing.hairline * Buttons.SEGMENT_GAP

    Repeater {
        model: root.options

        delegate: Rectangle {
            id: segment
            required property var modelData
            required property int index

            readonly property bool current: segment.modelData === root.value
            readonly property string glyph: root.glyphs[segment.index] || ""
            // A segment that takes the keyboard (a dialog's Tab stop) marks its current cell as DialogButton marks a focused set member.
            readonly property bool focusedHere: root.tabStop && segment.current && root.activeFocus && segment.glyph.length === 0
            // Accent where it has hue, else RING wide in the foreground, both inside the cell like DialogButton's set member.
            readonly property string focusFrame: Buttons.focusFrame(Theme.color.accentHasHue, true, false)

            // The WCAG floor the Blueprint sets for a compact control, which this row has room for.
            width: segment.glyph ? Math.max(Theme.hitMin, Theme.railIconSize + 2 * (Theme.spacing.gap - Theme.spacing.hairline))
                                 : name.implicitWidth + 2 * Theme.spacing.gap
            height: root.cellHeight
            // Containers rule 4: a segmented cell is never filled, so the choice reads as brightness.
            color: "transparent"
            // Rule 3: words in a set are Tier B and every member wears the box; glyphs in a strip are
            // Tier A, where a box around four marks would be furniture.
            border.width: segment.glyph ? 0 : segment.focusedHere && segment.focusFrame === "thick" ? Buttons.RING : Theme.spacing.hairline
            border.color: segment.focusedHere && segment.focusFrame === "accent" ? Theme.color.accent
                : segment.current ? Theme.color.foreground : Theme.color.mutedFrame
            Accessible.role: Accessible.Button
            Accessible.name: String(segment.modelData)
            Accessible.onPressAction: root.picked(segment.index)

            Flea.Glyph {
                anchors.centerIn: parent
                visible: segment.glyph.length > 0
                width: Theme.railIconSize
                height: width
                name: segment.glyph || "file"
                color: segment.current ? Theme.color.foreground : Theme.color.mutedFrame
            }

            Text {
                id: name
                visible: segment.glyph.length === 0
                anchors.centerIn: parent
                text: segment.modelData
                color: segment.current ? Theme.color.foreground : Theme.color.muted
                font.family: Theme.font.family
                font.pixelSize: Theme.font.caption
                textFormat: Text.PlainText
            }

            HoverHandler {
                cursorShape: Qt.PointingHandCursor
            }

            TapHandler {
                acceptedButtons: Qt.LeftButton
                gesturePolicy: TapHandler.ReleaseWithinBounds
                onTapped: if (!segment.current) root.picked(segment.index)
            }
        }
    }
}
