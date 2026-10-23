// Run untouched Flea source through the browser's Wayland frontend, with an
// isolated HOME/XDG state. Set FLEA_BIN to a real installed backend to exercise
// filesystem operations. This script does not provide backend stubs.
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { launch } from '../frontends/wayland/index.js';
import { fleaSandbox } from './helpers/flea-sandbox.js';
if (process.argv.some((arg) => arg === '-h' || arg === '--help')) {
  console.log(`Usage: bun test/manual-flea-application.js

Uses the current WAYLAND_DISPLAY / XDG_RUNTIME_DIR.
BUNINU_FLEA_ROOT       Flea checkout (default ../flea)
BUNINU_OMARCHY_ROOT    Omarchy checkout with shell/Commons and shell/Ui
                      (default ../omarchy-qml-reference)
FLEA_BIN              Optional real Flea backend executable

Without FLEA_BIN, Flea shows its real backend-unavailable state. Settings,
path entry, keyboard help and the network form can still be exercised.
All application state is temporary and removed on exit.
No dependencies are installed by this script.`);
  process.exit(0);
}
const flea = resolve(process.env.BUNINU_FLEA_ROOT || '../flea'),
  omarchy = resolve(
    process.env.BUNINU_OMARCHY_ROOT || '../omarchy-qml-reference',
  );
for (const path of [
  join(flea, 'ui/boot/shell.qml'),
  join(omarchy, 'shell/Commons/qmldir'),
  join(omarchy, 'shell/Ui/qmldir'),
])
  if (!existsSync(path)) throw Error('Missing source checkout: ' + path);
const sandbox = fleaSandbox(flea, omarchy);
let app;
try {
  app = await launch({
    url: Bun.pathToFileURL(join(flea, 'ui/boot/shell.qml')).href,
    width: 1000,
    height: 720,
  });
  console.log('Unmodified Flea QML; isolated state: ' + sandbox.dir);
  console.log('Backend: ' + sandbox.values.FLEA_BIN);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(signal, () => app.close());
  await app.done;
} finally {
  app?.close();
  sandbox.close();
}
