// Test-only context, deliberately not a production Theme/Omarchy implementation.
export const themeScript = `globalThis.Theme = {
  color: {muted: '#70e1e8'},
  font: {family: 'sans-serif', caption: 24}
};`;

export function wrapEscapeHint(source) {
  // Inline the unchanged upstream object body into a test host. Component imports
  // are not implemented; this helper only accepts the one supported QtQuick import.
  if (!source.startsWith('import QtQuick\n')) throw new Error('Unexpected fixture import');
  return `import QtQuick
import QtQuick.Controls
import Quickshell
FloatingWindow {
  title: "Browser — Flea EscapeHint test"
  color: "#172b36"
  Column {
    width: parent.width - 64
    anchors.centerIn: parent
    spacing: 24
    Text { text: "Flea EscapeHint.qml (upstream)"; color: "#e0edf0"; font.pixelSize: 24 }
    Text { text: "Theme is supplied by the test harness"; color: "#a9bcc6"; font.pixelSize: 16 }
    Item {
      width: parent.width
      height: 50
      ${source.slice('import QtQuick\n'.length)}
    }
  }
}`;
}
