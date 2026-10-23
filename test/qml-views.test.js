import { test, expect } from 'bun:test';
import { RendererHost } from '../lib/renderer/host.js';
const wait = async (fn, predicate) => {
  let value;
  for (let i = 0; i < 80; i++) {
    value = await fn();
    if (predicate(value)) return value;
    await Bun.sleep(15);
  }
  throw Error('View did not settle: ' + JSON.stringify(value));
};
test('ListView virtualizes a large DelegateModel, scrolls, updates count and reuses delegates', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,view',
      contentType: 'text/x-qml',
      source: `
import QtQuick
import QtQml.Models
Item {
 id:root;width:300;height:200
 ListView {id:view;width:200;height:100;reuseItems:true
  model:DelegateModel {id:rows;model:100000000;filterOnGroup:"shown";groups:DelegateModelGroup {name:"shown";includeByDefault:false}
   Component.onCompleted:items.addGroups(0,2000,"shown")
  }
  delegate:Text {required property int index;text:"row "+index;height:20;width:200}
 }
 Text {id:count;y:120;text:view.count}
 Button {id:scroll;y:150;onClicked:view.positionViewAtIndex(1000,ListView.Beginning)}
 Button {id:shrink;x:100;y:150;onClicked:{rows.groups.removeGroups(5,1995,"shown");view.positionViewAtBeginning()}}
}`,
    });
    await host.call('whenLoaded');
    const read = async () =>
      JSON.parse(
        await host.call(
          'evaluate',
          'JSON.stringify({count:document.getElementById("count").textContent,text:document.body.innerText,n:document.querySelectorAll("[data-qml-type=Text]").length})',
        ),
      );
    await wait(read, (v) => v.count === '2000');
    let result = await read();
    expect(result.n).toBeLessThan(20);
    expect(result.text).toContain('row 0');
    await host.call('evaluate', 'document.getElementById("scroll").click()');
    result = await wait(read, (v) => v.text.includes('row 1000'));
    expect(result.n).toBeLessThan(25);
    await host.call('evaluate', 'document.getElementById("shrink").click()');
    result = await wait(
      read,
      (v) => v.count === '5' && v.text.includes('row 0'),
    );
    expect(result.n).toBeLessThan(25);
  } finally {
    host.close();
  }
}, 30000);

test('Flickable routes default children to contentItem and responds to wheel without moving explicit overlays', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,flick',
      contentType: 'text/x-qml',
      source: `
import QtQuick
Flickable {id:root;width:200;height:100;contentWidth:200;contentHeight:500;clip:true
 Rectangle {id:body;width:parent.width;height:500;color:"red"}
 Text {id:overlay;parent:root;text:"fixed"}
 Text {id:status;parent:root;y:20;text:root.contentY+":"+body.parent.height}
}`,
    });
    await host.call('whenLoaded');
    expect(
      await host.call(
        'evaluate',
        'document.getElementById("body").parentElement.hasAttribute("data-qml-content")',
      ),
    ).toBe(true);
    expect(
      await host.call(
        'evaluate',
        'document.getElementById("overlay").parentElement.id',
      ),
    ).toBe('root');
    await host.call(
      'evaluate',
      'document.getElementById("root").dispatchEvent(new WheelEvent("wheel",{deltaY:50,bubbles:true,cancelable:true}))',
    );
    await wait(
      () =>
        host.call('evaluate', 'document.getElementById("status").textContent'),
      (v) => v === '50:500',
    );
    expect(
      await host.call(
        'evaluate',
        'document.getElementById("body").parentElement.style.top',
      ),
    ).toBe('-50px');
  } finally {
    host.close();
  }
}, 30000);

test('empty Loaders, decoration Items and DropAreas do not swallow pointer activation', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,pointer',
      contentType: 'text/x-qml',
      source: `
import QtQuick
Item {width:200;height:100;property int clicks:0
 Rectangle {width:80;height:40;color:"red";TapHandler {onTapped:clicks++}}
 DropArea {anchors.fill:parent}
 Loader {anchors.fill:parent;active:false;z:3}
 Item {anchors.fill:parent;z:4}
 Text {id:status;y:50;text:clicks}
}`,
    });
    await host.call('whenLoaded');
    await host.call('click', 20, 20);
    await wait(
      () =>
        host.call('evaluate', 'document.getElementById("status").textContent'),
      (v) => v === '1',
    );
  } finally {
    host.close();
  }
}, 30000);

test('XmlListModel reads XBEL attributes through Qt role indices and reports unsupported queries', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,xml',
      contentType: 'text/x-qml',
      source: `
import QtQuick
import QtQml.XmlListModel
Item {
 XmlListModel {id:model;query:"/xbel/bookmark";xml:"<xbel><bookmark href='file:///tmp/a' visited='2026-10-22'/><bookmark href='file:///tmp/b'/></xbel>"
  XmlListModelRole {name:"href";attributeName:"href"}
  XmlListModelRole {name:"visited";attributeName:"visited"}
 }
 Text {id:status;text:model.status+":"+model.count+":"+model.data(model.index(1,0),Qt.UserRole)}
 Button {id:bad;onClicked:model.query="//bookmark[@bad]"}
}`,
    });
    await host.call('whenLoaded');
    await wait(
      () =>
        host.call('evaluate', 'document.getElementById("status").textContent'),
      (v) => v === '1:2:file:///tmp/b',
    );
    await host.call('evaluate', 'document.getElementById("bad").click()');
    await wait(
      () =>
        host.call('evaluate', 'document.getElementById("status").textContent'),
      (v) => v.startsWith('3:0:'),
    );
  } finally {
    host.close();
  }
}, 30000);

test('unchanged Flea StableModel resizes a virtualized view synchronously and warms reusable rows', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const dir = mkdtempSync('/tmp/qml-stable-model-');
  const ui = Bun.fileURLToPath(
    new URL('./fixtures/qml/flea-theme/ui/', import.meta.url),
  );
  await Bun.write(
    dir + '/main.qml',
    `import QtQuick
import ${JSON.stringify(ui)} as Flea
Item {width:300;height:200;property int total:100
 ListView {id:view;width:200;height:100;reuseItems:true
  model:Flea.StableModel {id:stable;view:view;total:parent.parent.total;warm:true;warmRows:20}
  delegate:Text {required property int index;width:200;height:20;text:"row "+index}
 }
 Text {id:status;y:120;text:view.count+":"+view.currentIndex}
 Button {id:grow;y:150;onClicked:{total=105;stable.resize()}}
 Button {id:scroll;x:80;y:150;onClicked:view.positionViewAtIndex(50,ListView.Beginning)}
}`,
  );
  const { createBrowser } = await import('../lib/headless-shell.js');
  const browser = await createBrowser({ spareRenderer: false });
  try {
    await browser.context.navigate(Bun.pathToFileURL(dir + '/main.qml').href);
    await wait(
      () =>
        browser.context.evaluate(
          'document.getElementById("status").textContent',
        ),
      (v) => v === '100:0',
    );
    await browser.context.evaluate('document.getElementById("scroll").click()');
    await wait(
      () => browser.context.evaluate('document.body.innerText'),
      (v) => v.includes('row 50'),
    );
    await browser.context.evaluate('document.getElementById("grow").click()');
    await wait(
      () =>
        browser.context.evaluate(
          'document.getElementById("status").textContent',
        ),
      (v) => v === '105:0',
    );
    expect(
      await browser.context.evaluate(
        'document.querySelectorAll("[data-qml-type=Text]").length',
      ),
    ).toBeLessThan(30);
  } finally {
    browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test('passive HoverHandler observes a decoration without intercepting the button beneath', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,hover',
      contentType: 'text/x-qml',
      source: `
import QtQuick
Item {width:200;height:120;property int clicks:0
 Rectangle {width:80;height:40;color:"red";TapHandler {onTapped:clicks++}}
 Item {width:80;height:40;z:5;HoverHandler {id:hover}}
 Text {id:status;y:60;text:hover.hovered+":"+clicks}
}`,
    });
    await host.call('whenLoaded');
    await host.call('move', 20, 20);
    await host.call('click', 20, 20);
    await wait(
      () =>
        host.call('evaluate', 'document.getElementById("status").textContent'),
      (v) => v === 'true:1',
    );
    await host.call('move', 110, 80);
    await wait(
      () =>
        host.call('evaluate', 'document.getElementById("status").textContent'),
      (v) => v === 'false:1',
    );
  } finally {
    host.close();
  }
}, 30000);

test('turning reuseItems off and back on in one handler immediately drains parked delegates', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,pool',
      contentType: 'text/x-qml',
      source: `import QtQuick
Item {width:300;height:200
 ListView {id:view;width:200;height:100;reuseItems:true;cacheBuffer:0;model:100
  delegate:Text {required property int index;width:200;height:20;text:"row "+index}
 }
 Button {id:park;y:120;onClicked:{view.displayMarginEnd=300;view.forceLayout();view.displayMarginEnd=0;view.forceLayout()}}
 Button {id:drain;x:80;y:120;onClicked:{view.reuseItems=false;view.reuseItems=true}}
}`,
    });
    await host.call('whenLoaded');
    const count = () =>
      host.call(
        'evaluate',
        'document.querySelectorAll("[data-qml-type=Text]").length',
      );
    await host.call('evaluate', 'document.getElementById("park").click()');
    const parked = await count();
    expect(parked).toBeGreaterThan(10);
    await host.call('evaluate', 'document.getElementById("drain").click()');
    expect(await count()).toBeLessThan(10);
  } finally {
    host.close();
  }
}, 30000);

test('replacing a numeric ListView model resets its scroll before creating new delegates',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start();await host.call('loadDocument',{url:'data:text/x-qml,reset',contentType:'text/x-qml',source:`import QtQuick
Item {width:300;height:200
 ListView {id:view;width:200;height:100;model:100;delegate:Text {required property int index;text:"row "+index;width:200;height:20}}
 Text {id:offset;y:110;text:String(view.contentY)+","+view.model+","+view.count}
 Button {id:scroll;y:140;onClicked:view.positionViewAtIndex(50,ListView.Beginning)}
 Button {id:replace;x:100;y:140;onClicked:view.model=80}
}`});await host.call('whenLoaded');
  await host.call('evaluate','document.getElementById("scroll").click()');
  await wait(()=>host.call('evaluate','document.getElementById("offset").textContent'),v=>Number(v.split(",")[0])>0);
  await host.call('evaluate','document.getElementById("replace").click()');
  await wait(()=>host.call('evaluate','document.getElementById("offset").textContent'),v=>Number(v.split(",")[0])===0);
  expect(await host.call('evaluate','document.body.innerText')).toContain('row 0');
 }finally{host.close();}
},30000);
