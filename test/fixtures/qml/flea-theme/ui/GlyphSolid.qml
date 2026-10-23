import QtQuick
import QtQuick.Shapes

// The solid part of a mark, drawn over its stroke in the same ink; ui/Glyph.qml builds it only for a mark that names one.
Shape {
    id: root

    required property Glyph glyph

    width: root.glyph.grid
    height: root.glyph.grid
    x: (root.glyph.width - root.glyph.markSize) / 2
    y: (root.glyph.height - root.glyph.markSize) / 2
    preferredRendererType: Shape.CurveRenderer
    transform: Scale { xScale: root.glyph.gridScale; yScale: root.glyph.gridScale }

    ShapePath {
        strokeColor: "transparent"
        fillColor: root.glyph.color
        PathSvg { path: root.glyph.filledPath }
    }
}
