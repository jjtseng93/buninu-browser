import QtQuick
Rectangle {
    width: 640; height: 420; color: "#161b22"
    Text { x:20; y:12; text:"Software ShaderEffect / click the gradient"; color:"white"; font.pixelSize:20 }
    ShaderEffect {
        id: shader
        x:20; y:52; width:600; height:320
        property real phase:0.2
        fragmentShader:"gradient.frag"
        MouseArea { anchors.fill:parent; onClicked:shader.phase=shader.phase < 0.5 ? 0.9 : 0.2 }
        Component.onCompleted:globalThis.testShader=shader
    }
    Text { x:20; y:385; text:shader.status===1 ? "CPU raster / blue = "+shader.phase : shader.log; color:"#58d5dd";font.pixelSize:16 }
}
