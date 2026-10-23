import { test, expect } from 'bun:test';
import { RendererHost } from '../lib/renderer/host.js';
async function fixture(source, run) {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,layout',
      contentType: 'text/x-qml',
      source,
    });
    await host.call('whenLoaded');
    await run(host);
  } finally {
    host.close();
  }
}
test('Flow wraps dialog buttons and baseline anchors align different font sizes', async () => {
  await fixture(
    `import QtQuick
Item {width:400;height:300
 Flow {id:flow;width:150;spacing:10
  Rectangle {id:a;width:100;height:20}
  Rectangle {id:b;width:80;height:30}
  Rectangle {id:c;width:50;height:10}
 }
 Text {id:large;y:100;text:"Large";font.pixelSize:30}
 Text {id:small;x:120;anchors.baseline:large.baseline;text:"Small";font.pixelSize:12}
 Text {id:status;y:200;text:b.x+":"+b.y+":"+c.x+":"+c.y+":"+flow.height+":"+Math.round(small.y+small.baselineOffset-large.y-large.baselineOffset)}
}`,
    async (h) => {
      expect(
        await h.call(
          'evaluate',
          'document.getElementById("status").textContent',
        ),
      ).toBe('0:30:90:30:60:0');
    },
  );
}, 30000);
test('RowLayout shrinks and fills bounded children without losing alignment', async () => {
  await fixture(
    `import QtQuick
import QtQuick.Layouts
Item {width:400;height:200
 RowLayout {width:200;height:40;spacing:10
  Rectangle {id:a;implicitWidth:40;implicitHeight:20;Layout.alignment:Qt.AlignVCenter}
  Rectangle {id:b;implicitWidth:50;implicitHeight:10;Layout.fillWidth:true;Layout.maximumWidth:60;Layout.alignment:Qt.AlignBottom}
  Rectangle {id:c;implicitWidth:10;implicitHeight:10;Layout.fillWidth:true;Layout.fillHeight:true}
 }
 Text {id:status;y:100;text:a.width+":"+a.y+":"+b.width+":"+b.y+":"+c.width+":"+c.height}
}`,
    async (h) => {
      expect(
        await h.call(
          'evaluate',
          'document.getElementById("status").textContent',
        ),
      ).toBe('40:10:60:30:80:40');
    },
  );
}, 30000);
test('StyledText creates inert styled DOM, emits link activation and PlainText stays literal', async () => {
  await fixture(
    `import QtQuick
Item {id:root;width:400;height:200;property string link:""
 Text {id:rich;width:300;height:40;textFormat:Text.StyledText;text:"<b>Bold</b> <a href='https://example.com'>link</a><script>globalThis.bad=true</script>";onLinkActivated:function(link){root.link=link}}
 Text {id:plain;y:50;text:"<b>literal</b>";textFormat:Text.PlainText}
 Text {id:status;y:100;text:root.link}
}`,
    async (h) => {
      expect(
        await h.call(
          'evaluate',
          'document.getElementById("rich").querySelector("b").textContent',
        ),
      ).toBe('Bold');
      expect(
        await h.call(
          'evaluate',
          'document.getElementById("rich").querySelector("script")===null&&globalThis.bad===undefined',
        ),
      ).toBe(true);
      expect(
        await h.call(
          'evaluate',
          'document.getElementById("plain").textContent',
        ),
      ).toBe('<b>literal</b>');
      await h.call('evaluate', 'document.querySelector("a").click()');
      expect(
        await h.call(
          'evaluate',
          'document.getElementById("status").textContent',
        ),
      ).toBe('https://example.com');
    },
  );
}, 30000);

test('ShapePath linear gradients draw through the existing page canvas while solid paths retain SVG', async () => {
  await fixture(
    `import QtQuick
import QtQuick.Shapes
Item {width:200;height:100
 Shape {width:100;height:40
  ShapePath {strokeWidth:0;fillGradient:LinearGradient {x1:0;y1:0;x2:100;y2:0
   GradientStop {position:0;color:"red"} GradientStop {position:1;color:"blue"}}
   PathSvg {path:"M0 0 H100 V40 H0 Z"}
  }
 }
 Shape {x:110;width:40;height:40;ShapePath {fillColor:"green";strokeWidth:0;PathSvg {path:"M0 0H40V40H0Z"}}}
}`,
    async (h) => {
      const pixels = JSON.parse(
        await h.call(
          'evaluate',
          `(()=>{const c=document.querySelector('canvas[data-qml-gradient]').getContext('2d');return JSON.stringify([Array.from(c.getImageData(5,20,1,1).data),Array.from(c.getImageData(95,20,1,1).data)]);})()`,
        ),
      );
      expect(pixels[0][0]).toBeGreaterThan(220);
      expect(pixels[0][2]).toBeLessThan(35);
      expect(pixels[1][2]).toBeGreaterThan(220);
      expect(
        await h.call(
          'evaluate',
          'document.querySelectorAll("svg path").length',
        ),
      ).toBe(2);
    },
  );
}, 30000);

test('Text reports laid-out lineCount and keeps wrapped or explicit multiline captions when eliding', async () => {
  await fixture(
    `import QtQuick
Item {width:400;height:240
 Text {id:empty;text:""}
 Text {id:single;y:40;text:"one"}
 Text {id:multi;y:80;text:"one\\ntwo"}
 Text {id:clipped;y:140;text:"one\\ntwo\\nthree";maximumLineCount:2;elide:Text.ElideRight}
 Text {id:wrapped;x:100;width:70;text:"one two three four five";wrapMode:Text.WordWrap;elide:Text.ElideRight}
 Text {id:status;y:210;text:empty.implicitWidth+":"+empty.lineCount+":"+single.lineCount+":"+multi.lineCount+":"+clipped.lineCount+":"+clipped.truncated+":"+wrapped.truncated}
}`,
    async (h) => {
      expect(
        await h.call(
          'evaluate',
          'document.getElementById("status").textContent',
        ),
      ).toBe('0:1:1:2:2:true:false');
      expect(
        await h.call(
          'evaluate',
          'document.getElementById("clipped").style.whiteSpace',
        ),
      ).toBe('pre');
      expect(
        await h.call(
          'evaluate',
          'document.getElementById("wrapped").style.whiteSpace',
        ),
      ).toBe('pre-wrap');
    },
  );
}, 30000);

test('Text defaults to AutoText, recognizes multi-letter tags and preserves plain trailing newlines', async () => {
  await fixture(
    `import QtQuick
Item {width:300;height:200
 Text {id:auto;text:"<strong>Bold</strong><br/>next"}
 Text {id:plain;y:60;text:"line\\n"}
 Text {id:status;y:120;text:plain.lineCount}
}`,
    async (h) => {
      expect(
        await h.call(
          'evaluate',
          'document.getElementById("auto").querySelector("strong").textContent',
        ),
      ).toBe('Bold');
      expect(
        await h.call('evaluate', 'document.getElementById("auto").textContent'),
      ).toBe('Boldnext');
      expect(
        await h.call(
          'evaluate',
          'document.getElementById("status").textContent',
        ),
      ).toBe('2');
    },
  );
}, 30000);
