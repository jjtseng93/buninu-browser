import {test,expect} from 'bun:test';
import {parseQml} from '../lib/qml/parser.js';
import {createQmlDocument} from '../lib/qml/document.js';
import {isQmlDocument} from '../lib/qml/format.js';
import {displayDocument} from '../lib/document-types.js';
import {RendererHost} from '../lib/renderer/host.js';
const url='https://qml.test/hello.qml';
const source=await Bun.file(new URL('./fixtures/qml/hello.qml',import.meta.url)).text();

test('QML builds DOM directly, preserves source through response classification',()=>{
 const response=displayDocument({url,contentType:'text/plain',body:new TextEncoder().encode(source)});
 expect(response).toEqual({source,contentType:'text/x-qml'});
 expect(isQmlDocument(url,'text/html')).toBe(false);
 const {document}=createQmlDocument(source,url);
 expect(document.querySelectorAll('[data-qml-node]').length).toBe(4);
 expect(document.querySelector('#root')).not.toBeNull();
 expect(document.querySelector('script').textContent).toContain('addEventListener');
});
test('unsupported imports/types are visible diagnostics and source is inert',()=>{
 const {document}=createQmlDocument('import Evil\nRectangle { color: "<script>boom</script>" }',url);
 expect(document.body.textContent).toContain('Unsupported QML import');
 expect(document.querySelector('script')).toBeNull();
 expect(()=>parseQml('Rectangle { width: }')).toThrow();
 const disabled=createQmlDocument(source,url,{scripting:false}).document;
 expect(disabled.querySelector('script')).toBeNull();
 expect(disabled.body.textContent).toContain('requires page scripting');
});
test('Acorn handles modern JS expressions and braces inside strings',()=>{
 const ast=parseQml('import QtQuick\nText { text: ({a: "}"})?.a ?? "fallback"; onClicked: { console.log("}"); } }');
 expect(ast.root.properties.length).toBe(2);
});
test('QML uses normal realm, reactive DOM, input, viewport resize and navigation',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start(); await host.call('resize',640,360,1);
  await host.call('loadDocument',{url,source,contentType:'text/x-qml'}); await host.call('whenLoaded');
  expect(await host.call('evaluate','document.title')).toBe('QML DOM experiment');
  expect(await host.call('evaluate','document.getElementById("button").style.width')).toBe('320px');
  expect(await host.call('evaluate','document.body.textContent.includes("Hello World! Clicks: 0")')).toBe(true);
  await host.call('evaluate',`document.querySelector('[data-qml-node="3"]').click()`);
  expect(await host.call('evaluate',`document.querySelector('[data-qml-node="2"]').textContent`)).toBe('Hello World! Clicks: 1');
  await host.call('resize',800,400,1);
  expect(await host.call('evaluate','document.getElementById("button").style.width')).toBe('400px');
  await host.call('loadDocument',{url,contentType:'text/x-qml',source:`import QtQuick
Rectangle {
 id: root
 implicitWidth: 300
 implicitHeight: 120
 property int count: 1
 Rectangle { id: child; anchors.fill: parent
  Text { id: label; text: root.count + ":" + parent.width }
 }
 onClicked: { root.width = 222; root.implicitWidth = 500; root.count++; }
}`}); await host.call('whenLoaded');
  expect(await host.call('evaluate','document.getElementById("label").textContent')).toBe('1:300');
  await host.call('evaluate','document.getElementById("root").click()');
  expect(await host.call('evaluate','document.getElementById("label").textContent')).toBe('2:222');
  await host.call('loadDocument',{url:'https://qml.test/plain' ,source:'<p>ordinary HTML</p>',contentType:'text/html'});await host.call('whenLoaded');
  expect(await host.call('evaluate','document.body.textContent')).toBe('ordinary HTML');
 }finally{host.close();}
},30000);
