import QtQuick
import "js/Motion.js" as Motion

// The one fade every dialog and menu shares: OutCubic, Motion.durMs.open in and .close out, snapped under reduced motion.
QtObject {
    id: root

    // The item that fades; it declares a plain `opacity: 0` and never binds it.
    property Item target: null
    property bool shown: false
    // A dialog's card: it rises Motion.translateUpPx into place on a fresh open only, and never moves while it fades out.
    property Item lift: null

    // Drives target.opacity from where it stands, so a reopen during a close fades up from there and never replays the old frame.
    function drive() {
        if (root.target === null) return
        fade.stop()
        risen.stop()
        if (Theme.reducedMotion) {
            root.target.opacity = root.shown ? 1 : 0
            rise.y = 0
            return
        }
        if (root.shown && root.lift !== null) {
            if (root.target.opacity === 0) rise.y = Motion.translateUpPx
            if (rise.y !== 0) risen.start()
        }
        fade.to = root.shown ? 1 : 0
        fade.duration = root.shown ? Motion.durMs.open : Motion.durMs.close
        fade.start()
    }

    onShownChanged: root.drive()
    Component.onCompleted: {
        if (root.lift !== null) root.lift.transform = rise
        if (root.shown) root.drive()
    }

    property Translate rise: Translate {}
    property NumberAnimation fade: NumberAnimation {
        target: root.target
        property: "opacity"
        easing.type: Easing.OutCubic
        // A close cut inside the rise leaves the card where it stood until it is gone, then rests it.
        onFinished: if (!root.shown) root.rise.y = 0
    }
    property NumberAnimation risen: NumberAnimation {
        target: root.rise
        property: "y"
        to: 0
        duration: Motion.durMs.open
        easing.type: Easing.OutCubic
    }
}
