import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from '../lib/qml/launcher.js';
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
