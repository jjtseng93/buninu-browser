import {test, expect} from 'bun:test';

test('initial previews include ready images without waiting for linked stylesheets', async () => {
  const child = Bun.spawn([process.execPath, Bun.fileURLToPath(new URL('./fixtures/initial-preview.js', import.meta.url))], {
    stdout:'pipe', stderr:'pipe',
  });
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({code, error}).toEqual({code:0, error:''});
  expect(out).toContain('initial preview resources passed');
}, 20_000);
