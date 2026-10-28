import { expect, test } from 'bun:test';

test('paint-only geometry reads skip layout and match full-layout pixels', async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/layout-repaint.js', import.meta.url).pathname],
    { stdout: 'pipe', stderr: 'pipe' });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe('');
  expect(exit).toBe(0);
}, 15_000);
