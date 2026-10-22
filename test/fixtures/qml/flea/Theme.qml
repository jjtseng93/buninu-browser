pragma Singleton
import QtQuick
// Test theme, not Flea's Omarchy-dependent Theme.qml. Loaded normally via qmldir.
QtObject {
    property bool alternate: false
    readonly property var color: ({muted: alternate ? "#ffcc66" : "#70e1e8"})
    readonly property var font: ({family: "sans-serif", caption: 24})
}
