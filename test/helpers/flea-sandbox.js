import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
// Application tests own every XDG directory. Backend replies are never replaced.
export function fleaSandbox(flea, omarchy) {
  const dir = mkdtempSync('/tmp/qml-flea-'),
    saved = {};
  const values = {
    HOME: join(dir, 'home'),
    XDG_CONFIG_HOME: join(dir, 'config'),
    XDG_STATE_HOME: join(dir, 'state'),
    XDG_DATA_HOME: join(dir, 'data'),
    XDG_CACHE_HOME: join(dir, 'cache'),
    QML_IMPORT_PATH: join(dir, 'imports'),
    HYPRLAND_INSTANCE_SIGNATURE: '',
    FLEA_BIN: process.env.FLEA_BIN || join(dir, 'no-flea-backend'),
  };
  for (const [key, value] of Object.entries(values)) {
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
    mkdirSync(values[key], { recursive: true });
  mkdirSync(join(dir, 'imports/qs'), { recursive: true });
  for (const name of ['Commons', 'Ui'])
    symlinkSync(
      resolve(omarchy, 'shell', name),
      join(dir, 'imports/qs', name),
      'dir',
    );
  return {
    dir,
    flea: resolve(flea),
    values,
    close() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
