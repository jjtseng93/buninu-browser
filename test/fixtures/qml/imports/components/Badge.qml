import QtQuick
import "../theme"
import "../logic/counter.js" as Counter
import "../logic/shared.js" as Shared
Rectangle {
    id: root
    property string caption: "default"
    property int serial: 0
    property int sharedSerial: 0
    property alias value: label.text
    width: 320; height: 60
    color: "#26404d"
    Text { id: label; x: 10; y: 10; color: Theme.ink; text: Counter.captionText() + ":" + Theme.count + ":" + root.serial + "/" + root.sharedSerial }
    Component.onCompleted: { root.serial = Counter.next(); root.sharedSerial = Shared.next(); }
}
