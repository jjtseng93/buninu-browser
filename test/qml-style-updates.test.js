import { test, expect } from 'bun:test';
import { RendererHost } from '../lib/renderer/host.js';

test('QML style updates preserve final overrides and clear conditional styles', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,styles',
      contentType: 'text/x-qml',
      source: `import QtQuick
Rectangle {
 id: root; width: 320; height: 160; property bool changed: false
 onClicked: { changed = !changed; }
 Rectangle { id: box; width: root.changed ? 120 : 80; height: 30; x: 10
  opacity: root.changed ? 0.5 : 1; color: root.changed ? "blue" : "red"
  gradient: root.changed ? null : ramp
  Gradient { id: ramp; GradientStop { position: 0; color: "red" } GradientStop { position: 1; color: "blue" } }
 }
 Text { id: label; y:40; width:80; height:30; text:"long long text"
  elide: root.changed ? Text.ElideNone : Text.ElideRight
  verticalAlignment: Text.AlignVCenter
 }
}`,
    });
    await host.call('whenLoaded');
    const styles = () =>
      host.call(
        'evaluate',
        `JSON.stringify({
      width:box.style.width,opacity:box.style.opacity,
      gradient:box.style.backgroundImage,overflow:label.style.overflow,
      whiteSpace:label.style.whiteSpace,lineHeight:label.style.lineHeight,
      elide:label.style.textOverflow
    })`
          .replaceAll('box.style', 'document.getElementById("box").style')
          .replaceAll('label.style', 'document.getElementById("label").style'),
      );
    const before = JSON.parse(await styles());
    expect(before.width).toBe('80px');
    expect(before.gradient).toContain('linear-gradient');
    expect(before.elide).toBe('ellipsis');
    expect(before.whiteSpace).toBe('nowrap');
    expect(before.lineHeight).toBe('30px');
    await host.call(
      'evaluate',
      'document.getElementById("box").style.zIndex="99";document.getElementById("root").click()',
    );
    expect(
      await host.call(
        'evaluate',
        'document.getElementById("box").style.zIndex',
      ),
    ).toBe('0');
    const after = JSON.parse(await styles());
    expect(after.width).toBe('120px');
    expect(after.opacity).toBe('0.5');
    expect(after.gradient).toBe('none');
    expect(after.elide).toBe('clip');
    expect(after.whiteSpace).toBe('pre');
    expect(after.overflow).toBe('visible');
    expect(after.lineHeight).toBe('30px');
    await host.call('evaluate', 'document.getElementById("root").click()');
    expect(JSON.parse(await styles())).toEqual(before);
  } finally {
    host.close();
  }
}, 30000);
