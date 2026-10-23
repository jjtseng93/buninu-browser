import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { createBrowser } from '../lib/headless-shell.js';
import { fleaSandbox } from './helpers/flea-sandbox.js';
const flea = process.env.BUNINU_FLEA_ROOT,
  omarchy = process.env.BUNINU_OMARCHY_ROOT;
for (const [type, extension, contents, expected] of [
  [
    'PreviewText',
    'txt',
    Array.from({ length: 80 }, (_, i) => 'example line ' + i).join('\n'),
    'example line 0',
  ],
  ['PreviewText', 'csv', 'Name,Count\nApple,12\nOrange,9\n', 'Apple'],
  [
    'PreviewMarkdown',
    'md',
    '# Flea preview\n\nA **bold** paragraph.\n\n- First item\n- Second item\n',
    'Flea preview',
  ],
])
  test.skipIf(!flea || !omarchy)(
    'unchanged Flea ' + type + ' renders a real .' + extension + ' file',
    async () => {
      const sandbox = fleaSandbox(flea, omarchy);
      let browser;
      try {
        const path = join(sandbox.dir, 'sample.' + extension);
        await Bun.write(path, contents);
        const file = join(sandbox.dir, 'main.qml');
        await Bun.write(
          file,
          `import QtQuick
import ${JSON.stringify(join(sandbox.flea, 'ui'))} as Flea
Rectangle {width:800;height:600;color:Flea.Theme.color.background
 Flea.${type} {id:preview;anchors.fill:parent;active:true;path:${JSON.stringify(path)};size:${Buffer.byteLength(contents)}}
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
        let text = '';
        for (let i = 0; i < 150; i++) {
          text = await browser.context.evaluate('document.body.innerText');
          if (text.includes(expected)) break;
          await Bun.sleep(40);
        }
        expect(
          await browser.context.evaluate('JSON.stringify(qmlErrors)'),
        ).toBe('[]');
        expect(text).toContain(expected);
        await Bun.write(
          '/tmp/buninu-flea-preview-' + extension + '.png',
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

for (const extension of ['svg', 'png'])
  test.skipIf(!flea || !omarchy)(
    'unchanged Flea PreviewImage loads, zooms and resets a real ' +
      extension +
      ' image',
    async () => {
      const sandbox = fleaSandbox(flea, omarchy);
      let browser;
      try {
        const path = join(sandbox.dir, 'sample.' + extension);
        if (extension === 'svg')
          await Bun.write(
            path,
            '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="160" height="160" fill="#ff0000"/><rect x="160" width="160" height="160" fill="#0000ff"/></svg>',
          );
        else {
          const { encodeImage } = await import('../lib/paint/frame.js');
          const pixels = new Uint8Array(320 * 160 * 4);
          for (let y = 0; y < 160; y++)
            for (let x = 0; x < 320; x++)
              pixels.set(
                x < 160 ? [255, 0, 0, 255] : [0, 0, 255, 255],
                (y * 320 + x) * 4,
              );
          await Bun.write(path, await encodeImage(pixels, 320, 160));
        }
        const file = join(sandbox.dir, 'image.qml');
        await Bun.write(
          file,
          `import QtQuick
import ${JSON.stringify(join(sandbox.flea, 'ui'))} as Flea
Rectangle {width:800;height:600;color:Flea.Theme.color.background
 Flea.PreviewImage {id:preview;anchors.fill:parent;path:${JSON.stringify(path)}}
 Text {id:status;text:preview.status+":"+preview.zoom+":"+preview.fullPicture.drawn}
 Button {id:zoom;y:550;text:"Zoom";onClicked:preview.zoomBy(1)}
 Button {id:fit;x:100;y:550;text:"Fit";onClicked:preview.zoomFit()}
}`,
        );
        browser = await createBrowser({
          spareRenderer: false,
          rendererTimeout: 30000,
        });
        await browser.context.addInitScript(
          `globalThis.qmlErrors=[];addEventListener('error',e=>qmlErrors.push(String(e.error?.stack||e.message)));`,
        );
        await browser.context.navigate(Bun.pathToFileURL(file).href);
        const until = async (predicate) => {
          for (let i = 0; i < 150; i++) {
            const status = await browser.context.evaluate(
              'document.getElementById("status")?.textContent',
            );
            if (predicate(status)) return status;
            await Bun.sleep(40);
          }
          throw Error(
            await browser.context.evaluate(
              'document.body.innerText+JSON.stringify(qmlErrors)',
            ),
          );
        };
        await until((s) => s?.startsWith('image:1:'));
        await browser.context.evaluate(
          'document.getElementById("zoom").click()',
        );
        const zoomed = await until(
          (s) =>
            s?.startsWith('image:') &&
            !s.startsWith('image:1:') &&
            s.endsWith(':true'),
        );
        expect(zoomed).toContain(':true');
        await Bun.write(
          '/tmp/buninu-flea-preview-' + extension + '.png',
          Buffer.from(
            await browser.context.screenshot({ format: 'png' }),
            'base64',
          ),
        );
        await browser.context.evaluate(
          'document.getElementById("fit").click()',
        );
        await until((s) => s === 'image:1:false');
        expect(
          await browser.context.evaluate('JSON.stringify(qmlErrors)'),
        ).toBe('[]');
      } finally {
        browser?.close();
        sandbox.close();
      }
    },
    60000,
  );
