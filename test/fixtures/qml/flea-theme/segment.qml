import QtQuick
import Quickshell
import "./ui" as Flea
FloatingWindow {
 id: demo
 width: 800; height: 420
 title: "Flea — settings segments"
 color: Flea.Theme.color.background
 property string choice: "List"
 Column {
  x: 24; y: 24; spacing: 24
  Text {text:"Real Flea segmented choices";font.pixelSize:24;color:Flea.Theme.color.foreground}
  Flea.SettingsSegment {options:["List","Grid","Columns"];value:demo.choice;onPicked:function(i){demo.choice=options[i]}}
  Flea.SettingsSegment {options:["List","Grid","Columns"];glyphs:["list","grid","columns"];value:demo.choice;onPicked:function(i){demo.choice=options[i]}}
  Text {id: status;text:"Selected: "+demo.choice;font.pixelSize:18;color:Flea.Theme.color.foreground}
 }
}
