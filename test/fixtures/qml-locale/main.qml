import QtQuick
import Quickshell
ShellRoot {
 Component.onCompleted: {
  var l=Qt.locale();
  globalThis.localeResult={name:l.name,measurement:l.measurementSystem,date:l.dateFormat(Locale.ShortFormat),time:l.timeFormat(Locale.ShortFormat)};
 }
}
