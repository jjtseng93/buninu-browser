import QtQuick
import Quickshell
import "./ui" as Flea
FloatingWindow {
 id:demo;width:600;height:320
 property string source:"first"
 property int edits:0
 property int accepts:0
 property int tabs:0
 color:Flea.Theme.color.background
 title:"Flea field | "+field.text+" | "+edits+":"+accepts+":"+tabs
 Flea.DialogField {
  id:field;x:24;y:24;width:300;label:"Name";text:demo.source
  onEdited:demo.edits++
  onAccepted:demo.accepts++
  onTabbed:function(from,back){demo.tabs+=back?-1:1}
 }
 Text {id:status;y:150;text:field.text+"|"+demo.edits+":"+demo.accepts+":"+demo.tabs;color:Flea.Theme.color.foreground}
 Flea.DialogButton {id:change;x:24;y:200;label:"Change";onActivated:demo.source="second"}
 Component.onCompleted:field.takeFocus()
}
