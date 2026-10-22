import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowser } from '../lib/headless-shell.js';
import { createQmlHost } from '../lib/qml/host.js';
const root = new URL('./fixtures/qml/flea-theme/', import.meta.url);
const delay = () => Bun.sleep(60);
async function until(fn) {
  for (let i = 0; i < 40; i++) {
    if (await fn()) return;
    await delay();
  }
  throw Error('condition did not settle');
}
test('local QML has a fresh host process; same-directory HTML and HTTP QML stay isolated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qml-host-'));
  await Bun.write(join(dir, 'main.qml'), 'import QtQuick\nText {text: "host"}');
  await Bun.write(join(dir, 'plain.html'), '<title>plain</title>');
  const b = await createBrowser({ spareRenderer: false });
  try {
    await b.context.navigate(Bun.pathToFileURL(join(dir, 'main.qml')).href);
    const pid = await b.context.evaluate('process.pid');
    expect(typeof pid).toBe('number');
    expect(await b.context.evaluate('typeof __qmlHost.read')).toBe('function');
    await b.context.reload();
    expect(await b.context.evaluate('process.pid')).not.toBe(pid);
    await b.context.navigate(Bun.pathToFileURL(join(dir, 'plain.html')).href);
    expect(await b.context.evaluate('typeof Bun')).toBe('undefined');
    expect(await b.context.evaluate('typeof __qmlHost')).toBe('undefined');
    expect(await b.context.evaluate('document.title')).toBe('plain');
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
test('real upstream Theme resolves palette, Commons typography and watches theme changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qml-theme-')),
    oldHome = process.env.HOME,
    oldRoots = process.env.QML_IMPORT_PATH;
  const current = join(dir, '.local/state/omarchy/current');
  mkdirSync(join(current, 'theme'), { recursive: true });
  await Bun.write(
    join(current, 'theme/colors.toml'),
    'background = "#101315"\nforeground = "#eeeeee"\naccent = "#70e1e8"\nred = "#ff3333"\n',
  );
  await Bun.write(
    join(current, 'theme/shell.toml'),
    '[font]\nbase-size = 14\n',
  );
  await Bun.write(join(current, 'theme.name'), 'first');
  process.env.HOME = dir;
  process.env.QML_IMPORT_PATH = Bun.fileURLToPath(new URL('imports/', root));
  const b = await createBrowser({ spareRenderer: false });
  try {
    await b.context.navigate(new URL('demo.qml', root).href);
    const text = () => b.context.evaluate('document.body.innerText');
    await until(async () =>
      String(await text()).includes('Palette ready: true'),
    );
    expect(await text()).toContain('baseSize=14');
    expect(await text()).not.toContain('NaN');
    expect(await text()).not.toContain('undefined');
    const background = () =>
      b.context.evaluate(
        'document.querySelector("[data-qml-type=FloatingWindow]").style.backgroundColor',
      );
    const before = await background();
    await b.context.evaluate('document.querySelector("button").click()');
    expect(await background()).not.toBe(before);
    await b.context.evaluate('document.querySelector("button").click()');
    expect(await background()).toBe(before);
    await Bun.write(
      join(current, 'theme/shell.toml'),
      '[font]\nbase-size = 18\n',
    );
    await Bun.write(join(current, 'theme.name'), 'second');
    await until(async () => String(await text()).includes('baseSize=18'));
    await Bun.write(
      '/tmp/browser-real-flea-theme.png',
      Buffer.from(await b.context.screenshot({ format: 'png' }), 'base64'),
    );
  } finally {
    b.close();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldRoots === undefined) delete process.env.QML_IMPORT_PATH;
    else process.env.QML_IMPORT_PATH = oldRoots;
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
test('host disposal stops a running process and invalidates file access', async () => {
  const host = createQmlHost('file:///tmp/test.qml');
  let replied = false;
  host.run([process.execPath, '-e', 'setTimeout(()=>{},10000)'], () => {
    replied = true;
  });
  host.dispose();
  expect(() => host.read('/tmp/test.qml')).toThrow('closed');
  await delay();
  expect(replied).toBe(false);
});
test('navigating away from a QML Process terminates its child, not just its callbacks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qml-process-')),
    marker = join(dir, 'pid');
  const command = [
    process.execPath,
    '-e',
    `await Bun.write(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`,
  ];
  await Bun.write(
    join(dir, 'process.qml'),
    `import QtQuick\nimport Quickshell.Io\nItem {Process { running: true; command: ${JSON.stringify(command)} }} `,
  );
  await Bun.write(join(dir, 'plain.html'), '<p>plain</p>');
  const b = await createBrowser({ spareRenderer: false });
  let pid;
  try {
    await b.context.navigate(Bun.pathToFileURL(join(dir, 'process.qml')).href);
    await until(() => Bun.file(marker).exists());
    pid = Number(await Bun.file(marker).text());
    process.kill(pid, 0);
    await b.context.navigate(Bun.pathToFileURL(join(dir, 'plain.html')).href);
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(await b.context.evaluate('typeof __qmlHost')).toBe('undefined');
  } finally {
    b.close();
    if (pid)
      try {
        process.kill(pid);
      } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
test('QML Process stdout and exit signal reach reactive DOM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qml-stdout-'));
  const command = [process.execPath, '-e', 'process.stdout.write("42")'];
  await Bun.write(
    join(dir, 'main.qml'),
    `import QtQuick\nimport Quickshell.Io\nText {id: root; property int code: -1; text: collector.text + ":" + code; Process {running: true; command: ${JSON.stringify(command)}; stdout: StdioCollector {id: collector; waitForEnd: true}; onExited: function(exitCode,exitStatus) {root.code=exitCode} }}`,
  );
  const b = await createBrowser({ spareRenderer: false });
  try {
    await b.context.navigate(Bun.pathToFileURL(join(dir, 'main.qml')).href);
    await until(
      async () =>
        (await b.context.evaluate('document.body.innerText')) === '42:0',
    );
    expect(await b.context.evaluate('document.body.innerText')).toBe('42:0');
  } finally {
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
