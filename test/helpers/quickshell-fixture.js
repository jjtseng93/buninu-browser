import {
  mkdtempSync,
  cpSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
export async function withQuickshellFixture(file, callback) {
  const { start } = await import('../../../buninu-land/compositor.js');
  const qsRoot = process.env.BUNINU_QS_ROOT,
    dir = mkdtempSync('/tmp/qs-qml-test-'),
    fixture = join(dir, 'fixture'),
    home = join(dir, 'home'),
    oldRuntime = process.env.XDG_RUNTIME_DIR;
  let land, child;
  try {
    cpSync(
      Bun.fileURLToPath(
        new URL('../fixtures/qml/flea-theme/', import.meta.url),
      ),
      fixture,
      { recursive: true },
    );
    const trim = (path) => {
      for (const e of readdirSync(path, { withFileTypes: true })) {
        const p = join(path, e.name);
        if (e.isDirectory()) trim(p);
        else if (e.name === 'qmldir')
          writeFileSync(
            p,
            readFileSync(p, 'utf8')
              .split('\n')
              .filter((line) => {
                const last = line.trim().split(/\s+/).at(-1);
                return !last.endsWith('.qml') || existsSync(join(path, last));
              })
              .join('\n'),
          );
      }
    };
    trim(fixture);
    const theme = join(home, '.local/state/omarchy/current/theme');
    mkdirSync(theme, { recursive: true });
    writeFileSync(join(theme, 'shell.toml'), '[font]\nbase-size = 14\n');
    writeFileSync(
      join(theme, 'colors.toml'),
      'background="#101315"\nforeground="#eeeeee"\naccent="#70e1e8"\n',
    );
    writeFileSync(join(theme, '../theme.name'), 'demo');
    process.env.XDG_RUNTIME_DIR = dir;
    land = await start(['--remote-debugging-port=0', '--window-size=900,700']);
    const lib = join(qsRoot, 'usr/lib/aarch64-linux-gnu');
    child = Bun.spawn(
      [
        join(lib, 'ld-linux-aarch64.so.1'),
        '--library-path',
        lib + ':' + join(qsRoot, 'usr/lib'),
        join(qsRoot, 'usr/bin/qs'),
        '-p',
        join(fixture, file),
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          HYPRLAND_INSTANCE_SIGNATURE: '',
          WAYLAND_DISPLAY: 'wayland-buninu',
          QT_PLUGIN_PATH: join(lib, 'qt6/plugins'),
          QML_IMPORT_PATH:
            join(fixture, 'imports') + ':' + join(lib, 'qt6/qml'),
          QT_QPA_PLATFORM: 'wayland',
          QT_WAYLAND_DISABLE_WINDOWDECORATION: '1',
          QT_QUICK_BACKEND: 'software',
        },
        stdout: 'ignore',
        stderr: 'pipe',
      },
    );
    const logs = new Response(child.stderr).text(),
      title = () => land.compositor.wm.visible[0]?.surface.xdg.toplevel.title;
    const until = async (fn) => {
      for (let i = 0; i < 300; i++) {
        if (await fn()) return;
        if (child.exitCode !== null) throw Error(await logs);
        await Bun.sleep(30);
      }
      throw Error('Quickshell state timed out: ' + title());
    };
    await until(() => title());
    const mouse = async (type, x, y) => {
      const surface = land.compositor.wm.renderSurfaces().find((s) => s.pixels);
      const o = land.compositor.wm.origin(surface);
      land.context.dispatchMouseEvent({
        type,
        x: o.x + x,
        y: o.y + y,
        button: 'left',
      });
      await Bun.sleep(40);
    };
    const click = async (x, y) => {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
        await mouse(type, x, y);
    };
    const key = async (key, code, modifiers = 0) => {
      for (const type of ['keyDown', 'keyUp'])
        land.context.dispatchKeyEvent({ type, key, code, modifiers });
      await Bun.sleep(80);
    };
    await callback({ land, title, until, mouse, click, key });
  } finally {
    if (child) {
      child.kill();
      await child.exited;
    }
    land?.close();
    if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = oldRuntime;
    rmSync(dir, { recursive: true, force: true });
  }
}
