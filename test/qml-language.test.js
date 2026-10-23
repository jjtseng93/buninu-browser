import { test, expect } from 'bun:test';
import { parseQml } from '../lib/qml/parser.js';
import { RendererHost } from '../lib/renderer/host.js';

test('QML syntax includes typed functions, optional signal parentheses, default slots and inline component declarations', () => {
  const root = parseQml(`Item {
  default property alias content: body.data
  property point point
  property var unset
  signal ready
  function twice(n: int): int {return n*2}
  component Cell: Rectangle {color:"red"}
  Item {id:body}
  Behavior on opacity {NumberAnimation {property:"opacity";duration:50}}
 }`).root;
  expect(root.properties.find((p) => p.key === 'content').defaultProperty).toBe(
    true,
  );
  expect(root.properties.find((p) => p.key === 'point').code).toBe(
    '({x:0,y:0})',
  );
  expect(root.properties.find((p) => p.key === 'unset').code).toBe('undefined');
  expect(
    root.properties.find((p) => p.key === 'twice').code.replace(/\s+/g, ''),
  ).toContain('twice(n)');
  expect(root.components[0].name).toBe('Cell');
  expect(root.children[1].bindingTarget).toBe('opacity');
});

test('statement handlers, object literals, property types and QML casts execute as page JavaScript', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,test',
      contentType: 'text/x-qml',
      source: `
Rectangle {
 id: root; width: 300; height: 200
 property int counter: 0
 property point pos
 property var unset
 property QtObject plain: QtObject {}
 property var settings: {"tnum": 1}
 signal ready
 function twice(n: int): int {return n*2}
 onReady: if (settings.tnum) counter=twice(3); else counter=-1
 Component.onCompleted: root.ready()
 Text {id:result;text:counter+":"+pos.x+":"+typeof unset+":"+((root as Item)===root)+":"+((plain as Item)===null)+":"+(("tnum" in settings))}
}`,
    });
    await host.call('whenLoaded');
    expect(
      await host.call(
        'evaluate',
        'document.getElementById("result").textContent',
      ),
    ).toBe('6:0:undefined:true:true:true');
  } finally {
    host.close();
  }
}, 30000);

test('anchors expose geometry and Row positions only visible children without painting Item colors', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,geometry',
      contentType: 'text/x-qml',
      source: `
Rectangle {
 width:300;height:200
 Rectangle {id:box;anchors.left:parent.left;anchors.right:parent.right;anchors.margins:10;height:40;y:10}
 Row {id:row;x:20;y:70;spacing:5
  Item {id:first;width:30;height:20;property color tint:"red";property color color:tint}
  Item {id:invisible;width:100;height:50;visible:false}
  Rectangle {id:last;width:40;height:30}
 }
 Text {id:out;text:box.width+":"+row.implicitWidth+":"+row.implicitHeight+":"+last.x}
 Rectangle {id:centered;width:20;height:20;anchors.horizontalCenter:box.horizontalCenter;anchors.top:box.bottom;anchors.topMargin:5}
}`,
    });
    await host.call('whenLoaded');
    expect(
      await host.call('evaluate', 'document.getElementById("out").textContent'),
    ).toBe('280:75:30:35');
    expect(
      await host.call(
        'evaluate',
        'document.getElementById("first").style.backgroundColor',
      ),
    ).toBe('transparent');
    expect(
      JSON.parse(
        await host.call(
          'evaluate',
          'JSON.stringify([document.getElementById("centered").style.left,document.getElementById("centered").style.top])',
        ),
      ),
    ).toEqual(['140px', '55px']);
  } finally {
    host.close();
  }
}, 30000);

test('QML String.arg replaces the lowest numbered placeholders and does not leak into HTML', async () => {
  const { createBrowser } = await import('../lib/headless-shell.js');
  const browser = await createBrowser({ spareRenderer: false });
  try {
    await browser.context.navigate(
      'data:text/x-qml,' +
        encodeURIComponent(
          'import QtQuick\nText {id:message;text:"%2 / %1 / %1".arg("$&").arg(42)}',
        ),
    );
    let text = '';
    for (let i = 0; i < 100; i++) {
      text = await browser.context.evaluate(
        'document.getElementById("message")?.textContent',
      );
      if (text === '42 / $& / $&') break;
      await Bun.sleep(20);
    }
    expect(text).toBe('42 / $& / $&');
    await browser.context.navigate('data:text/html,<p>ordinary</p>');
    expect(await browser.context.evaluate('typeof "ordinary".arg')).toBe(
      'undefined',
    );
  } finally {
    browser.close();
  }
}, 30000);

test('loop, catch and destructured JS locals shadow QML names without capturing default expressions', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,scope',
      contentType: 'text/x-qml',
      source: `import QtQuick
Item {id:root;width:300;height:200
 property int i:99
 property int error:88
 property int value:7
 function run({n=value}={}) {
  var sum=n
  for(var i=0;i<3;i++)sum+=i
  try {throw 4} catch(error){sum+=error}
  for(let value of [1,2])sum+=value
  return sum+":"+i+":"+root.i+":"+root.error+":"+root.value
 }
 Text {id:status;text:root.run()}
}`,
    });
    await host.call('whenLoaded');
    expect(
      await host.call(
        'evaluate',
        'document.getElementById("status").textContent',
      ),
    ).toBe('17:3:99:88:7');
  } finally {
    host.close();
  }
}, 30000);
