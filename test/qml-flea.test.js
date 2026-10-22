import {test,expect} from 'bun:test';
import {createBrowser} from '../lib/headless-shell.js';
import {createQmlDocument} from '../lib/qml/document.js';
import {themeScript,wrapEscapeHint} from './fixtures/qml/flea/harness.js';

const source=await Bun.file(new URL('./fixtures/qml/flea/EscapeHint.qml',import.meta.url)).text();
test('Flea upstream EscapeHint renders with an explicitly supplied test Theme',async()=>{
 const browser=await createBrowser({spareRenderer:false});
 try{
  browser.context.addInitScript(themeScript);
  await browser.context.resize(640,400,1);
  await browser.context.navigate('data:text/x-qml,'+encodeURIComponent(wrapEscapeHint(source)));
  expect(await browser.context.evaluate("document.title")).toBe('Browser — Flea EscapeHint test');
  const actual=JSON.parse(await browser.context.evaluate(`JSON.stringify((()=>{
    const node=[...document.querySelectorAll('[data-qml-type="Text"]')].find(e=>e.textContent==='esc');
    if(!node)return null;
    const r=node.getBoundingClientRect();return {text:node.textContent,color:node.style.color,font:node.style.fontSize,width:r.width,height:r.height};
  })())`));
  expect(actual.text).toBe('esc');expect(actual.color).toBe('#70e1e8');expect(actual.font).toBe('24px');
  expect(actual.width).toBeGreaterThan(0);expect(actual.height).toBeGreaterThan(0);
  await Bun.write('/tmp/browser-flea-escapehint.png',Buffer.from(await browser.context.screenshot({format:'png'}),'base64'));
 }finally{browser.close();}
},30000);
test('unsupported rich text remains an explicit diagnostic',()=>{
 const {document}=createQmlDocument('import QtQuick\nText { text: "<b>text</b>"; textFormat: Text.RichText }','https://qml.test/text.qml');
 expect(document.body.textContent).toContain('only Text.PlainText');
 expect(document.querySelector('b')).toBeNull();
});
