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

test('initial delegate styles retain individual CSS value parsing for quoted and malformed strings',async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();
  await host.call('loadDocument',{url:'data:text/x-qml,initial-style-values',contentType:'text/x-qml',source:`import QtQuick
Item {width:400;height:200
 Text {id:quoted;text:"quoted";font.family:"'A; B', serif";color:"rgb(10, 20, 30)";x:4;width:90}
 Text {id:malformed;text:"malformed";font.family:"bad; position:fixed";color:"rgb(1,2,3";x:5;width:90}
 Text {id:safe;text:"safe";font.family:"serif";color:"rgb(10, 20, 30)";x:6;width:90}
}`});
  await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{
   const values=[['quoted',"'A; B', serif",'rgb(10, 20, 30)',4],['malformed','bad; position:fixed','rgb(1,2,3',5],['safe','serif','rgb(10, 20, 30)',6]];
   return values.map(([id,family,color,x])=>{
    const s=document.getElementById(id).style,expected=document.createElement('span').style;
    expected.fontFamily=family;expected.color=color;
    return s.position==='absolute'&&s.left===x+'px'&&s.width==='90px'&&s.fontFamily===expected.fontFamily&&s.color===expected.color;
   });
  })()`)).toEqual([true,true,true]);
 }finally{host.close();}
},30000);
