import QtQuick
import Quickshell
FloatingWindow {
    id: root
    title: "QML DOM experiment"
    color: "#172b36"
    property int count: 0
    Rectangle {
        id: button
        width: parent.width / 2
        height: 100
        anchors.centerIn: parent
        color: root.count % 2 ? "#245c66" : "#26404d"
        radius: 12
        Text {
            anchors.centerIn: parent
            text: "Hello World! Clicks: " + root.count
            color: "#70e1e8"
            font.pixelSize: 24
        }
        MouseArea {
            anchors.fill: parent
            onClicked: { root.count++; }
        }
    }
}
