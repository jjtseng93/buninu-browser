import { test, expect } from 'bun:test';
import { createBrowser } from '../lib/headless-shell.js';
import { RendererHost } from '../lib/renderer/host.js';
import { mkdtempSync, rmSync } from 'node:fs';
const fixture = new URL('./fixtures/qml/flea-theme/', import.meta.url);
const settle = async (read, predicate) => {
  let value;
  for (let n = 0; n < 80; n++) {
    value = await read();
    if (predicate(value)) return value;
    await Bun.sleep(15);
  }
  throw Error('Did not settle: ' + JSON.stringify(value));
};

test('upstream DialogButton handles click, key repeat, disabled state and animated press', async () => {
  const previous = process.env.QML_IMPORT_PATH;
  process.env.QML_IMPORT_PATH = Bun.fileURLToPath(new URL('imports', fixture));
  const browser = await createBrowser({ spareRenderer: false });
  try {
    await browser.context.navigate(new URL('button.qml', fixture).href);
    const evaluate = (code) => browser.context.evaluate(code);
    const status = () =>
      evaluate('document.getElementById("status").textContent');
    await evaluate('document.getElementById("action").click()');
    await settle(status, (v) => v === 'Activated: 1');
    await evaluate(
      `document.getElementById('action').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}))`,
    );
    await settle(status, (v) => v === 'Activated: 2');
    await evaluate(
      `document.getElementById('action').dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',repeat:true,bubbles:true}))`,
    );
    await Bun.sleep(40);
    expect(await status()).toBe('Activated: 2');
    await evaluate(
      `document.querySelectorAll('[data-qml-type=Column] > [data-qml-type=Item]')[1].click()`,
    );
    expect(await status()).toBe('Activated: 2');
    const inset = () =>
      evaluate(
        `parseFloat(document.getElementById('qml-1-chrome').style.left)`,
      );
    await evaluate(
      `(()=>{const e=document.getElementById('action'),r=e.getBoundingClientRect();e.dispatchEvent(new MouseEvent('mousedown',{clientX:r.x+5,clientY:r.y+5,button:0,bubbles:true}));})()`,
    );
    await settle(inset, (v) => v > 0);
    expect(await inset()).toBeGreaterThan(0);
    await evaluate(
      `document.dispatchEvent(new MouseEvent('mouseup',{button:0,bubbles:true}))`,
    );
    await settle(inset, (v) => v === 0);
  } finally {
    browser.close();
    if (previous === undefined) delete process.env.QML_IMPORT_PATH;
    else process.env.QML_IMPORT_PATH = previous;
  }
}, 30000);

test('inline components preserve lexical IDs and default aliases route inserted content', async () => {
  const dir = mkdtempSync('/tmp/qml-slots-');
  await Bun.write(
    dir + '/Frame.qml',
    `import QtQuick
 Item {id:root;default property alias content:holder.data;Item {id:holder;x:20;y:30}}`,
  );
  await Bun.write(
    dir + '/main.qml',
    `import QtQuick
Item {id:root;property string label:"lexical";width:300;height:200
 component Cell: Text {text:root.label}
 Frame {id:frame;Cell {objectName:"inside"}}
 Cell {id:outside}
 Button {id:change;onClicked:root.label="changed"}
}`,
  );
  const b = await createBrowser({ spareRenderer: false });
  try {
    await b.context.navigate(Bun.pathToFileURL(dir + '/main.qml').href);
    const text = () => b.context.evaluate('document.body.innerText');
    expect(await text()).toContain('lexical');
    expect(
      await b.context.evaluate(
        `document.querySelector('[data-qml-type=Text]').parentElement.id.endsWith('holder')`,
      ),
    ).toBe(true);
    await b.context.evaluate(`document.getElementById('change').click()`);
    await settle(text, (v) => (v.match(/changed/g) || []).length === 2);
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test('SplitParser streams partial UTF-8 lines and Process writes stdin before exit', async () => {
  const dir = mkdtempSync('/tmp/qml-stream-');
  const script = `process.stdout.write('ready\\n');process.stdin.once('data',chunk=>{process.stdout.write(Buffer.from([0xe4,0xbd]));setTimeout(()=>{process.stdout.write(Buffer.concat([Buffer.from([0xa0]),Buffer.from(':'+chunk.toString().trim()+'\\n')]));process.exit(0);},30);});`;
  await Bun.write(
    dir + '/main.qml',
    `import QtQuick
import Quickshell.Io
Text {id:root;property var lines:[];property int code:-1;text:JSON.stringify(lines)+":"+code
 Process {id:child;command:${JSON.stringify([process.execPath, '-e', script])};running:true;stdinEnabled:true
 stdout:SplitParser {onRead:function(data){root.lines=root.lines.concat([data]);if(data==="ready")child.write("reply\\n")}}
 onExited:function(code,status){root.code=code}
 }
}`,
  );
  const b = await createBrowser({ spareRenderer: false });
  try {
    await b.context.navigate(Bun.pathToFileURL(dir + '/main.qml').href);
    const text = () => b.context.evaluate('document.body.innerText');
    await settle(text, (v) => v === '["ready","你:reply"]:0');
    expect(await text()).toBe('["ready","你:reply"]:0');
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test('upstream DialogField forwards writable aliases, text edits, Enter and Tab', async () => {
  const previous = process.env.QML_IMPORT_PATH;
  process.env.QML_IMPORT_PATH = Bun.fileURLToPath(new URL('imports', fixture));
  const browser = await createBrowser({ spareRenderer: false });
  try {
    await browser.context.navigate(new URL('field.qml', fixture).href);
    const status = () =>
      browser.context.evaluate('document.getElementById("status").textContent');
    expect(await status()).toBe('first|0:0:0');
    await browser.context.evaluate('document.getElementById("change").click()');
    await settle(status, (v) => v === 'second|0:0:0');
    await browser.context.press('a', { modifiers: 2 });
    await browser.context.type('hello');
    await settle(status, (v) => v.startsWith('hello|'));
    await browser.context.press('Enter');
    await browser.context.press('Tab');
    await settle(status, (v) => v.endsWith(':1:1'));
    await browser.context.press('Tab', { modifiers: 8 });
    await settle(status, (v) => v.endsWith(':1:0'));
    expect(
      await browser.context.evaluate('document.activeElement.tagName'),
    ).toBe('INPUT');
  } finally {
    browser.close();
    if (previous === undefined) delete process.env.QML_IMPORT_PATH;
    else process.env.QML_IMPORT_PATH = previous;
  }
}, 30000);

test('Keys.forwardTo handles suggestions before the input and accepted keys suppress TextInput.accepted', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,keys',
      contentType: 'text/x-qml',
      source: `
import QtQuick
Item {id:root;width:300;height:200;property int picks:0;property int accepts:0;property int forwards:0
 Item {id:suggestions;Keys.forwardTo:[input];Keys.onReturnPressed:root.picks++}
 TextInput {id:input;width:200;height:40;focus:true;Keys.forwardTo:[suggestions];onAccepted:root.accepts++
  Keys.onEscapePressed:root.forwards++
 }
 Text {id:status;y:50;text:root.picks+":"+root.accepts+":"+root.forwards}
}`,
    });
    await host.call('whenLoaded');
    await host.call('press', 'Enter');
    await host.call('press', 'Escape');
    await settle(
      () =>
        host.call('evaluate', 'document.getElementById("status").textContent'),
      (v) => v === '1:0:1',
    );
  } finally {
    host.close();
  }
}, 30000);

test('text editing consumes handled keys before ancestor shortcuts and keeps Escape bubbling', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,input',
      contentType: 'text/x-qml',
      source: `
import QtQuick
Item {id:root;width:300;height:200;property int parentKeys:0;property int accepts:0
 Keys.onPressed:root.parentKeys++
 TextInput {id:input;width:200;height:40;focus:true;onAccepted:root.accepts++}
 Text {id:status;y:50;text:input.text+":"+root.parentKeys+":"+root.accepts}
}`,
    });
    await host.call('whenLoaded');
    await host.call('press', 'j');
    await host.call('press', 'Enter');
    await host.call('press', 'Escape');
    await settle(
      () =>
        host.call('evaluate', 'document.getElementById("status").textContent'),
      (v) => v === 'j:1:1',
    );
  } finally {
    host.close();
  }
}, 30000);

test('FileView atomic writes signal saved only after replacement and waitForJob flushes pending data', async () => {
  const dir = mkdtempSync('/tmp/qml-file-save-'),
    target = dir + '/reply';
  await Bun.write(target, 'old');
  await Bun.write(
    dir + '/main.qml',
    `import QtQuick
import Quickshell.Io
Item {id:root;property int saves:0;property string failure:""
 FileView {id:file;path:${JSON.stringify(target)};atomicWrites:true;preload:false;onSaved:root.saves++;onSaveFailed:function(error){root.failure=error}}
 Text {id:status;text:root.saves+":"+root.failure}
 Button {id:save;onClicked:{file.setText("first");file.waitForJob();file.setData(new Uint8Array([110,101,120,116]).buffer)}}
}`,
  );
  const b = await createBrowser({ spareRenderer: false });
  try {
    await b.context.navigate(Bun.pathToFileURL(dir + '/main.qml').href);
    await b.context.evaluate('document.getElementById("save").click()');
    await settle(
      () => b.context.evaluate('document.getElementById("status").textContent'),
      (v) => v === '2:',
    );
    expect(await Bun.file(target).text()).toBe('next');
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test('FocusScope ancestors track active focus and restore their last focused child', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,focus',
      contentType: 'text/x-qml',
      source: `import QtQuick
Item {width:400;height:200
 FocusScope {id:scope;width:200;height:60
  TextInput {id:input;width:200;height:30;focus:true;text:"input"}
 }
 Button {id:outside;y:70;text:"Outside"}
 Button {id:back;x:100;y:70;text:"Back";onClicked:scope.forceActiveFocus()}
 Text {id:status;y:120;text:scope.activeFocus+":"+input.activeFocus+":"+outside.activeFocus}
}`,
    });
    await host.call('whenLoaded');
    expect(
      await host.call(
        'evaluate',
        'document.getElementById("status").textContent',
      ),
    ).toBe('true:true:false');
    await host.call('evaluate', 'document.getElementById("outside").focus()');
    expect(
      await host.call(
        'evaluate',
        'document.getElementById("status").textContent',
      ),
    ).toBe('false:false:true');
    await host.call('evaluate', 'document.getElementById("back").click()');
    expect(
      await host.call(
        'evaluate',
        'document.getElementById("status").textContent',
      ),
    ).toBe('true:true:false');
  } finally {
    host.close();
  }
}, 30000);

test('QML key and pointer adapters preserve menu, AltGr and mouse back/forward distinctions', async () => {
  const host = new RendererHost({ timeout: 20000 });
  try {
    await host.start();
    await host.call('loadDocument', {
      url: 'data:text/x-qml,extended-keys',
      contentType: 'text/x-qml',
      source: `import QtQuick
Item {id:root;width:300;height:150;focus:true;property string result:""
 Keys.onPressed:function(event){result+=event.key+":"+event.modifiers+",";event.accepted=true}
 MouseArea {id:area;width:100;height:50;acceptedButtons:Qt.BackButton|Qt.ForwardButton;onClicked:function(mouse){root.result+="mouse:"+mouse.button+","}}
 Text {id:status;y:80;text:root.result}
}`,
    });
    await host.call('whenLoaded');
    await host.call(
      'evaluate',
      `(()=>{const root=document.getElementById('root');for(const key of ['ContextMenu','AltGraph','CapsLock'])root.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));root.dispatchEvent(new KeyboardEvent('keydown',{key:'x',ctrlKey:true,altKey:true,shiftKey:true,metaKey:true,bubbles:true}));const area=document.getElementById('area');for(const button of [0,3,4])area.dispatchEvent(new MouseEvent('click',{button,bubbles:true}));})()`,
    );
    expect(
      await host.call(
        'evaluate',
        'document.getElementById("status").textContent',
      ),
    ).toBe('16777301:0,16781571:0,16777252:0,88:503316480,mouse:8,mouse:16,');
  } finally {
    host.close();
  }
}, 30000);
