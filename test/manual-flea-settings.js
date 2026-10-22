// Real upstream Theme, with isolated sample user data. No Flea/Commons stubs.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from '../frontends/wayland/index.js';
const fixture = new URL('./fixtures/qml/flea-theme/', import.meta.url);
const home = mkdtempSync(join(tmpdir(), 'flea-settings-demo-'));
const theme = join(home, '.local/state/omarchy/current/theme');
mkdirSync(theme, { recursive: true });
await Bun.write(
  join(theme, 'colors.toml'),
  'background = "#101315"\nforeground = "#eeeeee"\naccent = "#70e1e8"\nred = "#ff3333"\n',
);
await Bun.write(join(theme, 'shell.toml'), '[font]\nbase-size = 14\n');
await Bun.write(join(theme, '../theme.name'), 'demo');
const oldHome = process.env.HOME,
  oldImports = process.env.QML_IMPORT_PATH;
process.env.HOME = home;
process.env.QML_IMPORT_PATH = Bun.fileURLToPath(new URL('imports/', fixture));
let app;
try {
  app = await launch({
    url: new URL('settings.qml', fixture).href,
    width: 800,
    height: 420,
  });
  console.log(
    'Real Flea SettingsRuler + Theme; isolated sample data: ' + home,
  );
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(signal, () => app.close());
  await app.done;
} finally {
  app?.close();
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldImports === undefined) delete process.env.QML_IMPORT_PATH;
  else process.env.QML_IMPORT_PATH = oldImports;
  rmSync(home, { recursive: true, force: true });
}
