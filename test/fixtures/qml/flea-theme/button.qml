import QtQuick
import Quickshell
import "./ui" as Flea
FloatingWindow {
 id: demo
 width: 600; height: 320
 color: Flea.Theme.color.background
 title: "Flea buttons | "+presses
 Component.onCompleted: action.forceActiveFocus()
 property int presses: 0
 Column {
  x:24;y:24;spacing:24
  Flea.DialogButton {id:action;label:"Activate";primary:true;tabStop:true;onActivated:demo.presses++}
  Flea.DialogButton {label:"Disabled";available:false}
  Text {id:status;text:"Activated: "+demo.presses;color:Flea.Theme.color.foreground}
 }
}
