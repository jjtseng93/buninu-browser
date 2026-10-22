import QtQuick
import QtQuick.Controls
import Quickshell
import "./ui" as Flea
import "./ui/js/TextSize.js" as TextSize
FloatingWindow {
  id: demo
  width: 800; height: 420
  title: "Flea — text size settings | " + Flea.Theme.baseSize + " | " + demo.clicks
  color: Flea.Theme.color.background
  property bool editing: true
  property int clicks: 0
  Text {
    x: 24; y: 24
    text: "Flea text size"
    font.pixelSize: 24
    color: Flea.Theme.color.foreground
  }
  Flea.SettingsRuler {
    id: ruler
    x: 24; y: 85; width: 740
    stops: TextSize.STOPS
    index: TextSize.STOPS.indexOf(Flea.Theme.baseSize)
    active: demo.editing
    onPicked: function (size) {
      demo.clicks++
      // Change the real shared ViewState in memory; this demo never writes settings.
      Flea.ViewState.state = {display: {textSize: {mode: size}}}
    }
  }
  Text {
    id: sample
    x: 24; y: 165
    text: "The quick brown fox — shared Theme"
    color: Flea.Theme.color.foreground
    font.family: Flea.Theme.font.family
    font.pixelSize: Flea.Theme.font.body
  }
  Text {
    id: status
    x: 24; y: 220
    text: "Size: " + Flea.Theme.baseSize + " / clicks: " + demo.clicks
    color: Flea.Theme.color.muted
    font.pixelSize: 16
  }
  Button {
    id: toggle
    x: 24; y: 280; width: 220; height: 44
    text: demo.editing ? "Disable ruler" : "Enable ruler"
    onClicked: demo.editing = !demo.editing
  }
  Button {
    id: reset
    x: 270; y: 280; width: 230; height: 44
    text: "Follow Omarchy"
    onClicked: Flea.ViewState.state = {display: {textSize: {mode: "system"}}}
  }
}
