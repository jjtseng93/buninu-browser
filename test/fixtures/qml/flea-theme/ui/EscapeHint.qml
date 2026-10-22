import QtQuick

// The word that closes a surface, in the corner every surface puts it in: Dialogs rule 7, and the
// spelling ui/SettingsPanel.qml already uses, so no two dialogs can name the way out differently.
Text {
    text: "esc"
    color: Theme.color.muted
    font.family: Theme.font.family
    font.pixelSize: Theme.font.caption
    textFormat: Text.PlainText
}
