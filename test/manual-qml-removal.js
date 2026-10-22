// Run explicitly: bun test/manual-qml-removal.js
// Test the ordinary browser after physically removing every QML integration.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = Bun.fileURLToPath(new URL('../', import.meta.url));
const copy = mkdtempSync(join(tmpdir(), 'browser-without-qml-'));
const files = [
  'lib/document-types.js',
  'lib/headless-shell.js',
  'lib/renderer/page-renderer.js',
  'lib/renderer/host.js',
  'lib/renderer/main.js',
];
try {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const from = join(source, entry.name), to = join(copy, entry.name);
    if (entry.isDirectory() && !['lib', 'test'].includes(entry.name)) symlinkSync(from, to, 'dir');
    else cpSync(from, to, { recursive: true });
  }
  let blocks = 0;
  for (const file of files) {
    const path = join(copy, file);
    const stripped = readFileSync(path, 'utf8').replace(
      /^[ \t]*\/\/ qml handle begin:[^\n]*\n[\s\S]*?^[ \t]*\/\/ qml handle end[^\n]*(?:\n|$)/gm,
      () => { blocks++; return ''; },
    );
    if (/qml/i.test(stripped)) throw Error(`QML reference remains in ${file}`);
    writeFileSync(path, stripped);
  }
  rmSync(join(copy, 'lib/qml'), { recursive: true });
  console.log(`Removed ${blocks} integration blocks and lib/qml in ${copy}`);
  const child = Bun.spawn([
    process.execPath, 'test',
    'test/renderer-host.test.js', 'test/navigation.test.js', 'test/headless-shell.test.js',
  ], { cwd: copy, stdout: 'inherit', stderr: 'inherit' });
  const code = await child.exited;
  if (code) throw Error(`Browser regression tests exited ${code}`);
} finally {
  rmSync(copy, { recursive: true, force: true });
}
