import QtQuick
import Quickshell
FloatingWindow {
 width: 600; height: 200; color: "#18202a"
 Text { x: 20; y: 20; text: "Text: 󰐊 󰏤 󰍉 󰌾 󰌌"; font.family: "monospace"; font.pixelSize: 32; color: "white" }
 Canvas {
  x:20; y:90; width:560; height:80
  onPaint: { let c=getContext("2d"); c.font="32px monospace"; c.fillStyle="white"; c.fillText("Canvas: 󰐊 󰏤 󰍉 󰌾 󰌌",0,40); }
 }
}
