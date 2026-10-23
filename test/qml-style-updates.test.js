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

// Qt retains the long Wrap enum spelling used by styled code viewers.
test('StyledText can toggle WrapAtWordBoundaryOrAnywhere and grow its line count', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,wrap-alias', contentType: 'text/x-qml',
      source: `import QtQuick
Rectangle {
 id: root; width: 320; height: 200; property bool wrapped: false
 onClicked: wrapped = !wrapped
 Text { id: code; width: 90; textFormat: Text.StyledText
  text: "<font color='red'>const</font> averylongidentifierwithoutspaces = 123456789;"
  wrapMode: root.wrapped ? Text.WrapAtWordBoundaryOrAnywhere : Text.NoWrap
 }
 Text { id: count; y: 180; text: code.lineCount }
}`,
    });
    await host.call('whenLoaded');
    const read = () => host.call('evaluate', `({
      lines: Number(document.getElementById('count').textContent),
      whiteSpace: document.getElementById('code').style.whiteSpace,
      overflowWrap: document.getElementById('code').style.overflowWrap
    })`);
    expect((await read()).lines).toBe(1);
    await host.call('evaluate', "document.getElementById('root').click()");
    const wrapped = await read();
    expect(wrapped.lines).toBeGreaterThan(1);
    expect(wrapped.whiteSpace).toBe('pre-wrap');
    expect(wrapped.overflowWrap).toBe('anywhere');
    await host.call('evaluate', "document.getElementById('root').click()");
    expect((await read()).lines).toBe(1);
  } finally { host.close(); }
}, 30000);

test('Qt.binding attaches to a default property and a plain write detaches it', async () => {
 const host = new RendererHost({timeout:20000});
 try {
  await host.start();
  await host.call('loadDocument',{url:'data:text/x-qml,default-binding',contentType:'text/x-qml',source:`import QtQuick
Item {id:root;width:100;height:100;property bool shown:true
 Rectangle {id:box;width:40;height:40}
 Component.onCompleted:box.visible=Qt.binding(function(){return root.shown})
 Button {id:toggle;onClicked:root.shown=!root.shown}
 Button {id:detach;onClicked:box.visible=true}
}`});
  await host.call('whenLoaded');
  const display=()=>host.call('evaluate','document.getElementById("box").style.display');
  const click=id=>host.call('evaluate',`document.getElementById('${id}').click()`);
  expect(await display()).toBe('block');
  await click('toggle');expect(await display()).toBe('none');
  await click('toggle');expect(await display()).toBe('block');
  await click('detach');await click('toggle');expect(await display()).toBe('block');
 }finally{host.close();}
},30000);
