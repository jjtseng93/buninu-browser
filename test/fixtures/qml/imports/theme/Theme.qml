pragma Singleton
import QtQuick
QtObject {
    id: root
    property int count: 1
    readonly property color ink: "#70e1e8"
    function bump() { root.count++; }
}
