import QtQuick
import Quickshell
import "./components" as UI
import "./theme" as Skin
import "./logic/math.js" as Calc
import Demo.Toolkit 1.0 as Tools
FloatingWindow {
    title: "Real QML imports"
    color: "#172b36"
    UI.Badge { id: first; x: 30; y: 30; caption: "one" }
    UI.Badge { id: second; x: 30; y: 110; caption: "two" }
    Text { id: summary; x: 30; y: 200; color: Skin.Theme.ink; text: "Shared: " + Skin.Theme.count + " / multiply: " + Calc.multiply(6, 7) }
    Text { id: privateScope; x: 30; y: 225; color: "white"; text: "Private ID: " + typeof label }
    Tools.VersionLabel { id: versionLabel; x: 30; y: 250 }
    Rectangle {
        id: button
        x: 30; y: 300; width: 240; height: 50; color: "#315d6c"
        Text { anchors.centerIn: parent; color: "white"; text: "Increment shared singleton" }
        MouseArea { anchors.fill: parent; onClicked: { Skin.Theme.bump(); first.value = "changed"; } }
    }
}
