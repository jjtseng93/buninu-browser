import {test,expect} from 'bun:test';
import {createBrowser} from '../lib/headless-shell.js';
import {createQmlDocument} from '../lib/qml/document.js';


test('Flea EscapeHint imports a real singleton and shares reactive theme updates',async()=>{
 const browser=await createBrowser({spareRenderer:false});
 try{
  await browser.context.resize(640,400,1);
  await browser.context.navigate(new URL('./fixtures/qml/flea/demo.qml',import.meta.url).href);
  expect(await browser.context.evaluate('document.title')).toBe('Browser — Flea real import test');
  const colors=()=>browser.context.evaluate("JSON.stringify([...document.querySelectorAll('[data-qml-type=Text]')].filter(e=>e.textContent==='esc').map(e=>e.style.color))");
  expect(JSON.parse(await colors())).toEqual(['#70e1e8','#70e1e8']);
  await browser.context.evaluate('document.querySelector("button").click()');
  expect(JSON.parse(await colors())).toEqual(['#ffcc66','#ffcc66']);
  await browser.context.evaluate('document.querySelector("button").click()');
  expect(JSON.parse(await colors())).toEqual(['#70e1e8','#70e1e8']);
  expect(await browser.context.evaluate('typeof Theme')).toBe('undefined');
  await Bun.write('/tmp/browser-flea-import.png',Buffer.from(await browser.context.screenshot({format:'png'}),'base64'));
 }finally{browser.close();}
},30000);
test('unsupported rich text remains an explicit diagnostic',()=>{
 const {document}=createQmlDocument('import QtQuick\nText { text: "<b>text</b>"; textFormat: Text.RichText }','https://qml.test/text.qml');
 expect(document.body.textContent).toContain('only Text.PlainText');
 expect(document.querySelector('b')).toBeNull();
});
