// Opt-in integration against an unchanged Flea/Omarchy checkout. This never
// substitutes backend replies. Without FLEA_BIN the real unavailable state is expected.
import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBrowser } from '../lib/headless-shell.js';
const flea = process.env.BUNINU_FLEA_ROOT,
  omarchy = process.env.BUNINU_OMARCHY_ROOT;
test.skipIf(!flea || !omarchy)(
  'unchanged Flea boots and opens, switches and closes its real settings panel',
  async () => {
    const dir = mkdtempSync('/tmp/qml-flea-app-'),
      saved = {};
    const variables = {
      HOME: join(dir, 'home'),
      XDG_CONFIG_HOME: join(dir, 'config'),
      XDG_STATE_HOME: join(dir, 'state'),
      XDG_DATA_HOME: join(dir, 'data'),
      XDG_CACHE_HOME: join(dir, 'cache'),
      QML_IMPORT_PATH: join(dir, 'imports'),
      HYPRLAND_INSTANCE_SIGNATURE: '',
      FLEA_BIN: process.env.FLEA_BIN || join(dir, 'no-flea-backend'),
    };
    for (const [key, value] of Object.entries(variables)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    for (const key of [
      'HOME',
      'XDG_CONFIG_HOME',
      'XDG_STATE_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
    ])
      mkdirSync(variables[key], { recursive: true });
    mkdirSync(join(dir, 'imports/qs'), { recursive: true });
    for (const name of ['Commons', 'Ui'])
      symlinkSync(
        resolve(omarchy, 'shell', name),
        join(dir, 'imports/qs', name),
        'dir',
      );
    let browser;
    try {
      browser = await createBrowser({
        spareRenderer: false,
        rendererTimeout: 60000,
      });
      await browser.context.addInitScript(
        `globalThis.qmlErrors=[];addEventListener('error',e=>qmlErrors.push(String(e.error?.stack||e.message)));const originalError=console.error;console.error=(...args)=>{qmlErrors.push(args.map(String).join(' '));originalError(...args);};`,
      );
      await browser.context.navigate(
        Bun.pathToFileURL(resolve(flea, 'ui/boot/shell.qml')).href,
      );
      const text = () => browser.context.evaluate('document.body.innerText');
      const until = async (fn) => {
        for (let i = 0; i < 150; i++) {
          if (await fn()) return;
          await Bun.sleep(40);
        }
        throw Error('Flea did not settle: ' + (await text()));
      };
      await until(async () => (await text()).includes('PLACES'));
      const clickExpression = async (expression) => {
        const point = JSON.parse(
          await browser.context.evaluate(
            `(()=>{const e=${expression};if(!e)throw Error('Missing Flea control');const r=e.getBoundingClientRect();return JSON.stringify([r.x+r.width/2,r.y+r.height/2]);})()`,
          ),
        );
        await browser.context.click(...point);
      };
      await clickExpression(`document.querySelector('[aria-label="sliders"]')`);
      await until(async () => (await text()).includes('Settings'));
      const visibleLabel = (label) =>
        `[...document.querySelectorAll('[data-qml-type=Text]')].find(e=>e.textContent===${JSON.stringify(label)}&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0)`;
      await clickExpression(visibleLabel('Display'));
      await until(async () => (await text()).includes('Text size'));
      await Bun.write(
        '/tmp/buninu-flea-settings-display.png',
        Buffer.from(
          await browser.context.screenshot({ format: 'png' }),
          'base64',
        ),
      );
      await clickExpression(visibleLabel('Keys'));
      await until(async () => (await text()).includes('Keybinding preset'));
      await browser.context.press('Escape', { code: 'Escape' });
      await until(async () => !(await text()).includes('Settings'));
      await browser.context.press('l', { modifiers: 2 });
      await until(
        async () =>
          await browser.context.evaluate(
            'document.activeElement?.tagName==="INPUT"',
          ),
      );
      await browser.context.type('/tmp/example');
      expect(
        await browser.context.evaluate('document.activeElement.value'),
      ).toBe('/tmp/example');
      await browser.context.press('Escape');
      await until(
        async () =>
          await browser.context.evaluate(
            'document.activeElement?.tagName!=="INPUT"',
          ),
      );
      await browser.context.press('?', { code: 'Slash', modifiers: 8 });
      await until(async () => (await text()).includes('esc closes'));
      await browser.context.press('Escape');
      await browser.context.press('a');
      await until(async () => (await text()).includes('Connect and save'));
      await browser.context.type('example.invalid');
      await until(async () => (await text()).includes('smb://example.invalid'));
      await clickExpression(visibleLabel('SFTP'));
      await until(async () =>
        (await text()).includes('sftp://example.invalid'),
      );
      await Bun.write(
        '/tmp/buninu-flea-network.png',
        Buffer.from(
          await browser.context.screenshot({ format: 'png' }),
          'base64',
        ),
      );
      await browser.context.press('Escape');
      expect(await browser.context.evaluate('JSON.stringify(qmlErrors)')).toBe(
        '[]',
      );
      await Bun.write(
        '/tmp/buninu-flea-app.png',
        Buffer.from(
          await browser.context.screenshot({ format: 'png' }),
          'base64',
        ),
      );
    } finally {
      browser?.close();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120000,
);
