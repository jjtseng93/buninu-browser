import { expect, test } from 'bun:test';

test('equivalent CSS output retains the tree while real and pseudo changes invalidate', async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/style-output-invalidation.js', import.meta.url).pathname],
    { stdout: 'pipe', stderr: 'pipe' });
  const [code, out, error] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({code, error}).toEqual({code: 0, error: ''});
  expect(out).toContain('style output invalidation passed');
}, 20_000);
