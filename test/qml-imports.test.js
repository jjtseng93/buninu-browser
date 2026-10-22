import {test,expect} from 'bun:test';
import {createBrowser} from '../lib/headless-shell.js';
import {loadQmlGraph,parseQmldir} from '../lib/qml/loader.js';
const fixture=new URL('./fixtures/qml/imports/main.qml',import.meta.url);
test('file imports: instances, scoped IDs, singleton, JS imports and qmldir versions',async()=>{
 const browser=await createBrowser({spareRenderer:false});
 try{
  await browser.context.resize(640,440,1);await browser.context.navigate(fixture.href);
  const text=()=>browser.context.evaluate('document.body.textContent');
  expect(await text()).toContain('one:1:1');expect(await text()).toContain('two:1:1');
  expect(await text()).toContain('Shared: 1 / multiply: 42');expect(await text()).toContain('Private ID: undefined');expect(await text()).toContain('module version 1.0');
  await browser.context.evaluate('document.querySelector("[data-qml-type=MouseArea]").click()');
  expect(await text()).toContain('changed');expect(await text()).toContain('two:2:1');expect(await text()).toContain('Shared: 2');
  await Bun.write('/tmp/qml-real-imports.png',Buffer.from(await browser.context.screenshot({format:'png'}),'base64'));
 }finally{browser.close();}
},30000);
test('qmldir version selection respects the requested minor version',()=>{
 const text='module Demo\nThing 1.0 Old.qml\nThing 1.2 New.qml\nThing 2.0 Other.qml';
 expect(parseQmldir(text,'file:///demo/qmldir','1.1').entries.get('Thing').url).toBe('file:///demo/Old.qml');
 expect(parseQmldir(text,'file:///demo/qmldir','1.2').entries.get('Thing').url).toBe('file:///demo/New.qml');
});
test('remote QML cannot request a local file, and native plugins fail explicitly',async()=>{
 const fetch=async()=>({ok:true,body:new TextEncoder().encode('plugin unsafe')});
 await expect(loadQmlGraph('import "file:///tmp"\nItem {}','https://qml.test/main.qml',fetch)).rejects.toThrow('cannot import local');
 await expect(loadQmlGraph('import "."\nItem {}','https://qml.test/main.qml',fetch)).rejects.toThrow('Unsupported qmldir directive');
});

test('HTTP imports share library JS, reset on navigation, and keep ordinary HTML working',async()=>{
 const root=new URL('./fixtures/qml/imports/',import.meta.url);
 const requests=[];
 const server=Bun.serve({port:0,async fetch(req){
   const path=new URL(req.url).pathname;requests.push(path);
   if(path==='/plain')return new Response('<title>plain</title><p>ordinary HTML</p>',{headers:{'content-type':'text/html'}});
   const file=Bun.file(new URL('.'+path,root));
   return await file.exists()?new Response(file,{headers:{'content-type':path.endsWith('.qml')?'text/x-qml':'text/plain'}}):new Response('missing',{status:404});
 }});
 const browser=await createBrowser({spareRenderer:false});
 try{
   const url=`http://127.0.0.1:${server.port}/main.qml`;
   await browser.context.navigate(url);
   expect(await browser.context.evaluate('document.body.textContent')).toContain('one:1:1/1');
   expect(await browser.context.evaluate('document.body.textContent')).toContain('two:1:1/2');
   expect(requests.filter(p=>p==='/theme/Theme.qml').length).toBe(1);
   await browser.context.evaluate('document.querySelector("[data-qml-type=MouseArea]").click()');
   await browser.context.reload();
   expect(await browser.context.evaluate('document.body.textContent')).toContain('one:1:1/1');
   await browser.context.navigate(`http://127.0.0.1:${server.port}/plain`);
   expect(await browser.context.evaluate('document.title')).toBe('plain');
 }finally{browser.close();server.stop(true);}
},30000);

function memoryFetch(files){return async url=>files[url]===undefined?{ok:false,status:404}:{ok:true,body:new TextEncoder().encode(files[url])};}
test('cycle and missing resource diagnostics do not silently substitute stubs',async()=>{
 const {createQmlDocument}=await import('../lib/qml/document.js');
 const url='https://qml.test/main.qml';
 const files={
  'https://qml.test/A.qml':'import QtQuick\nA {}',
  'https://qml.test/bad.js':'.import "./bad.js" as Self\nfunction f() {}',
 };
 const graph=await loadQmlGraph('import QtQuick\nA {}',url,memoryFetch(files));
 expect(createQmlDocument('import QtQuick\nA {}',url,{graph}).document.body.textContent).toContain('Recursive QML component');
 await expect(loadQmlGraph('import "./bad.js" as Bad\nItem {}',url,memoryFetch(files))).rejects.toThrow('Cyclic JS import');
 await expect(loadQmlGraph('import "./missing.js" as Missing\nItem {}',url,memoryFetch(files))).rejects.toThrow('not found');
});
test('readonly component properties reject external overrides',async()=>{
 const {loadQmlDocument}=await import('../lib/qml/document.js');
 const files={
  'https://qml.test/qmldir':'Thing Thing.qml',
  'https://qml.test/Thing.qml':'import QtQuick\nItem { readonly property int count: 1 }'
 };
 const result=await loadQmlDocument('import QtQuick\nThing { count: 2 }','https://qml.test/main.qml',{fetchResource:memoryFetch(files)});
 expect(result.document.body.textContent).toContain('Cannot override readonly');
});

test('singleton cycles, absent pragma, duplicate aliases and import budgets are explicit',async()=>{
 const {loadQmlDocument}=await import('../lib/qml/document.js');
 const url='https://qml.test/main.qml';
 const files={
  'https://qml.test/qmldir':'singleton A A.qml\nsingleton B B.qml',
  'https://qml.test/A.qml':'pragma Singleton\nimport QtQuick\nQtObject { property int n: B.n }',
  'https://qml.test/B.qml':'pragma Singleton\nimport QtQuick\nQtObject { property int n: A.n }',
 };
 const result=await loadQmlDocument('import QtQuick\nText { text: A.n }',url,{fetchResource:memoryFetch(files)});
 expect(result.document.body.textContent).toContain('Cyclic singleton dependency');
 files['https://qml.test/B.qml']='import QtQuick\nQtObject { property int n: 1 }';
 await expect(loadQmlGraph('import QtQuick\nText { text: A.n }',url,memoryFetch(files))).rejects.toThrow('needs pragma Singleton');
 await expect(loadQmlGraph('import QtQuick as Q\nimport QtQuick.Controls as Q\nItem {}',url,memoryFetch({}))).rejects.toThrow('Duplicate QML import alias');
 await expect(loadQmlGraph('import "./big.js" as Big\nItem {}',url,memoryFetch({'https://qml.test/big.js':' '.repeat(256*1024+1)}))).rejects.toThrow('byte limit');
});


test('qualified built-in imports resolve both object types and enums',async()=>{
 const {loadQmlDocument}=await import('../lib/qml/document.js');
 const result=await loadQmlDocument('import QtQuick as Q\nQ.Rectangle { Q.Text { text: "alias"; textFormat: Q.Text.PlainText } }','https://qml.test/main.qml',{fetchResource:memoryFetch({})});
 expect(result.document.querySelector('[data-qml-type="Rectangle"]')).not.toBeNull();
 expect(result.document.querySelector('[data-qml-type="Text"]')).not.toBeNull();
});
