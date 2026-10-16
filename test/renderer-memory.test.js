import { expect, test } from 'bun:test';

test('CanvasKit renderer lifetimes release native surfaces and failed video readbacks', async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/renderer-memory.js', import.meta.url).pathname],
    { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(stdout).toContain('renderer memory lifecycle passed');
}, 30_000);
