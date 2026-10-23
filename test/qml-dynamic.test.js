import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createBrowser } from '../lib/headless-shell.js';
test('local Qt.createComponent creates DOM, shares singleton bindings and destroys instances', async () => {
  const dir = mkdtempSync('/tmp/qml-dynamic-');
  const write = (name, text) => Bun.write(dir + '/' + name, text);
  await write(
    'qmldir',
    'singleton Theme 1.0 Theme.qml\nsingleton Extra 1.0 Extra.qml\n',
  );
  await write(
    'Theme.qml',
    'pragma Singleton\nimport QtQuick\nQtObject {property int count: 1}',
  );
  await write(
    'Extra.qml',
    'pragma Singleton\nimport QtQuick\nQtObject {property int count: 10}',
  );
  await write(
    'Cell.qml',
    `import QtQuick
Rectangle {
 required property string label
 property int value: 0
 width: 200; height: 30
 Text {text: label+":"+Theme.count+":"+Extra.count+":"+value}
 Component.onCompleted: Extra.count++
}`,
  );
  await write(
    'main.qml',
    `import QtQuick
Rectangle {
 id:root;width:600;height:300
 property int source: 3
 property var cells: []
 property var factory: null
 Text {id:status;text:Theme.count}
 Button {id:add;text:"Add";onClicked:{
   if(!root.factory)root.factory=Qt.createComponent("Cell.qml")
   const cell=root.factory.createObject(root,{label:"cell",value:Qt.binding(function(){return root.source})})
   if(!cell)throw Error(root.factory.errorString())
   root.cells=root.cells.concat([cell])
 }}
 Button {id:change;onClicked:{Theme.count++;root.source=7}}
 Button {id:remove;onClicked:{root.cells[0].destroy();root.cells=root.cells.slice(1)}}
}`,
  );
  const b = await createBrowser({ spareRenderer: false });
  try {
    await b.context.navigate(Bun.pathToFileURL(dir + '/main.qml').href);
    const click = (id) =>
      b.context.evaluate(
        'document.getElementById(' + JSON.stringify(id) + ').click()',
      );
    const texts = async () =>
      JSON.parse(
        await b.context.evaluate(
          'JSON.stringify([...document.querySelectorAll("[data-qml-type=Text]")].map(e=>e.textContent))',
        ),
      );
    await click('add');
    expect(await texts()).toEqual(['1', 'cell:1:11:3']);
    await click('add');
    expect(await texts()).toEqual(['1', 'cell:1:12:3', 'cell:1:12:3']);
    await click('change');
    expect(await texts()).toEqual(['2', 'cell:2:12:7', 'cell:2:12:7']);
    await click('remove');
    expect(await texts()).toEqual(['2', 'cell:2:12:7']);
    await click('add');
    expect(await texts()).toEqual(['2', 'cell:2:13:7', 'cell:2:13:7']);
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test('Loader creates inline and file components on demand, updates bindings and destroys hidden content', async () => {
  const dir = mkdtempSync('/tmp/qml-loader-');
  await Bun.write(
    dir + '/Child.qml',
    'import QtQuick\nText {required property string label; text:label}',
  );
  await Bun.write(
    dir + '/main.qml',
    `import QtQuick
Item {
 id:root;width:500;height:300
 property bool shown: false
 property string label: "first"
 property int loaded: 0
 property int destroyed: 0
 Component {id:body
  Text {text:root.label;Component.onDestruction:root.destroyed++}
 }
 Loader {id:loader;active:root.shown;sourceComponent:body;onLoaded:root.loaded++}
 Loader {id:fileLoader}
 Text {id:status;text:root.loaded+":"+root.destroyed}
 Button {id:show;onClicked:root.shown=!root.shown}
 Button {id:change;onClicked:root.label="second"}
 Button {id:file;onClicked:fileLoader.setSource("Child.qml",{label:Qt.binding(function(){return root.label})})}
}`,
  );
  const b = await createBrowser({ spareRenderer: false });
  try {
    await b.context.navigate(Bun.pathToFileURL(dir + '/main.qml').href);
    const text = () => b.context.evaluate('document.body.innerText');
    const settle = async (predicate) => {
      for (let i = 0; i < 50; i++) {
        if (await predicate()) return;
        await Bun.sleep(10);
      }
      throw Error('Loader did not settle: ' + (await text()));
    };

    const click = (id) =>
      b.context.evaluate(
        'document.getElementById(' + JSON.stringify(id) + ').click()',
      );
    expect(await text()).not.toContain('first');
    await click('show');
    await settle(async () => (await text()).includes('first'));
    expect(await text()).toContain('first');
    expect(await text()).toContain('1:0');
    await click('file');
    expect((await text()).match(/first/g)?.length).toBe(2);
    await click('change');
    await settle(async () => (await text()).match(/second/g)?.length === 2);
    expect((await text()).match(/second/g)?.length).toBe(2);
    await click('show');
    await settle(async () => (await text()).includes('1:1'));
    expect(await text()).toContain('1:1');
    expect((await text()).match(/second/g)?.length).toBe(1);
    await click('show');
    await settle(async () => (await text()).includes('2:1'));
    expect(await text()).toContain('2:1');
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test('synchronous Loader item observes a just-written bound activation in the same handler', async () => {
  const dir = mkdtempSync('/tmp/qml-sync-loader-');
  await Bun.write(
    dir + '/main.qml',
    `import QtQuick
Item {id:root;property bool built:false;property int answer:0
 Component {id:body;Item {function result(){return 42}}}
 Loader {id:loader;active:root.built;sourceComponent:body}
 Text {id:status;text:root.answer}
 Button {id:go;onClicked:{root.built=true;root.answer=loader.item.result()}}
}`,
  );
  const b = await createBrowser({ spareRenderer: false });
  try {
    await b.context.navigate(Bun.pathToFileURL(dir + '/main.qml').href);
    await b.context.evaluate('document.getElementById("go").click()');
    expect(
      await b.context.evaluate('document.getElementById("status").textContent'),
    ).toBe('42');
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test('dynamic singleton references cannot be captured by application loop variables', async () => {
  const dir = mkdtempSync('/tmp/qml-hygiene-');
  await Bun.write(dir + '/qmldir', 'singleton Theme 1.0 Theme.qml\n');
  await Bun.write(
    dir + '/Theme.qml',
    'pragma Singleton\nimport QtQuick\nQtObject {property int amount:7}',
  );
  await Bun.write(
    dir + '/Child.qml',
    `import QtQuick
Text {text:{var total=0;for(var r=0;r<3;r++){var n0=r;var j0=r;total+=Theme.amount+n0-j0;}return total}}`,
  );
  await Bun.write(
    dir + '/main.qml',
    `import QtQuick
Item {property int shared:Theme.amount;Loader {source:"Child.qml"}}`,
  );
  const b = await createBrowser({ spareRenderer: false });
  try {
    await b.context.navigate(Bun.pathToFileURL(dir + '/main.qml').href);
    expect(await b.context.evaluate('document.body.innerText')).toBe('21');
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test('library scripts first imported by a delegate hoist their non-library dependencies into the library scope', async () => {
  const dir = mkdtempSync('/tmp/qml-library-scope-');
  await Bun.write(
    dir + '/Utility.js',
    'var count=0;function next(){return ++count;}',
  );
  await Bun.write(
    dir + '/Library.js',
    '.pragma library\n.import "Utility.js" as Utility\nfunction next(){return Utility.next();}',
  );
  await Bun.write(
    dir + '/Cell.qml',
    'import QtQuick\nimport "Library.js" as Library\nText {text:Library.next()}',
  );
  await Bun.write(
    dir + '/main.qml',
    'import QtQuick\nItem {Repeater {model:2;Cell {}}}',
  );
  const b = await createBrowser({ spareRenderer: false });
  try {
    await b.context.navigate(Bun.pathToFileURL(dir + '/main.qml').href);
    expect(await b.context.evaluate('document.body.innerText')).toBe('12');
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test('alias writes detach an outer binding and Qt.binding reattaches it without replacing the alias', async () => {
  const dir = mkdtempSync('/tmp/qml-alias-write-');
  await Bun.write(
    dir + '/Field.qml',
    'import QtQuick\nItem {property alias text:label.text;Text {id:label}}',
  );
  await Bun.write(
    dir + '/main.qml',
    `import QtQuick
Item {id:root;property string source:"one"
 Field {id:field;text:root.source}
 Button {id:override;onClicked:{field.text="manual";root.source="two"}}
 Button {id:rebind;onClicked:{field.text=Qt.binding(function(){return root.source});root.source="three"}}
}`,
  );
  const b = await createBrowser({ spareRenderer: false });
  try {
    await b.context.navigate(Bun.pathToFileURL(dir + '/main.qml').href);
    const text = () =>
      b.context.evaluate(
        'document.querySelector("[data-qml-type=Text]").textContent',
      );
    expect(await text()).toBe('one');
    await b.context.evaluate('document.getElementById("override").click()');
    expect(await text()).toBe('manual');
    await b.context.evaluate('document.getElementById("rebind").click()');
    expect(await text()).toBe('three');
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test('named data aliases place title and buttons inside their real holders', async () => {
  const dir = mkdtempSync('/tmp/qml-named-slots-');
  await Bun.write(
    dir + '/Card.qml',
    `import QtQuick
Item {property alias title:top.data;property alias buttons:bottom.data;default property alias content:middle.data
 Item {id:top;y:10}Item {id:middle;y:40}Item {id:bottom;y:80}}`,
  );
  await Bun.write(
    dir + '/main.qml',
    `import QtQuick
Card {title:Text {id:title;text:"Title"} buttons:Text {id:buttons;text:"Buttons"} Text {id:body;text:"Body"}}`,
  );
  const b = await createBrowser({ spareRenderer: false });
  try {
    await b.context.navigate(Bun.pathToFileURL(dir + '/main.qml').href);
    expect(
      await b.context.evaluate(
        'document.getElementById("title").parentElement.style.top',
      ),
    ).toBe('10px');
    expect(
      await b.context.evaluate(
        'document.getElementById("buttons").parentElement.style.top',
      ),
    ).toBe('80px');
    expect(
      await b.context.evaluate(
        'document.getElementById("body").parentElement.style.top',
      ),
    ).toBe('40px');
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test('destroying a loaded component notifies nested objects once and still releases sibling factories', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const dir = mkdtempSync('/tmp/qml-destruction-');
  let browser;
  try {
    await Bun.write(
      dir + '/main.qml',
      `import QtQuick
Item {id:root;width:300;height:200;property string gone:""
 Loader {id:loader;active:true;sourceComponent:Item {
  Component.onDestruction:root.gone+="root,"
  Item {Component.onDestruction:root.gone+="child,"}
  Repeater {model:2;delegate:Item {required property int index;Component.onDestruction:root.gone+="row"+index+","}}
 }}
 Text {id:status;text:root.gone}
 Button {id:destroy;y:80;onClicked:{loader.active=false;loader.active=false}}
}`,
    );
    const { createBrowser } = await import('../lib/headless-shell.js');
    browser = await createBrowser({ spareRenderer: false });
    await browser.context.navigate(Bun.pathToFileURL(dir + '/main.qml').href);
    await browser.context.evaluate(
      'document.getElementById("destroy").click()',
    );
    const gone = await browser.context.evaluate(
      'document.getElementById("status").textContent',
    );
    expect(gone.split(',').filter(Boolean).sort()).toEqual([
      'child',
      'root',
      'row0',
      'row1',
    ]);
  } finally {
    browser?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test('shared JS libraries can create and release components relative to the script URL', async () => {
  const dir = mkdtempSync('/tmp/qml-library-component-');
  let browser;
  try {
    await Bun.write(dir + '/helpers/Factory.js', `.pragma library
function make(parent, label) {
 const component=Qt.createComponent("Cell.qml");
 if(component.status!==1)throw Error(component.errorString());
 const object=component.createObject(parent,{text:label});
 component.destroy();
 return object;
}`);
    await Bun.write(dir + '/helpers/Cell.qml', 'import QtQuick\nText {width:100;height:20}');
    await Bun.write(dir + '/main.qml', `import QtQuick
import "helpers/Factory.js" as Factory
Item {id:root;property var first:null;property var second:null
 Component.onCompleted:{first=Factory.make(root,"first");second=Factory.make(root,"second");second.y=30}
 Button {id:remove;y:80;onClicked:root.first.destroy()}
}`);
    browser=await createBrowser({spareRenderer:false});
    await browser.context.navigate(Bun.pathToFileURL(dir+'/main.qml').href);
    expect(await browser.context.evaluate('document.body.innerText')).toContain('first');
    expect(await browser.context.evaluate('document.body.innerText')).toContain('second');
    await browser.context.evaluate('document.getElementById("remove").click()');
    expect(await browser.context.evaluate('document.body.innerText')).not.toContain('first');
    expect(await browser.context.evaluate('document.body.innerText')).toContain('second');
  } finally {browser?.close();rmSync(dir,{recursive:true,force:true});}
},30000);

test('children of an instantiated component resolve properties added at the use site; rejected MouseAreas pass clicks to underlying rows',async()=>{
 const dir=mkdtempSync('/tmp/qml-click-');let browser;
 try{
  await Bun.write(dir+'/Cell.qml','import QtQuick\nRectangle {width:200;height:40;color:"red"}');
  await Bun.write(dir+'/main.qml',`import QtQuick
Rectangle {width:300;height:150
 property bool block: false
 Cell {id:cell;property int rowIndex:7
  TapHandler {onTapped:status.text=String(rowIndex)}
 }
 MouseArea {anchors.fill:cell;z:1;onPressed:mouse=>{mouse.accepted=false}}
 MouseArea {anchors.fill:cell;z:2;onPressed:mouse=>{mouse.accepted=block}}
 Text {id:status;y:60;text:"none"}
 Button {id:gate;y:90;onClicked:block=true}
}`);
  browser=await createBrowser({spareRenderer:false});await browser.context.resize(300,150);await browser.context.navigate(Bun.pathToFileURL(dir+'/main.qml').href);
  await browser.context.click(20,20);await browser.context.evaluate('0');
  expect(await browser.context.evaluate('document.getElementById("status").textContent')).toBe('7');
  await browser.context.evaluate('document.getElementById("gate").click();document.getElementById("status").textContent="blocked"');await browser.context.evaluate('0');
  await browser.context.click(20,20);
  expect(await browser.context.evaluate('document.getElementById("status").textContent')).toBe('blocked');
 }finally{browser?.close();rmSync(dir,{recursive:true,force:true});}
},30000);

test('dynamic objects belong to their explicit parent, not the Loader currently creating them',async()=>{
 const dir=mkdtempSync('/tmp/qml-parent-owner-');let browser;
 try{
  await Bun.write(dir+'/Icon.qml','import QtQuick\nText {text:"surviving icon"}');
  await Bun.write(dir+'/main.qml',`import QtQuick
Item {id:root;width:300;height:150
 Item {id:keeper}
 Loader {id:maker;sourceComponent:Text {text:"temporary maker";Component.onCompleted:{var c=Qt.createComponent("Icon.qml");c.createObject(keeper);c.destroy()}}}
 Button {id:remove;y:50;onClicked:maker.active=false}
}`);
  browser=await createBrowser({spareRenderer:false});await browser.context.navigate(Bun.pathToFileURL(dir+'/main.qml').href);
  expect(await browser.context.evaluate('document.body.innerText')).toContain('surviving icon');
  await browser.context.evaluate('document.getElementById("remove").click()');await browser.context.evaluate('0');
  const text=await browser.context.evaluate('document.body.innerText');
  expect(text).toContain('surviving icon');expect(text).not.toContain('temporary maker');
 }finally{browser?.close();rmSync(dir,{recursive:true,force:true});}
},30000);
