import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createBrowser } from '../lib/headless-shell.js';

test('component handlers retain base connections when pooled delegates are reused', async () => {
  const dir = mkdtempSync('/tmp/qml-inherited-handlers-');
  let browser;
  try {
    await Bun.write(dir + '/Cell.qml', `import QtQuick
Text {
 id: base
 property bool live: true
 property int baseCompleted: 0
 property int baseReused: 0
 width: 200; height: 20
 Component.onCompleted: base.baseCompleted++
 ListView.onPooled: base.live = false
 ListView.onReused: { base.live = true; base.baseReused++ }
}`);
    await Bun.write(dir + '/main.qml', `import QtQuick
import QtQml.Models
Item {
 id: root; width:300; height:200
 Component.onCompleted: rows.items.addGroups(0,3,"shown")
 property string prefix: "old"
 ListView {
  id: view; width:200; height:100; model:rows; reuseItems:true
  DelegateModel {id:rows;model:100;filterOnGroup:"shown";groups:DelegateModelGroup {id:shown;name:"shown";includeByDefault:false}}
  delegate: Cell {
   id: cell; required property int index
   property int derivedCompleted: 0
   property int derivedReused: 0
   Component.onCompleted: cell.derivedCompleted++
   ListView.onReused: cell.derivedReused++
   text: live ? root.prefix+index+":"+baseCompleted+":"+derivedCompleted+":"+baseReused+":"+derivedReused : cell.text
  }
 }
 Button { id: shrink; y:120; onClicked:{shown.removeGroups(1,2,"shown");view.forceLayout()} }
 Button { id: grow; y:150; onClicked:{root.prefix="new";rows.items.addGroups(1,2,"shown");view.forceLayout()} }
}`);
    browser = await createBrowser({ spareRenderer:false, rendererTimeout:20000 });
    await browser.context.navigate(Bun.pathToFileURL(dir + '/main.qml').href);
    const rows = () => browser.context.evaluate(`Array.from(document.querySelectorAll('[data-qml-type="Text"]')).filter(e=>e.getBoundingClientRect().width>0).map(e=>e.textContent).sort()`);
    expect(await rows()).toEqual(['old0:1:1:0:0','old1:1:1:0:0','old2:1:1:0:0']);
    for (let i=1;i<=3;i++) {
      await browser.context.evaluate('document.getElementById("shrink").click()');
      await browser.context.evaluate('document.getElementById("grow").click()');
      expect(await rows()).toEqual(['new0:1:1:0:0',`new1:1:1:${i}:${i}`,`new2:1:1:${i}:${i}`]);
    }
  } finally { browser?.close(); rmSync(dir,{recursive:true,force:true}); }
},30000);
