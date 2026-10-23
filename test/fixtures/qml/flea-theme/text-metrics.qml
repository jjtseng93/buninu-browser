import QtQuick
import Quickshell
FloatingWindow {
 width: 400; height: 240
 title: "Text metrics | " + empty.implicitWidth + ":" + empty.implicitHeight + ":" + empty.lineCount + ":" + single.lineCount + ":" + multi.lineCount + ":" + clipped.lineCount + ":" + clipped.truncated
 Text {id:empty;text:""}
 Text {id:single;y:40;text:"one"}
 Text {id:multi;y:80;text:"one\ntwo"}
 Text {id:clipped;y:140;text:"one\ntwo\nthree";maximumLineCount:2;elide:Text.ElideRight}
}
