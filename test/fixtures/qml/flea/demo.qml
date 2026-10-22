import QtQuick
import QtQuick.Controls
import Quickshell
import "." as Flea
FloatingWindow {
    title: "Browser — Flea real import test"
    color: "#172b36"
    Column {
        width: parent.width - 64
        anchors.centerIn: parent
        spacing: 24
        Text { text: "Flea EscapeHint.qml — real import"; color: "white"; font.pixelSize: 24 }
        Text { text: "Local Theme.qml singleton (test theme)"; color: "#a9bcc6" }
        Item {
            width: parent.width; height: 50
            Flea.EscapeHint { id: first }
            Flea.EscapeHint { id: second; x: 180 }
        }
        Button {
            text: "Toggle shared theme"
            onClicked: { Flea.Theme.alternate = !Flea.Theme.alternate; }
        }
    }
}
