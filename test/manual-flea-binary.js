// Run an installed, unmodified Flea executable through our opt-in qs wrapper.
import { resolve, join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fleaSandbox } from './helpers/flea-sandbox.js';
if (process.argv.some((arg) => ['-h', '--help'].includes(arg))) {
  console.log(
    `Usage: FLEA_BIN=/path/to/flea BUNINU_FLEA_ROOT=/path/to/share/flea bun test/manual-flea-binary.js\n\nUses the current Wayland socket. BUNINU_OMARCHY_ROOT defaults to ../omarchy-qml-reference.\nLaunches the actual binary with --gui; it finds lib/qml/qs through PATH.\nCreates an isolated HOME/XDG state with sample files; removes it on exit.\nNo dependencies are installed. The native Quickshell executable is not replaced.`,
  );
  process.exit(0);
}
const binary = process.env.FLEA_BIN && resolve(process.env.FLEA_BIN);
const root = resolve(process.env.BUNINU_FLEA_ROOT || '../flea');
const omarchy = resolve(
  process.env.BUNINU_OMARCHY_ROOT || '../omarchy-qml-reference',
);
for (const path of [
  binary,
  join(root, 'ui/boot/shell.qml'),
  join(omarchy, 'shell/Commons/qmldir'),
  join(omarchy, 'shell/Ui/qmldir'),
])
  if (!path || !existsSync(path))
    throw Error('Missing binary or QML imports: ' + path);
const sandbox = fleaSandbox(root, omarchy);
mkdirSync(join(sandbox.values.HOME, 'Documents'));
writeFileSync(
  join(sandbox.values.HOME, 'hello.txt'),
  'Official Flea backend, Buninu QML frontend.\n',
);
writeFileSync(
  join(sandbox.values.HOME, 'Documents/inside.txt'),
  'Directory navigation test.\n',
);
let child;
const stop = () => child?.kill();
try {
  child = Bun.spawn([binary, '--gui', sandbox.values.HOME], {
    env: {
      ...process.env,
      PATH:
        Bun.fileURLToPath(new URL('../lib/qml/', import.meta.url)) +
        ':' +
        process.env.PATH,
      FLEA_UI: join(root, 'ui'),
      QSG_RHI_BACKEND: 'opengl',
    },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  console.log(
    'Official Flea -> Buninu qs. Temporary HOME: ' + sandbox.values.HOME,
  );
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(signal, stop);
  process.exitCode = await child.exited;
} finally {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.off(signal, stop);
  child?.kill();
  sandbox.close();
}
