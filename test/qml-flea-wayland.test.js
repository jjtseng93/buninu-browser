// Opt-in real socket test; owns its compositor and never touches a user's Land.
import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { fleaSandbox } from './helpers/flea-sandbox.js';
import { launch } from '../frontends/wayland/index.js';
const flea = process.env.BUNINU_FLEA_ROOT,
  omarchy = process.env.BUNINU_OMARCHY_ROOT;
test.skipIf(!flea || !omarchy || !process.env.BUNINU_QML_WAYLAND_TEST)(
  'real Flea receives Wayland keys and closes through Super-W',
  async () => {
    const { start } = await import('../../buninu-land/compositor.js');
    const sandbox = fleaSandbox(flea, omarchy),
      oldRuntime = process.env.XDG_RUNTIME_DIR;
    let land, app;
    try {
      process.env.XDG_RUNTIME_DIR = sandbox.dir;
      land = await start([
        '--remote-debugging-port=0',
        '--window-size=1000,720',
      ]);
      app = await launch({
        url: Bun.pathToFileURL(join(sandbox.flea, 'ui/boot/shell.qml')).href,
        width: 1000,
        height: 720,
        socket: join(sandbox.dir, 'wayland-buninu'),
      });
      const until = async (predicate) => {
        for (let i = 0; i < 300; i++) {
          if (await predicate()) return;
          await Bun.sleep(40);
        }
        throw Error('Flea Wayland state did not settle');
      };
      const text = () =>
        app.browser.context.evaluate('document.body.innerText');
      await until(() =>
        land.compositor.wm.renderSurfaces().some((s) => s.pixels),
      );
      expect(await text()).toContain('PLACES');
      const key = async (key, code, modifiers = 0) => {
        for (const type of ['keyDown', 'keyUp'])
          land.context.dispatchKeyEvent({ type, key, code, modifiers });
        await Bun.sleep(100);
      };
      await key(',', 'Comma');
      await until(async () => (await text()).includes('Settings'));
      await Bun.write(
        '/tmp/buninu-flea-wayland.png',
        Buffer.from(await land.context.screenshot({ format: 'png' }), 'base64'),
      );
      await key('Escape', 'Escape');
      await until(async () => !(await text()).includes('Settings'));
      let closed = false;
      app.done.then(() => (closed = true));
      await key('w', 'KeyW', 4);
      await until(() => closed);
      await until(() => !land.compositor.wm.visible.length);
      expect(closed).toBe(true);
    } finally {
      app?.close();
      land?.close();
      if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = oldRuntime;
      sandbox.close();
    }
  },
  120000,
);
