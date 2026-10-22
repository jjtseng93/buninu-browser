import QtQuick
import QtQuick.Controls
import Quickshell

FloatingWindow {
    id: root
    title: "Multiply — Quickshell"
    implicitWidth: 580
    implicitHeight: 440
    color: "#172b36"

    Column {
        anchors.centerIn: parent
        width: Math.min(420, parent.width - 48)
        spacing: 12

        Text {
            text: "Multiply two numbers"
            color: "#70e1e8"
            font.pixelSize: 26
        }
        Label { text: "First number"; color: "#e0edf0" }
        TextField {
            id: first
            width: parent.width
            text: "6"
            placeholderText: "Enter a number"
            selectByMouse: true
            Accessible.name: "First number"
        }
        Label { text: "Second number"; color: "#e0edf0" }
        TextField {
            id: second
            width: parent.width
            text: "7"
            placeholderText: "Enter a number"
            selectByMouse: true
            Accessible.name: "Second number"
        }
        Button {
            width: parent.width
            text: "Multiply"
            onClicked: {
                const a = Number(first.text.trim());
                const b = Number(second.text.trim());
                result.text = first.text.trim() !== "" && second.text.trim() !== ""
                    && Number.isFinite(a) && Number.isFinite(b)
                    ? String(a * b) : "Please enter two valid numbers";
            }
        }
        Label { text: "Result"; color: "#e0edf0" }
        TextField {
            id: result
            width: parent.width
            readOnly: true
            selectByMouse: true
            placeholderText: "Press Multiply"
            Accessible.name: "Result"
        }
    }
}
