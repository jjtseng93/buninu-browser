// Actual official executable -> PATH qs wrapper -> browser -> wl_shm on own Land.
import { test, expect } from 'bun:test';
import { join, resolve } from 'node:path';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { fleaSandbox } from './helpers/flea-sandbox.js';
const root = process.env.BUNINU_FLEA_ROOT,
  omarchy = process.env.BUNINU_OMARCHY_ROOT,
  binary = process.env.FLEA_BIN;
test.skipIf(
  !root || !omarchy || !binary || !process.env.BUNINU_QML_WAYLAND_TEST,
)(
  'official Flea executable starts our qs wrapper and closes through Wayland',
  async () => {
    const { start } = await import('../../buninu-land/compositor.js');
    const sandbox = fleaSandbox(root, omarchy),
      previous = process.env.XDG_RUNTIME_DIR;
    let land, child, logs;
    try {
      const wrapperDir = join(sandbox.dir, 'bin');
      mkdirSync(wrapperDir);
      symlinkSync(resolve('lib/qml/qswayland'), join(wrapperDir, 'qs'));
      mkdirSync(join(sandbox.values.HOME, 'Documents'));
      writeFileSync(join(sandbox.values.HOME, 'hello.txt'), 'hello');
      process.env.XDG_RUNTIME_DIR = sandbox.dir;
      land = await start([
        '--remote-debugging-port=0',
        '--window-size=900,600',
      ]);
      child = Bun.spawn([resolve(binary), '--gui', sandbox.values.HOME], {
        env: {
          ...process.env,
          PATH: wrapperDir + ':' + process.env.PATH,
          FLEA_UI: join(sandbox.flea, 'ui'),
          WAYLAND_DISPLAY: 'wayland-buninu',
          QSG_RHI_BACKEND: 'software',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      logs = Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const until = async (fn) => {
        for (let n = 0; n < 500; n++) {
          if (await fn()) return;
          if (child.exitCode !== null)
            throw Error('Flea exited: ' + (await logs).join('\n'));
          await Bun.sleep(40);
        }
        throw Error('Flea wrapper did not settle');
      };
      await until(() =>
        land.compositor.wm.renderSurfaces().some((s) => s.pixels),
      );
      await Bun.sleep(4000);
      const surfaces = land.compositor.wm
        .renderSurfaces()
        .filter((s) => s.pixels);
      expect(surfaces.length).toBeGreaterThan(0);
      await Bun.write(
        '/tmp/buninu-flea-official-launcher.png',
        Buffer.from(await land.context.screenshot({ format: 'png' }), 'base64'),
      );
      for (const type of ['keyDown', 'keyUp'])
        land.context.dispatchKeyEvent({
          type,
          key: 'w',
          code: 'KeyW',
          modifiers: 4,
        });
      await until(() => child.exitCode !== null);
      expect(await child.exited).toBe(0);
      const output = (await logs).join('\n');
      expect(output).not.toMatch(
        /page error:|QML Loader:|QML createObject:|Wayland frontend:/,
      );
    } finally {
      child?.kill();
      if (child) await child.exited;
      land?.close();
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
      sandbox.close();
    }
  },
  60000,
);
