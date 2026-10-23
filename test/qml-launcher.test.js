import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { backendArgs, parseArgs } from '../lib/qml/launcher.js';
test('qs accepts official -p invocation, paths with spaces and named config, rejecting unknown options', () => {
  const dir = mkdtempSync('/tmp/qml-launcher-');
  try {
    const path = join(dir, 'with spaces');
    mkdirSync(path);
    writeFileSync(join(path, 'shell.qml'), 'import QtQuick\nItem {}');
    expect(parseArgs(['-p', path], {}).path).toBe(join(path, 'shell.qml'));
    expect(parseArgs(['--path=' + join(path, 'shell.qml')], {}).path).toBe(
      join(path, 'shell.qml'),
    );
    expect(parseArgs([], { QS_CONFIG_PATH: path }).path).toBe(
      join(path, 'shell.qml'),
    );
    const config = join(dir, 'quickshell/demo');
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'shell.qml'), '');
    expect(parseArgs(['-c', 'demo'], { XDG_CONFIG_HOME: dir }).path).toBe(
      join(config, 'shell.qml'),
    );
    expect(parseArgs(['--help'], {})).toEqual({ help: true });
    expect(() => parseArgs(['ipc', 'call'], {})).toThrow('Unsupported');
    expect(() => parseArgs(['-p'], {})).toThrow('needs a value');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('QS backend arguments preserve file URLs and backend separators', () => {
  const file = new URL('./fixtures/qml/hello.qml', import.meta.url);
  expect(backendArgs(['-p', decodeURIComponent(file.pathname), '--', '--', '--mobile'], {}))
    .toEqual({ args: [file.href, '--', '--mobile'] });
  expect(backendArgs(['--help'], {})).toEqual({ help: true });
  expect(() => backendArgs(['--unknown'], {})).toThrow('Unsupported');
});

test('standalone QS entries show help and reject invalid QS options without starting a backend', async () => {
  for (const backend of ['wayland', 'headless', 'casty']) {
    const entry = new URL('../lib/qml/qs' + backend, import.meta.url).pathname;
    for (const help of [true, false]) {
      const child = Bun.spawn([process.execPath, entry, help ? '--help' : '--unknown'], {
        stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(code).toBe(help ? 0 : 1);
      expect(help ? stdout : stderr).toContain(help ? 'qs' + backend : 'Unsupported Quickshell option');
    }
  }
});
