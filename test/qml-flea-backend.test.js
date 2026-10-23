// Opt-in integration: unmodified packaged QML and the real installed Flea binary.
import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createBrowser } from '../lib/headless-shell.js';
import { fleaSandbox } from './helpers/flea-sandbox.js';
const root = process.env.BUNINU_FLEA_ROOT,
  omarchy = process.env.BUNINU_OMARCHY_ROOT,
  binary = process.env.FLEA_BIN;
test.skipIf(!root || !omarchy || !binary)(
  'official backend lists real files, receives navigation and refreshes directory changes',
  async () => {
    const sandbox = fleaSandbox(root, omarchy),
      oldPath = process.env.FLEA_PATH;
    const home = sandbox.values.HOME,
      folder = join(home, 'Documents');
    mkdirSync(folder);
    writeFileSync(join(home, 'hello.txt'), 'hello');
    writeFileSync(join(folder, 'inside.txt'), 'inside');
    process.env.FLEA_PATH = home;
    let browser;
    try {
      browser = await createBrowser({
        spareRenderer: false,
        rendererTimeout: 30000,
      });
      await browser.context.addInitScript(
        `globalThis.qmlErrors=[];addEventListener('error',e=>qmlErrors.push(String(e.error?.stack||e.message)));const original=console.error;console.error=(...args)=>{qmlErrors.push(args.map(String).join(' '));original(...args);};`,
      );
      await browser.context.navigate(
        Bun.pathToFileURL(join(sandbox.flea, 'ui/boot/shell.qml')).href,
      );
      const text = () => browser.context.evaluate('document.body.innerText');
      const until = async (predicate) => {
        for (let n = 0; n < 150; n++) {
          if (await predicate()) return;
          await Bun.sleep(40);
        }
        throw Error('Flea did not settle: ' + (await text()));
      };
      await until(async () => (await text()).includes('hello.txt'));
      writeFileSync(join(home, 'added.txt'), 'watch update');
      await until(async () => (await text()).includes('added.txt'));
      await browser.context.press('l', { code: 'KeyL', modifiers: 2 });
      await until(
        async () =>
          await browser.context.evaluate(
            'document.activeElement?.tagName==="INPUT"',
          ),
      );
      await browser.context.type(folder);
      await browser.context.press('Enter', { code: 'Enter' });
      await until(
        async () =>
          (await text()).includes('inside.txt') &&
          !(await text()).includes('hello.txt'),
      );
      await Bun.write(
        '/tmp/buninu-flea-official-backend.png',
        Buffer.from(
          await browser.context.screenshot({ format: 'png' }),
          'base64',
        ),
      );
      // Wait through the upstream prebuild driver's first idle tick too.
      await Bun.sleep(1500);
      expect(await browser.context.evaluate('JSON.stringify(qmlErrors)')).toBe(
        '[]',
      );
    } finally {
      browser?.close();
      if (oldPath === undefined) delete process.env.FLEA_PATH;
      else process.env.FLEA_PATH = oldPath;
      sandbox.close();
    }
  },
  60000,
);
