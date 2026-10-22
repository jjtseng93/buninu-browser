import QtQuick
import QtQuick.Controls
import Quickshell
import "./ui" as Flea
FloatingWindow {
  id: demo
  property bool alternate: false
  title: "Flea — real Theme and Omarchy Commons"
  width: 800; height: 760
  color: Flea.Theme.color.background
  Column {
    x: 24; y: 20; spacing: 12
    Text {text: "Real Flea Theme"; color: Flea.Theme.color.foreground; font.pixelSize: 24}
    Text {id: readiness; text: "Palette ready: " + Flea.Theme.ready; color: Flea.Theme.color.muted; font.pixelSize: 16}
    Flea.EscapeHint {}
    Button {
      text: "Toggle palette"
      onClicked: {
        demo.alternate = !demo.alternate
        Flea.Theme.applyColors(demo.alternate
          ? 'background = "#202030"\nforeground = "#ffeebb"\naccent = "#ffcc66"\nred = "#ff3333"'
          : 'background = "#101315"\nforeground = "#eeeeee"\naccent = "#70e1e8"\nred = "#ff3333"')
      }
    }
    Text {id: metrics; text: Flea.Theme.tokens(); color: Flea.Theme.color.foreground; font.pixelSize: 13; font.family: Flea.Theme.font.family}
  }
}
