// Component tests with ordinary input data, not a replacement Flea backend.
import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { createBrowser } from '../lib/headless-shell.js';
import { fleaSandbox } from './helpers/flea-sandbox.js';
const flea = process.env.BUNINU_FLEA_ROOT,
  omarchy = process.env.BUNINU_OMARCHY_ROOT;
for (const type of ['Row', 'GridTile'])
  test.skipIf(!flea || !omarchy)(
    'unchanged Flea ' +
      type +
      ' displays file metadata and reacts to changed input',
    async () => {
      const sandbox = fleaSandbox(flea, omarchy);
      let browser;
      try {
        const file = join(sandbox.dir, 'rows.qml');
        await Bun.write(
          file,
          `import QtQuick
import ${JSON.stringify(join(sandbox.flea, 'ui'))} as Flea
Rectangle {id:root;width:800;height:600;color:Flea.Theme.color.background
 property var entry:({n:"example-notes.txt",s:12345,m:1700000000,p:33188,i:"file",k:0,d:false})
 Flea.${type} {id:row;x:20;y:30;width:${type === 'Row' ? 760 : 260};height:${type === 'Row' ? 60 : 300};row:root.entry;cursor:true}
 ${
   type === 'GridTile'
     ? `Text {id:captionMetrics;x:400;y:400;text:row.captionItem.lineCount+":"+row.captionItem.truncated}
 Button {id:longName;x:200;y:500;text:"Long filename";onClicked:root.entry=({n:"a very long file name with many words and notes.txt",s:456,m:1700000000,p:33188,i:"file",k:0,d:false})}`
     : ''
 }
 Button {id:change;y:500;text:"Change input";onClicked:root.entry=({n:"renamed-notes.txt",s:456,m:1700000000,p:33188,i:"file",k:0,d:false})}
}`,
        );
        browser = await createBrowser({
          spareRenderer: false,
          rendererTimeout: 30000,
        });
        await browser.context.addInitScript(
          `globalThis.qmlErrors=[];addEventListener('error',e=>qmlErrors.push(String(e.error?.stack||e.message)));const old=console.error;console.error=(...args)=>{qmlErrors.push(args.map(String).join(' '));old(...args);};`,
        );
        await browser.context.navigate(Bun.pathToFileURL(file).href);
        const ready = await browser.context.evaluate(
          '!!document.getElementById("change")',
        );
        if (!ready)
          throw Error(
            await browser.context.evaluate(
              'document.querySelector("p")?.textContent||document.body.innerText',
            ),
          );

        const until = async (word) => {
          for (let i = 0; i < 150; i++) {
            const text = await browser.context.evaluate(
              'document.body.innerText',
            );
            if (text.includes(word)) return;
            await Bun.sleep(40);
          }
          throw Error(
            await browser.context.evaluate(
              'document.body.innerText+JSON.stringify(qmlErrors)',
            ),
          );
        };
        await until('example-notes.txt');
        await browser.context.evaluate(
          'document.getElementById("change").click()',
        );
        await until('renamed-notes.txt');
        if (type === 'GridTile') {
          await browser.context.evaluate(
            'document.getElementById("longName").click()',
          );
          let metric = '';
          for (let i = 0; i < 100; i++) {
            metric = await browser.context.evaluate(
              'document.getElementById("captionMetrics").textContent',
            );
            if (metric === '2:false') break;
            await Bun.sleep(20);
          }
          expect(metric).toBe('2:false');
        }
        expect(
          await browser.context.evaluate('JSON.stringify(qmlErrors)'),
        ).toBe('[]');
        await Bun.write(
          '/tmp/buninu-flea-' + type + '.png',
          Buffer.from(
            await browser.context.screenshot({ format: 'png' }),
            'base64',
          ),
        );
      } finally {
        browser?.close();
        sandbox.close();
      }
    },
    60000,
  );
